import AppError from "../utils/app-error.js";
import { genToken } from "../helpers/gen-token.js";
import { comparePassword, hashPassword } from "../helpers/hash-password.js";
import User from "../models/user.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import { sendEmail } from "../utils/send-email.js";
import { generateOtp } from "../helpers/generate-otp.js";
import crypto from "node:crypto";
import { Op } from "sequelize";




export const signup = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    throw new AppError("All fields are required", 400);
  }

  const existingUser = await User.findOne({ where: { email } });

  if (existingUser) {
    throw new AppError("User already exists", 409);
  }

  const newUser = await User.create({
    name,
    email,
    password: await hashPassword(password),
  });

  const token = genToken(newUser.id);

res.cookie("access_token", token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
});

res.created({
  message: "Signup successful",
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
});


});


export const googleCallback =asyncHandler(async (req, res) => {
  const user = req.user;

  const token = genToken(user.id);

  res.cookie("access_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
res.redirect("/profile.html");
  // redirect back to frontend
  // res.redirect("http://localhost:5173/dashboard");
}) 

export const logout =asyncHandler(async (req, res) => {
  res.clearCookie("access_token", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });

  res.ok({ message: "Logged out successfully" });
}) 





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

  const hashedOtp = crypto
    .createHash("sha256")
    .update(otp)
    .digest("hex");

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