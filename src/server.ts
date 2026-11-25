
import express from "express";
import cors from "cors";
import session from "express-session";
import passport from "passport";
import { ExpressAdapter } from "@bull-board/express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";

import { emailQueue } from "./queue/email.queue";
import { env } from "./config/env";
import { prisma } from "./config/db";

import campaigns from "./routes/campaigns";
import emails from "./routes/emails";
import senders from "./routes/senders";
import slack from "./routes/slack";
import auth from "./routes/auth";

const app = express();

app.use(cors({
  origin: env.frontendUrl,
  credentials: true
}));

app.use(express.json({ limit: "2mb" }));

// Session middleware MUST run before Passport session middleware.
app.use(session({
  name: "reachinbox.sid",
  secret: process.env.SESSION_SECRET || "dev-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

app.get("/api/session-check", (req, res) => {
  res.json({
    sessionExists: !!req.session,
    regenerateExists: typeof req.session?.regenerate === "function",
    saveExists: typeof req.session?.save === "function",
    authenticated: req.isAuthenticated()
  });
});

passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id }
    });

    done(null, user || false);
  } catch (error) {
    done(error);
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", auth);
app.use("/api/campaigns", campaigns);
app.use("/api/emails", emails);
app.use("/api/senders", senders);
app.use("/api/slack", slack);

const serverAdapter = new ExpressAdapter();

serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter
});

app.use("/admin/queues", serverAdapter.getRouter());

app.use((error: any, _req: any, res: any, _next: any) => {
  console.error(error);

  res.status(error?.name === "ZodError" ? 400 : 500).json({
    message: error?.name === "ZodError"
      ? "Invalid request"
      : "Internal server error"
  });
});

app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
});
