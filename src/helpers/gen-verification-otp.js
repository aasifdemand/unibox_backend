import crypto from "node:crypto";

export const generateVerificationOtp = () => {
  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  // Hash OTP for storage
  const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

  return { otp, hashedOtp };
};

export const verifyOtp = (plainOtp, hashedOtp) => {
  const hash = crypto.createHash("sha256").update(plainOtp).digest("hex");
  return hash === hashedOtp;
};
