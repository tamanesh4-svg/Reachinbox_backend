
import { Router } from "express";
import { prisma } from "../config/db";
import { elastic } from "../config/search";
import { env } from "../config/env";
import requireAuth from "../middleware/requireAuth";

const router = Router();

// Require an authenticated user for every email endpoint
router.use(requireAuth);

// Get the authenticated user's ID
const getOwnerId = (req: any): string => req.user.id;

// Scheduled emails
router.get("/scheduled", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);

    const rows = await prisma.email.findMany({
      where: {
        campaign: {
          userId: ownerId
        },
        status: {
          in: ["SCHEDULED", "PROCESSING"]
        }
      },
      orderBy: {
        scheduledAt: "asc"
      },
      take: 500
    });

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

// Sent and failed emails
router.get("/sent", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);

    const rows = await prisma.email.findMany({
      where: {
        campaign: {
          userId: ownerId
        },
        status: {
          in: ["SENT", "FAILED"]
        }
      },
      orderBy: {
        updatedAt: "desc"
      },
      take: 500
    });

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

// Search emails using Elasticsearch
router.get("/search", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.json([]);
    }

    const result = await elastic.search({
      index: env.elasticsearchIndex,
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query: q,
                fields: [
                  "recipient",
                  "subject",
                  "senderId",
                  "status"
                ]
              }
            }
          ],
          filter: [
            {
              term: {
                userId: ownerId
              }
            }
          ]
        }
      }
    });

    res.json(
      result.hits.hits.map((hit: any) => hit._source)
    );

  } catch (error) {
    next(error);
  }
});

export default router;
