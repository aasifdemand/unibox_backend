import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";
import User from "../models/user.model.js";
import { comparePassword, hashPassword } from "../helpers/hash-password.js";

export const getProfile = asyncHandler(async (req, res) => {
  res.ok({
    data: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      isVerified: req.user.isVerified,
      googleId: req.user.googleId,
    },
  });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const { name, email } = req.body;

  if (!name && !email) {
    throw new AppError("At least one field is required to update", 400);
  }

  const user = await User.findByPk(req.user.id);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  if (email && email !== user.email) {
    const emailExists = await User.findOne({ where: { email } });
    if (emailExists) {
      throw new AppError("Email already in use", 409);
    }
  }

  if (name) user.name = name;
  if (email) user.email = email;

  await user.save();

  res.ok({
    message: "Profile updated successfully",
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
  });
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    throw new AppError("Current password and new password are required", 400);
  }
  const userId = req.user.id;
  const user = await User.findByPk(userId);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  const isMatch = await comparePassword(currentPassword, user.password);

  if (!isMatch) {
    throw new AppError("Current password is incorrect", 400);
  }

  const hashedPass = await hashPassword(newPassword);

  user.password = hashedPass;
  await user.save();

  res.ok({
    message: "Password changed successfully",
  });
});
