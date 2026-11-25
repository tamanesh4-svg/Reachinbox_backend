
import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../config/db";
import { env } from "../config/env";
import requireAuth from "../middleware/requireAuth";

const router = Router();

const OAUTH_STATE_KEY = "slackOAuthState";
const OAUTH_STATE_EXPIRY_KEY = "slackOAuthStateExpiry";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function encrypt(token: string): string {
  if (!env.encryptionKey || !/^[0-9a-fA-F]{64}$/.test(env.encryptionKey)) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex value.");
  }

  const iv = crypto.randomBytes(12);
  const key = Buffer.from(env.encryptionKey, "hex");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex")
  ].join(":");
}

function decrypt(ciphertext: string): string {
  if (!env.encryptionKey || !/^[0-9a-fA-F]{64}$/.test(env.encryptionKey)) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex value.");
  }

  const parts = ciphertext.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted Slack token format.");
  }

  const [ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(dataHex, "hex");

  if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) {
    throw new Error("Invalid encrypted Slack token data.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(env.encryptionKey, "hex"),
    iv
  );

  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]).toString("utf8");
}

// All Slack routes require Google authentication.
router.use(requireAuth);

// Start Slack OAuth.
router.get("/connect", (req, res, next) => {
  if (!env.slackClientId || !env.slackClientSecret || !env.slackRedirectUri) {
    return res.status(503).send("Slack OAuth is not configured.");
  }

  const state = crypto.randomBytes(32).toString("hex");

  (req.session as any)[OAUTH_STATE_KEY] = state;
  (req.session as any)[OAUTH_STATE_EXPIRY_KEY] =
    Date.now() + OAUTH_STATE_TTL_MS;

  req.session.save((error) => {
    if (error) return next(error);

    const params = new URLSearchParams({
      client_id: env.slackClientId,
      scope: process.env.SLACK_SCOPES || "chat:write,channels:read,groups:read",
      redirect_uri: env.slackRedirectUri,
      state
    });

    return res.redirect(
      `https://slack.com/oauth/v2/authorize?${params.toString()}`
    );
  });
});

// Slack OAuth callback.
router.get("/callback", async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.redirect(`${env.frontendUrl}/?slack=failed`);
    }

    const receivedState = String(req.query.state || "");
    const expectedState = (req.session as any)[OAUTH_STATE_KEY];
    const expiresAt = (req.session as any)[OAUTH_STATE_EXPIRY_KEY];

    delete (req.session as any)[OAUTH_STATE_KEY];
    delete (req.session as any)[OAUTH_STATE_EXPIRY_KEY];

    const stateIsValid =
      typeof expectedState === "string" &&
      expectedState.length === receivedState.length &&
      crypto.timingSafeEqual(
        Buffer.from(expectedState),
        Buffer.from(receivedState)
      ) &&
      typeof expiresAt === "number" &&
      Date.now() <= expiresAt;

    if (!stateIsValid) {
      return res.status(400).send("Invalid or expired Slack OAuth state.");
    }

    const code = String(req.query.code || "");

    if (!code) {
      return res.status(400).send("Slack authorization code is missing.");
    }

    const user = req.user as { id: string };

    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: env.slackClientId,
        client_secret: env.slackClientSecret,
        code,
        redirect_uri: env.slackRedirectUri
      })
    });

    const data = await response.json() as {
      ok: boolean;
      error?: string;
      access_token?: string;
      team?: {
        id?: string;
        name?: string;
      };
    };

    if (!response.ok || !data.ok || !data.access_token) {
      console.error("Slack OAuth exchange failed:", data.error);
      return res.status(400).send("Slack authorization failed.");
    }

    await prisma.slackConnection.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        encryptedAccessToken: encrypt(data.access_token),
        teamId: data.team?.id,
        teamName: data.team?.name
      },
      update: {
        encryptedAccessToken: encrypt(data.access_token),
        teamId: data.team?.id,
        teamName: data.team?.name
      }
    });

    return res.redirect(`${env.frontendUrl}/?slack=connected`);
  } catch (error) {
    next(error);
  }
});

// Check Slack connection status.
router.get("/status", async (req, res, next) => {
  try {
    const user = req.user as { id: string };

    const connection = await prisma.slackConnection.findUnique({
      where: { userId: user.id },
      select: {
        teamId: true,
        teamName: true,
        createdAt: true
      }
    });

    return res.json({
      connected: !!connection,
      teamName: connection?.teamName ?? null,
      connectedAt: connection?.createdAt ?? null
    });
  } catch (error) {
    next(error);
  }
});

// Send a test notification to the configured Slack channel.
router.post("/test", async (req, res, next) => {
  try {
    const user = req.user as { id: string };

    if (!env.slackChannelId) {
      return res.status(503).json({
        message: "SLACK_CHANNEL_ID is not configured."
      });
    }

    const connection = await prisma.slackConnection.findUnique({
      where: { userId: user.id }
    });

    if (!connection) {
      return res.status(400).json({
        message: "Connect your Slack workspace first."
      });
    }

    const token = decrypt(connection.encryptedAccessToken);

    const response = await fetch(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          channel: env.slackChannelId,
          text: "✅ ReachInbox Slack integration test successful! Your email scheduler can now send notifications to this channel."
        })
      }
    );

    const data = await response.json() as {
      ok?: boolean;
      error?: string;
      channel?: string;
      ts?: string;
    };

    if (!response.ok || !data.ok) {
      console.error("Slack test message failed:", data.error);

      return res.status(502).json({
        message: "Slack could not send the test message.",
        error: data.error || "Unknown Slack API error"
      });
    }

    return res.json({
      sent: true,
      channel: data.channel,
      message: "Test notification sent successfully."
    });
  } catch (error) {
    next(error);
  }
});

// Disconnect Slack.
router.delete("/disconnect", async (req, res, next) => {
  try {
    const user = req.user as { id: string };

    await prisma.slackConnection.deleteMany({
      where: { userId: user.id }
    });

    return res.json({ disconnected: true });
  } catch (error) {
    next(error);
  }
});

export default router;
