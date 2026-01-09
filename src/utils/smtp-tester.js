import nodemailer from "nodemailer";

export const testSmtpConnection = async ({
  smtpHost,
  smtpPort,
  smtpSecure,
  smtpUser,
  smtpPass,
}) => {
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  // This performs real SMTP handshake (EHLO + AUTH)
  await transporter.verify();
};
