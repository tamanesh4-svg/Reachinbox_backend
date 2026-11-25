
import crypto from "crypto";
import { prisma } from "../config/db";
import { redis } from "../config/redis";
import { env } from "../config/env";

function decrypt(ciphertext: string): string {
  if (!env.encryptionKey || !/^[0-9a-fA-F]{64}$/.test(env.encryptionKey)) {
    throw new Error("ENCRYPTION_KEY must contain 64 hexadecimal characters.");
  }

  const parts = ciphertext.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted Slack token format.");
  }

  const [ivHex, tagHex, dataHex] = parts;

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const encryptedData = Buffer.from(dataHex, "hex");

  if (iv.length !== 12 || authTag.length !== 16 || encryptedData.length === 0) {
    throw new Error("Invalid encrypted Slack token data.");
  }

  const key = Buffer.from(env.encryptionKey, "hex");

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encryptedData),
    decipher.final()
  ]).toString("utf8");
}

export async function notifyRateLimit(
  userId: string,
  senderEmail: string,
  retryAt: number
): Promise<void> {
  const hourKey = new Date().toISOString().slice(0, 13);

  const dedupeKey =
    `slack-rate-notice:${userId}:${senderEmail}:${hourKey}`;

  let lockAcquired = false;

  try {
    // Slack notifications are optional.
    const connection = await prisma.slackConnection.findUnique({
      where: { userId }
    });

    if (!connection) {
      return;
    }

    if (!env.slackChannelId) {
      console.warn("Slack notification skipped: SLACK_CHANNEL_ID is missing.");
      return;
    }

    // Acquire a temporary deduplication lock.
    const first = await redis.set(
      dedupeKey,
      "pending",
      "EX",
      300,
      "NX"
    );

    if (!first) {
      return;
    }

    lockAcquired = true;

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
          text:
            `⚠️ *Email rate limit reached*\n` +
            `Sender: ${senderEmail}\n` +
            `New emails will be retried after: ${new Date(retryAt).toISOString()}`
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
      throw new Error(
        `Slack API error: ${data.error || response.statusText}`
      );
    }

    // Keep the successful notification deduplicated for two hours.
    await redis.set(
      dedupeKey,
      "sent",
      "EX",
      7200
    );

    console.log(
      `Slack rate-limit notification sent to channel ${env.slackChannelId}`
    );

  } catch (error) {
    console.error(
      "Slack notification failed:",
      error instanceof Error ? error.message : error
    );

    // Allow another notification attempt if this one failed.
    if (lockAcquired) {
      try {
        await redis.del(dedupeKey);
      } catch (redisError) {
        console.error("Could not release Slack notification lock:", redisError);
      }
    }

    // Never let an optional Slack notification crash email processing.
  }
}
