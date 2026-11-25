
import { prisma } from "../config/db";
import { elastic } from "../config/search";
import { env } from "../config/env";

const BATCH_SIZE = 500;

async function reindexEmails() {
  console.log("Starting Elasticsearch reindexing...");

  let lastId: string | undefined;
  let totalIndexed = 0;
  let totalFailed = 0;

  try {
    while (true) {
      const emails = await prisma.email.findMany({
        take: BATCH_SIZE,
        ...(lastId ? { skip: 1, cursor: { id: lastId } } : {}),
        orderBy: { id: "asc" },
        include: {
          campaign: {
            select: {
              userId: true
            }
          }
        }
      });

      if (emails.length === 0) break;

      const results = await Promise.allSettled(
        emails.map(email =>
          elastic.index({
            index: env.elasticsearchIndex,
            id: email.id,
            document: {
              id: email.id,
              userId: email.campaign.userId,
              recipient: email.recipient,
              subject: email.subject,
              status: email.status,
              senderId: email.senderId,
              scheduledAt: email.scheduledAt.toISOString(),
              sentAt: email.sentAt?.toISOString() ?? null,
              previewUrl: email.previewUrl ?? null
            }
          })
        )
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          totalIndexed++;
        } else {
          totalFailed++;
          console.error("Failed to index an email:", result.reason);
        }
      }

      lastId = emails[emails.length - 1].id;

      console.log(`Processed ${totalIndexed + totalFailed} emails...`);
    }

    await elastic.indices.refresh({
      index: env.elasticsearchIndex
    });

    console.log("\nReindexing completed!");
    console.log(`Successfully indexed: ${totalIndexed}`);
    console.log(`Failed: ${totalFailed}`);
  } finally {
    await prisma.$disconnect();
    await elastic.close();
  }

  if (totalFailed > 0) process.exitCode = 1;
}

reindexEmails().catch(error => {
  console.error("Reindexing failed:", error);
  process.exitCode = 1;
});
