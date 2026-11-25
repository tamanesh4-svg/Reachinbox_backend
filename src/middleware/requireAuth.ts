
import type { RequestHandler } from "express";

const requireAuth: RequestHandler = (req, res, next) => {
  const user = req.user as { id?: string } | undefined;

  if (!req.isAuthenticated?.() || !user?.id) {
    return res.status(401).json({
      message: "Please sign in with Google to continue."
    });
  }

  next();
};

export default requireAuth;
