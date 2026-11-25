
import { Client } from "@elastic/elasticsearch";
import { env } from "./env";

export const elastic = new Client({
  node: env.elasticsearchUrl,
  ...(env.elasticsearchApiKey
    ? {
        auth: {
          apiKey: env.elasticsearchApiKey
        }
      }
    : {})
});

export interface EmailSearchDocument {
  id: string;
  userId: string;
  recipient: string;
  subject: string;
  status: string;
  senderId: string;
  scheduledAt: Date;
  sentAt?: Date | null;
  previewUrl?: string | null;
}

export async function indexEmail(email: EmailSearchDocument) {
  try {
    await elastic.index({
      index: env.elasticsearchIndex,
      id: email.id,
      document: {
        id: email.id,
        userId: email.userId,
        recipient: email.recipient,
        subject: email.subject,
        status: email.status,
        senderId: email.senderId,
        scheduledAt: email.scheduledAt.toISOString(),
        sentAt: email.sentAt?.toISOString() ?? null,
        previewUrl: email.previewUrl ?? null
      },
      refresh: "wait_for"
    });
  } catch (error) {
    console.error(
      "Elasticsearch indexing failed; reconcile/retry this record:",
      email.id,
      error
    );
  }
}
