// config/passportgoogle-oauth.js
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import User from "../models/user.model.js";
import { Op } from "sequelize";

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL_USER,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails[0].value;
        const name = profile.displayName;
        const googleId = profile.id;

        // Check if user exists with this email AND has a googleId
        // This ensures we only find users who originally signed up with Google
        let user = await User.findOne({
          where: {
            email,
            googleId: { [Op.not]: null }, // Only users with googleId
          },
        });

        if (!user) {
          // Check if email exists but with password (local user)
          const existingLocalUser = await User.findOne({
            where: {
              email,
              password: { [Op.not]: "GOOGLE_AUTH" }, // Local user has real password
            },
          });

          if (existingLocalUser) {
            // This email is used by a local account - don't allow Google login
            return done(null, false, {
              message:
                "This email is registered with password. Please login with your password.",
            });
          }

          // Create new Google user
          user = await User.create({
            name,
            email,
            password: "GOOGLE_AUTH",
            role: "user",
            googleId,
            isVerified: true, // Google accounts are auto-verified
            lastLoginAt: new Date(),
          });
        } else {
          // Update existing Google user
          user.lastLoginAt = new Date();
          await user.save();
        }

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    },
  ),
);

export default passport;
