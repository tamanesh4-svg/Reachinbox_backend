
import { Worker, Job } from "bullmq";
import { randomUUID } from "crypto";

import { redis } from "../config/redis";
import { prisma } from "../config/db";
import { env } from "../config/env";

import { EMAIL_QUEUE, emailQueue } from "../queue/email.queue";
import { reserveSendSlot } from "../services/rateLimiter";
import { sendWithEthereal } from "../services/mailer";
import { indexEmail } from "../config/search";
import { notifyRateLimit } from "../services/slack";
import { decrypt } from "../services/encryption";
import { startEmailRecovery } from "./emailRecovery";
import { startOutboxDispatcher } from "../services/outbox";


type Payload = {
  emailId: string;
};

const LOCK_TTL_MS = 60_000;
const LOCK_HEARTBEAT_MS = 20_000;

const RENEW_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

const worker = new Worker<Payload>(
  EMAIL_QUEUE,

  async (job: Job<Payload>) => {
    const email = await prisma.email.findUnique({
      where: {
        id: job.data.emailId
      },
      include: {
        sender: true,
        campaign: true
      }
    });

    if (
      !email ||
      email.status === "SENT" ||
      email.status === "FAILED"
    ) {
      return;
    }

    // Acquire a distributed lock for this email.
    const lockKey = `email:processing:${email.id}`;
    const lockToken = randomUUID();

    const lockAcquired = await redis.set(
      lockKey,
      lockToken,
      "PX",
      LOCK_TTL_MS,
      "NX"
    );

    if (!lockAcquired) {
      console.log(`Email already being processed: ${email.id}`);
      return;
    }

    // Renew the lock while processing.
    const heartbeat = setInterval(() => {
      void redis
        .eval(
          RENEW_LOCK_SCRIPT,
          1,
          lockKey,
          lockToken,
          String(LOCK_TTL_MS)
        )
        .then((result) => {
          if (Number(result) !== 1) {
            console.error(`Processing lock lost: ${email.id}`);
          }
        })
        .catch((error) => {
          console.error(
            `Lock renewal failed for ${email.id}:`,
            error
          );
        });
    }, LOCK_HEARTBEAT_MS);

    try {
      // Accept scheduled emails and recovered PROCESSING emails.
      const claimed = await prisma.email.updateMany({
        where: {
          id: email.id,
          status: {
            in: ["SCHEDULED", "PROCESSING"]
          }
        },
        data: {
          status: "PROCESSING"
        }
      });

      if (claimed.count === 0) {
        return;
      }

      // Reserve sender and campaign rate-limit capacity.
      let slot;

      try {
        slot = await reserveSendSlot(
          email.senderId,
          email.campaign.id,
          email.campaign.hourlyLimit
        );
      } catch (error) {
        await prisma.email.updateMany({
          where: {
            id: email.id,
            status: "PROCESSING"
          },
          data: {
            status: "SCHEDULED"
          }
        });

        throw error;
      }

      // Handle rate-limit delays.
      if (!slot.allowed) {
        await prisma.email.updateMany({
          where: {
            id: email.id,
            status: "PROCESSING"
          },
          data: {
            status: "SCHEDULED"
          }
        });

        await notifyRateLimit(
          email.campaign.userId,
          email.sender.email,
          slot.retryAt
        );

        const delay = Math.max(
          1000,
          slot.retryAt - Date.now()
        );

        await emailQueue.add(
          "send-email",
          job.data,
          {
            jobId: `email-${email.id}-retry-${Math.floor(
              slot.retryAt / 1000
            )}`,
            delay,
            attempts: 3,
            backoff: {
              type: "exponential",
              delay: 5000
            }
          }
        );

        console.log(`Email delayed by rate limiter: ${email.id}`);
        return;
      }

      // Decrypt SMTP credentials before sending.
      let smtpPassword: string;

      try {
        smtpPassword = decrypt(email.sender.smtpPassword);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "SMTP password decryption failed";

        await prisma.email.updateMany({
          where: {
            id: email.id,
            status: "PROCESSING"
          },
          data: {
            status: "FAILED",
            lastError: message
          }
        });

        throw error;
      }

      // Send the email.
      let result;

      try {
        result = await sendWithEthereal({
          from: email.sender.email,
          to: email.recipient,
          subject: email.subject,
          text: email.body,
          smtpUser: email.sender.smtpUser,
          smtpPassword
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown SMTP error";

        const attempts = Number(job.opts.attempts || 1);
        const isLastAttempt =
          job.attemptsMade + 1 >= attempts;

        await prisma.email.updateMany({
          where: {
            id: email.id,
            status: "PROCESSING"
          },
          data: isLastAttempt
            ? {
                status: "FAILED",
                lastError: message
              }
            : {
                status: "SCHEDULED",
                lastError: message
              }
        });

        throw error;
      }

      // SMTP succeeded. Save SENT before Elasticsearch indexing.
      const updated = await prisma.email.update({
        where: {
          id: email.id
        },
        data: {
          status: "SENT",
          sentAt: new Date(),
          providerMessageId: result.messageId,
          previewUrl: result.previewUrl
        }
      });

      console.log(`Email sent successfully: ${email.id}`);

      // Elasticsearch errors must not cause another SMTP send.
      try {
        await indexEmail({
          ...updated,
          userId: email.campaign.userId
        });

        console.log(`Email indexed successfully: ${email.id}`);
      } catch (error) {
        console.error(
          `Email sent but Elasticsearch indexing failed: ${email.id}`,
          error
        );
      }
    } finally {
      clearInterval(heartbeat);

      // Release only the lock owned by this worker.
      try {
        await redis.eval(
          RELEASE_LOCK_SCRIPT,
          1,
          lockKey,
          lockToken
        );
      } catch (error) {
        console.error(
          `Could not release lock for ${email.id}:`,
          error
        );
      }
    }
  },

  {
    connection: redis,
    concurrency: env.workerConcurrency,

    // BullMQ stalled-job recovery.
    lockDuration: LOCK_TTL_MS,
    stalledInterval: LOCK_TTL_MS,
    maxStalledCount: 2
  }
);

// Worker events.
worker.on("completed", (job) => {
  console.log(`Completed ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`Failed ${job?.id}`, error);
});

worker.on("stalled", (jobId) => {
  console.warn(`Stalled job detected: ${jobId}`);
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

console.log(
  `Email worker started; concurrency=${env.workerConcurrency}`
);

// Start database recovery.
startEmailRecovery();
startOutboxDispatcher();
