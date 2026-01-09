import jwt from "jsonwebtoken";
import AppError from "../utils/app-error.js";
import User from "../models/user.model.js";

export const protect = async (req, res, next) => {
  const token = req.cookies.access_token;

  if (!token) {
    return next(new AppError("Not authenticated", 401));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findByPk(decoded.id, {
      attributes: { exclude: ["password"] },
    });

    if (!user) {
      return next(new AppError("User no longer exists", 401));
    }

    req.user = user;
    next();
  } catch (err) {
    next(new AppError("Invalid or expired token", 401));
  }
};


export const protectOptional = async (req, res, next) => {
  const token = req.cookies?.access_token;

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id);
    req.user = user || null;
  } catch {
    req.user = null;
  }

  next();
};
