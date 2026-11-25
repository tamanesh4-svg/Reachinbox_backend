
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import requireAuth from "../middleware/requireAuth";
import { encrypt } from "../services/encryption";

const router = Router();

router.use(requireAuth);

const getOwnerId = (req: any): string => req.user.id;

// Get all senders belonging to the logged-in user.
router.get("/", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);

    const senders = await prisma.sender.findMany({
      where: { userId: ownerId },
      select: {
        id: true,
        email: true,
        createdAt: true
      }
    });

    res.json(senders);
  } catch (error) {
    next(error);
  }
});

// Add a new SMTP sender.
router.post("/", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);

    const input = z.object({
      email: z.string().email(),
      smtpUser: z.string().min(1),
      smtpPassword: z.string().min(1)
    }).parse(req.body);

    const sender = await prisma.sender.create({
      data: {
        email: input.email,
        smtpUser: input.smtpUser,
        smtpPassword: encrypt(input.smtpPassword),
        userId: ownerId
      },
      select: {
        id: true,
        email: true
      }
    });

    res.status(201).json(sender);
  } catch (error) {
    next(error);
  }
});

export default router;
