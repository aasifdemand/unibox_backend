import passport from "passport";
import { Strategy as MicrosoftStrategy } from "passport-microsoft";

passport.use(
  new MicrosoftStrategy(
    {
      clientID: process.env.MS_CLIENT_ID,
      clientSecret: process.env.MS_CLIENT_SECRET,
      callbackURL: process.env.MS_REDIRECT_URI,
      tenant: process.env.MS_TENANT_ID || "common",
      passReqToCallback: true,
      authorizationURL:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenURL:
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scope: [
        "openid",
        "profile",
        "offline_access",
        "User.Read",
        "Mail.Send",
        "Mail.Read",
      ],
    },
    (req, accessToken, refreshToken, params, profile, done) => {
      profile._accessToken = accessToken;
      profile._refreshToken = refreshToken;
      profile._expiresIn = params.expires_in;
      return done(null, profile);
    }
  )
);
