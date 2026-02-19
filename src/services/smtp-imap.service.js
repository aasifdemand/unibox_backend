import nodemailer from "nodemailer";
import Imap from "imap";

export const verifySmtp = async ({ host, port, secure, user, password }) => {
  try {
    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(port),
      secure,
      auth: { user, pass: password },
      tls: { rejectUnauthorized: false },
    });

    await transporter.verify();

    return { success: true };
  } catch (err) {
    throw new Error(err.message);
  }
};

export const verifyImap = async ({ host, port, secure, user, password }) => {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user,
      password,
      host,
      port: parseInt(port),
      tls: secure,
      tlsOptions: { rejectUnauthorized: false },
    });

    imap.once("ready", () => {
      imap.end();
      resolve({ success: true });
    });

    imap.once("error", (err) => {
      reject(err); // MUST reject
    });

    imap.connect();
  });
};
