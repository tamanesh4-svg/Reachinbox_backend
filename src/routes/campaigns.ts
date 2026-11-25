
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "../config/db";
import requireAuth from "../middleware/requireAuth";

const router = Router();

router.use(requireAuth);

const campaignSchema = z.object({
  subject: z.string().min(1).max(250),
  body: z.string().min(1),
  recipients: z.array(z.string().email()).min(1).max(10000),
  startTime: z.string().datetime(),
  delayBetweenEmails: z.number().int().min(0).max(3600000),
  hourlyLimit: z.number().int().min(1).max(10000),
  senderId: z.string()
});

router.post("/", async (req, res, next) => {
  try {
    const input = campaignSchema.parse(req.body);
    const ownerId = (req.user as { id: string }).id;

    const sender = await prisma.sender.findFirst({
      where: {
        id: input.senderId,
        userId: ownerId
      }
    });

    if (!sender) {
      return res.status(400).json({
        message: "Sender not found for this user."
      });
    }

    const start = new Date(input.startTime);

    // Campaign, emails, and outbox event are committed together.
    const result = await prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          userId: ownerId,
          subject: input.subject,
          body: input.body,
          startTime: start,
          delayMs: input.delayBetweenEmails,
          hourlyLimit: input.hourlyLimit,
          emails: {
            create: input.recipients.map((recipient, index) => ({
              senderId: sender.id,
              recipient,
              subject: input.subject,
              body: input.body,
              scheduledAt: new Date(
                start.getTime() +
                index * input.delayBetweenEmails
              )
            }))
          }
        },
        include: {
          emails: {
            select: {
              id: true
            }
          }
        }
      });

      await tx.outboxEvent.create({
        data: {
          eventType: "CAMPAIGN_CREATED",
          payload: {
            emailIds: campaign.emails.map((email) => email.id)
          } as Prisma.InputJsonValue
        }
      });

      return {
        campaignId: campaign.id,
        total: campaign.emails.length
      };
    });

    return res.status(201).json({
      ...result,
      message: "Campaign created. Emails are being queued."
    });
  } catch (error) {
    next(error);
  }
});

export default router;
