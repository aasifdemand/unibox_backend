import nodemailer from "nodemailer";

let transporter;

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
  return transporter;
};

export const sendEmail = async ({ to, subject, html }) => {
  const mailTransporter = getTransporter();

  await mailTransporter.sendMail({
    from: `"Unibox" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });
};
