import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";

passport.use(
  "google-sender",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.GOOGLE_CALLBACK_URL_SENDER}`,
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, params, profile, done) => {
      try {
        // IMPORTANT: Google might return refreshToken in params
        const actualRefreshToken = refreshToken || params.refresh_token;

        // Extract user ID from state
        const state = req.query.state || "";
        const userId = state.replace("sender-", "");

        return done(null, {
          userId,
          email: profile.emails[0].value,
          displayName: profile.displayName,
          accessToken,
          refreshToken: actualRefreshToken, // ← Make sure this is saved
          googleId: profile.id,
          profile: profile._json,
        });
      } catch (err) {
        return done(err);
      }
    },
  ),
);

export default passport;
