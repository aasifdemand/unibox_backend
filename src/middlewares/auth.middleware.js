import jwt from "jsonwebtoken";
import AppError from "../utils/app-error.js";
import User from "../models/user.model.js";

export const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return next(new AppError("Not authorized, token missing", 401));
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
  } catch (error) {
    return next(new AppError("Invalid or expired token", 401));
  }
};
