import { Queue } from "bullmq";
import { redis } from "../config/redis";

export const EMAIL_QUEUE = "email-queue";
export const emailQueue = new Queue(EMAIL_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 10000 },
    removeOnFail: { age: 30 * 24 * 3600 }
  }
});
