
import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import { redis } from "./src/config/redis";

const prisma = new PrismaClient();

const emailQueue = new Queue("email-queue", {
  connection: redis,
});

async function clearScheduledEmails() {
  try {
    console.log("Finding scheduled and processing emails...");

    const pendingEmails = await prisma.email.findMany({
      where: {
        status: {
          in: ["SCHEDULED", "PROCESSING"],
        },
      },
      select: { id: true },
    });

    const emailIds = new Set(pendingEmails.map((e) => e.id));

    console.log(`Found ${emailIds.size} emails to remove.`);

    // Find all jobs that could send or recover these emails.
    const jobs = await emailQueue.getJobs(
      [
        "waiting",
        "delayed",
        "paused",
        "waiting-children",
        "prioritized",
        "active",
      ],
      0,
      -1,
      true
    );

    let removedJobs = 0;

    for (const job of jobs) {
      const emailId = job.data?.emailId;
      const jobId = String(job.id);

      const belongsToPendingEmail =
        emailIds.has(emailId) ||
        [...emailIds].some(
          (id) =>
            jobId === `email-${id}` ||
            jobId.startsWith(`email-recovery-${id}-`)
        );

      if (belongsToPendingEmail) {
        await job.remove();
        removedJobs++;
      }
    }

    // Delete pending Outbox events so they cannot enqueue these emails again.
    const deletedEvents = await prisma.outboxEvent.deleteMany({
      where: {
        eventType: "CAMPAIGN_CREATED",
        processedAt: null,
      },
    });

    // Delete only scheduled/processing email records.
    const deletedEmails = await prisma.email.deleteMany({
      where: {
        id: { in: [...emailIds] },
      },
    });

    console.log("\nCleanup completed successfully!");
    console.log(`Emails deleted: ${deletedEmails.count}`);
    console.log(`Queue jobs removed: ${removedJobs}`);
    console.log(`Pending Outbox events removed: ${deletedEvents.count}`);

    const remaining = await prisma.email.groupBy({
      by: ["status"],
      _count: { id: true },
    });

    console.log("\nRemaining email records:");
    console.table(
      remaining.map((item) => ({
        status: item.status,
        count: item._count.id,
      }))
    );
  } catch (error) {
    console.error("Cleanup failed:", error);
  } finally {
    await emailQueue.close();
    await prisma.$disconnect();
  }
}

clearScheduledEmails();
