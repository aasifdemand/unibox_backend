import { Router } from "express";
import { forgotPassword, login, resetPassword, signup } from "../controllers/auth.controller.js";


const router = Router();

router.post("/signup",signup)
router.post("/login",login)
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

export default router;