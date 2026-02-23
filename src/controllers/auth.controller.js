import AppError from "../utils/app-error.js";
import { genToken } from "../helpers/gen-token.js";
import { comparePassword, hashPassword } from "../helpers/hash-password.js";
import User from "../models/user.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import { sendEmail } from "../utils/send-email.js";
import { generateOtp } from "../helpers/generate-otp.js";
import crypto from "node:crypto";
import { Op } from "sequelize";
import { generateVerificationOtp } from "../helpers/gen-verification-otp.js";

export const signup = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    throw new AppError("All fields are required", 400);
  }

  const existingUser = await User.findOne({ where: { email } });

  if (existingUser) {
    throw new AppError("User already exists", 409);
  }

  // Generate verification OTP
  const { otp, hashedOtp } = generateVerificationOtp();

  const newUser = await User.create({
    name,
    email,
    password: await hashPassword(password),
    verificationOtp: hashedOtp,
    verificationOtpExpires: Date.now() + 10 * 60 * 1000, // 10 minutes
    isVerified: false,
  });

  // Send verification email
  await sendEmail({
    to: newUser.email,
    subject: "Verify Your Email - Unibox",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Welcome to Unibox!</h2>
        <p>Hi ${name},</p>
        <p>Thanks for signing up! Please verify your email address using the OTP below:</p>
        
        <div style="background-color: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
          <h1 style="font-size: 36px; letter-spacing: 5px; color: #2563eb; margin: 0;">${otp}</h1>
        </div>
        
        <p>This OTP is valid for 10 minutes.</p>
        <p>If you didn't create an account, you can ignore this email.</p>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
        
        <p style="color: #6b7280; font-size: 12px;">
          © ${new Date().getFullYear()} Unibox. All rights reserved.
        </p>
      </div>
    `,
  });

  // Don't send token yet - require verification first
  res.created({
    message: "Signup successful. Please verify your email.",
    data: {
      email: newUser.email,
      requiresVerification: true,
    },
  });
});

export const verifyAccount = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    throw new AppError("Email and OTP are required", 400);
  }

  // Hash the provided OTP for comparison
  const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

  // Find user with matching email and valid OTP
  const user = await User.findOne({
    where: {
      email,
      verificationOtp: hashedOtp,
      verificationOtpExpires: { [Op.gt]: Date.now() },
      isVerified: false,
    },
  });

  if (!user) {
    throw new AppError("Invalid or expired OTP", 400);
  }

  // Mark user as verified and clear OTP fields
  user.isVerified = true;
  user.verificationOtp = null;
  user.verificationOtpExpires = null;
  await user.save();

  // Generate token and log user in
  const token = genToken(user.id);

  res.cookie("access_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  res.ok({
    message: "Email verified successfully",
    data: {
      isVerified: true,
    },
  });
});

export const resendVerification = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new AppError("Email is required", 400);
  }

  const user = await User.findOne({
    where: {
      email,
      isVerified: false,
    },
  });

  if (!user) {
    throw new AppError("User not found or already verified", 404);
  }

  // Generate new OTP
  const { otp, hashedOtp } = generateVerificationOtp();

  // Update user with new OTP
  user.verificationOtp = hashedOtp;
  user.verificationOtpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
  await user.save();

  // Send verification email
  await sendEmail({
    to: user.email,
    subject: "New Verification OTP - Unibox",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Verify Your Email</h2>
        <p>Hi ${user.name},</p>
        <p>Here's your new verification OTP:</p>
        
        <div style="background-color: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
          <h1 style="font-size: 36px; letter-spacing: 5px; color: #2563eb; margin: 0;">${otp}</h1>
        </div>
        
        <p>This OTP is valid for 10 minutes.</p>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
        
        <p style="color: #6b7280; font-size: 12px;">
          © ${new Date().getFullYear()} Unibox. All rights reserved.
        </p>
      </div>
    `,
  });

  res.ok({
    message: "Verification OTP resent successfully",
  });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new AppError("All fields are required", 400);
  }

  const user = await User.findOne({ where: { email } });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  // Check if this is a Google account trying to login with password
  if (user.googleId && user.password === "GOOGLE_AUTH") {
    throw new AppError(
      "This account uses Google login. Please login with Google.",
      400,
    );
  }

  // Check if email is verified (for credential auth)
  if (!user.isVerified) {
    throw new AppError("Please verify your email first", 403);
  }

  const isMatch = await comparePassword(password, user.password);

  if (!isMatch) {
    throw new AppError("Invalid credentials", 401);
  }

  const token = genToken(user.id);

  res.cookie("access_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.ok({
    message: "Login successful",
    data: {
      isVerified: user.isVerified,
    },
  });
});

export const googleCallback = asyncHandler(async (req, res) => {
  // Check if authentication failed
  if (!req.user) {
    const errorMessage = req.authInfo?.message || "google_auth_failed";
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/login?error=${encodeURIComponent(errorMessage)}`,
    );
  }

  const user = req.user;
  const token = genToken(user.id);

  res.cookie("access_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.redirect(`${process.env.FRONTEND_URL}/dashboard`);
});

export const microsoftCallback = asyncHandler(async (req, res) => {
  const user = req.user;
  const token = genToken(user.id);

  res.cookie("access_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.redirect(`${process.env.FRONTEND_URL}/dashboard`);
});

export const logout = asyncHandler(async (req, res) => {
  if (req.session && typeof req.logout === "function") {
    await new Promise((resolve, reject) => {
      req.logout((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  if (req.session) {
    req.session.destroy(() => {});
  }

  res.clearCookie("access_token", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });

  res.clearCookie("connect.sid");

  res.ok({ message: "Logged out successfully" });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new AppError("Email is required", 400);
  }

  const user = await User.findOne({ where: { email } });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  const { otp, hashedOtp } = generateOtp();

  user.resetOtp = hashedOtp;
  user.resetOtpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
  await user.save();

  await sendEmail({
    to: user.email,
    subject: "Password Reset OTP",
    html: `
      <h2>Password Reset</h2>
      <p>Your OTP is:</p>
      <h1>${otp}</h1>
      <p>This OTP is valid for 10 minutes.</p>
    `,
  });

  res.ok({
    message: "OTP sent to email",
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    throw new AppError("All fields are required", 400);
  }

  const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

  const user = await User.findOne({
    where: {
      email,
      resetOtp: hashedOtp,
      resetOtpExpires: { [Op.gt]: Date.now() },
    },
  });

  if (!user) {
    throw new AppError("Invalid or expired OTP", 400);
  }

  user.password = await hashPassword(newPassword);
  user.resetOtp = null;
  user.resetOtpExpires = null;

  await user.save();

  res.ok({
    message: "Password reset successful",
  });
});
