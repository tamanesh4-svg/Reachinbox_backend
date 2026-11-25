
import { prisma } from "./src/config/db";
import { emailQueue } from "./src/queue/email.queue";

const emailId = "cmwulnsw400042nxc5zlfvmwk";

async function main() {
  const email = await prisma.email.findUnique({
    where: { id: emailId }
  });

  if (!email || email.status !== "SCHEDULED") {
    throw new Error("Test email not found or is not SCHEDULED.");
  }

  // Remove only the original waiting job.
  const originalJobId = `email-${emailId}`;
  const originalJob = await emailQueue.getJob(originalJobId);

  if (originalJob) {
    const state = await originalJob.getState();

    if (state !== "waiting" && state !== "delayed") {
      throw new Error(
        `Original job is ${state}. Aborting test for safety.`
      );
    }

    await originalJob.remove();
    console.log("Original waiting job removed.");
  } else {
    console.log("Original queue job was already absent.");
  }

  // Simulate an abandoned PROCESSING record.
  const staleTime = new Date(Date.now() - 3 * 60 * 1000);

  await prisma.email.update({
    where: { id: emailId },
    data: {
      status: "PROCESSING",
      updatedAt: staleTime
    }
  });

  console.log("Test email marked as stale PROCESSING.");
  console.log("Recovery simulation is ready.");
}

main()
  .catch(console.error)
  .finally(async () => {
    await emailQueue.close();
    await prisma.$disconnect();
  });
