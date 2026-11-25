
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../config/db";
import { redis } from "../config/redis";
import { emailQueue } from "../queue/email.queue";

const POLL_INTERVAL_MS = 5000;
const LOCK_TTL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 20;

const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

let dispatcherRunning = false;

type OutboxPayload = {
  emailIds: string[];
};

function parsePayload(payload: Prisma.JsonValue): OutboxPayload {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("emailIds" in payload) ||
    !Array.isArray(payload.emailIds) ||
    !payload.emailIds.every((id) => typeof id === "string")
  ) {
    throw new Error("Invalid email outbox event payload.");
  }

  return {
    emailIds: payload.emailIds
  };
}

async function dispatchOutboxEvents(): Promise<void> {
  if (dispatcherRunning) return;

  dispatcherRunning = true;

  try {
    const events = await prisma.outboxEvent.findMany({
      where: {
        processedAt: null,
        eventType: "CAMPAIGN_CREATED"
      },
      orderBy: {
        createdAt: "asc"
      },
      take: BATCH_SIZE
    });

    for (const event of events) {
      const lockKey = `outbox:dispatch:${event.id}`;
      const lockToken = randomUUID();

      const acquired = await redis.set(
        lockKey,
        lockToken,
        "PX",
        LOCK_TTL_MS,
        "NX"
      );

      if (!acquired) continue;

      try {
        // Another dispatcher may have processed the event already.
        const currentEvent = await prisma.outboxEvent.findFirst({
          where: {
            id: event.id,
            processedAt: null
          }
        });

        if (!currentEvent) continue;

        const payload = parsePayload(currentEvent.payload);

        if (payload.emailIds.length === 0) {
          await prisma.outboxEvent.updateMany({
            where: {
              id: event.id,
              processedAt: null
            },
            data: {
              processedAt: new Date()
            }
          });

          continue;
        }

        const emails = await prisma.email.findMany({
          where: {
            id: {
              in: payload.emailIds
            }
          },
          select: {
            id: true,
            scheduledAt: true
          }
        });

        const foundIds = new Set(emails.map((email) => email.id));

        if (foundIds.size !== payload.emailIds.length) {
          throw new Error(
            `Outbox event ${event.id} references missing emails.`
          );
        }

        await emailQueue.addBulk(
          emails.map((email) => ({
            name: "send-email",
            data: {
              emailId: email.id
            },
            opts: {
              // Deterministic ID prevents duplicate queue jobs
              // if the dispatcher crashes before marking the event.
              jobId: `email-${email.id}`,
              delay: Math.max(
                0,
                email.scheduledAt.getTime() - Date.now()
              ),
              attempts: 3,
              backoff: {
                type: "exponential" as const,
                delay: 5000
              }
            }
          }))
        );

        await prisma.outboxEvent.updateMany({
          where: {
            id: event.id,
            processedAt: null
          },
          data: {
            processedAt: new Date()
          }
        });

        console.log(
          `Outbox event dispatched: ${event.id}, emails=${emails.length}`
        );
      } catch (error) {
        // Leave the event unprocessed. The next polling cycle retries it.
        console.error(
          `Outbox dispatch failed for ${event.id}:`,
          error
        );
      } finally {
        await redis
          .eval(
            RELEASE_LOCK_SCRIPT,
            1,
            lockKey,
            lockToken
          )
          .catch((error) => {
            console.error(
              `Could not release outbox lock ${event.id}:`,
              error
            );
          });
      }
    }
  } catch (error) {
    console.error("Outbox dispatcher failed:", error);
  } finally {
    dispatcherRunning = false;
  }
}

export function startOutboxDispatcher(): void {
  console.log("Transactional outbox dispatcher started.");

  void dispatchOutboxEvents();

  setInterval(() => {
    void dispatchOutboxEvents();
  }, POLL_INTERVAL_MS);
}
