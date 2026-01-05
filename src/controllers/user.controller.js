import { asyncHandler } from "../helpers/async-handler.js"
import AppError from "../utils/app-error.js";
import User from "../models/user.model.js";

export const getProfile = asyncHandler(async (req, res) => {
  res.ok({
    data: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
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