
import { prisma } from "../config/db";
import { redis } from "../config/redis";
import { emailQueue } from "../queue/email.queue";

const CHECK_INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 2 * 60 * 1000;
const BATCH_SIZE = 100;

let recoveryRunning = false;

async function recoverStuckEmails() {
  if (recoveryRunning) return;

  recoveryRunning = true;

  try {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);

    const stuckEmails = await prisma.email.findMany({
      where: {
        status: "PROCESSING",
        updatedAt: { lt: cutoff }
      },
      select: {
        id: true,
        updatedAt: true
      },
      take: BATCH_SIZE,
      orderBy: { updatedAt: "asc" }
    });

    for (const email of stuckEmails) {
      const lockKey = `email:processing:${email.id}`;

      if (await redis.exists(lockKey)) continue;

      const stillStuck = await prisma.email.findFirst({
        where: {
          id: email.id,
          status: "PROCESSING",
          updatedAt: email.updatedAt
        },
        select: { id: true }
      });

      if (!stillStuck) continue;

      const recoveryJobId =
        `email-recovery-${email.id}-${email.updatedAt.getTime()}`;

      // Reuse the same ID while this email remains in the same
      // stuck state. An existing waiting/active job is not duplicated.
      const existingJob = await emailQueue.getJob(recoveryJobId);

      if (existingJob) {
        const state = await existingJob.getState();

        if (
  state === "waiting" ||
  state === "active" ||
  state === "delayed" ||
  state === "waiting-children" ||
  state === "prioritized"
) {
  continue;
}

        // Completed or failed recovery attempts can be retried
        // if the database record is still stuck.
        await existingJob.remove();
      }

      await emailQueue.add(
        "recover-email",
        { emailId: email.id },
        {
          jobId: recoveryJobId,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000
          },
          removeOnComplete: true,
          removeOnFail: true
        }
      );

      console.log(`Recovery job queued for email: ${email.id}`);
    }
  } catch (error) {
    console.error("Email recovery check failed:", error);
  } finally {
    recoveryRunning = false;
  }
}

export function startEmailRecovery() {
  console.log("Email recovery service started.");

  void recoverStuckEmails();

  setInterval(() => {
    void recoverStuckEmails();
  }, CHECK_INTERVAL_MS);
}
