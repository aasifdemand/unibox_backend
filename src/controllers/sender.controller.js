import Sender from "../models/sender.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";
import { testSmtpConnection } from "../utils/smtp-tester.js";

export const createSender = asyncHandler(async (req, res) => {
  const {
    email,
    displayName,
    provider,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPassword,
  } = req.body;

  if (!email || !displayName || !provider) {
    throw new AppError("Missing required fields", 400);
  }

  /* =========================
     OUTLOOK GUARD
  ========================= */
  if (provider === "outlook") {
    throw new AppError(
      "Outlook sender must be connected using Microsoft OAuth",
      400
    );
  }

  /* =========================
     SMTP VALIDATION
  ========================= */
  if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword) {
    throw new AppError("Incomplete SMTP configuration", 400);
  }

  /* =========================
     REAL SMTP HANDSHAKE
  ========================= */
  try {
    await testSmtpConnection({
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUser,
      smtpPass: smtpPassword,
    });
  } catch (err) {
    throw new AppError(`SMTP connection failed: ${err.message}`, 400);
  }

  /* =========================
     CREATE SENDER
  ========================= */
  const sender = await Sender.create({
    userId: req.user.id,
    email,
    displayName,
    domain: email.split("@")[1],
    provider,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPass: smtpPassword,
  });

  res.status(201).json({
    success: true,
    data: sender,
  });
});

export const listSenders = asyncHandler(async (req, res) => {
  const senders = await Sender.findAll({
    where: { userId: req.user.id },
    order: [["createdAt", "DESC"]],
  });

  res.json({ success: true, data: senders });
});
