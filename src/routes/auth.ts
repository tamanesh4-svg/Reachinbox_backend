
import { Router } from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { prisma } from "../config/db";
import { env } from "../config/env";

const router = Router();

if (env.googleClientId && env.googleClientSecret && env.googleCallbackUrl) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: env.googleClientId,
        clientSecret: env.googleClientSecret,
        callbackURL: env.googleCallbackUrl
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;

          if (!email) {
            return done(new Error("Google account did not provide an email"));
          }

          const user = await prisma.user.upsert({
            where: { email },
            create: {
              googleId: profile.id,
              email,
              name: profile.displayName || email,
              avatar: profile.photos?.[0]?.value
            },
            update: {
              googleId: profile.id,
              name: profile.displayName || email,
              avatar: profile.photos?.[0]?.value
            }
          });

          return done(null, user as any);
        } catch (error) {
          return done(error as Error);
        }
      }
    )
  );
}

// Google login
router.get("/google", (req, res, next) => {
  if (!env.googleClientId || !env.googleClientSecret) {
    return res.status(503).send("Google OAuth is not configured.");
  }

  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: true
  })(req, res, next);
});

// Google OAuth callback
router.get(
  "/google/callback",
  (req, _res, next) => {
    console.log("GOOGLE CALLBACK SESSION:", {
      sessionExists: !!req.session,
      regenerateExists: typeof req.session?.regenerate
    });

    next();
  },
  passport.authenticate("google", {
    failureRedirect: `${env.frontendUrl}/?login=failed`,
    session: true
  }),
  (_req, res) => {
    res.redirect(`${env.frontendUrl}/`);
  }
);

// Current logged-in user
router.get("/me", (req, res) => {
  res.json({
    user: req.user || null
  });
});

// Logout
router.post("/logout", (req: any, res, next) => {
  req.logout((logoutError: Error | null) => {
    if (logoutError) {
      return next(logoutError);
    }

    if (!req.session) {
      res.clearCookie("reachinbox.sid");
      return res.json({ loggedOut: true });
    }

    req.session.destroy((sessionError: Error | null) => {
      if (sessionError) {
        return next(sessionError);
      }

      res.clearCookie("reachinbox.sid", {
        httpOnly: true,
        sameSite: "lax",
        secure: false
      });

      return res.json({ loggedOut: true });
    });
  });
});

export default router;
