import Imap from "imap";

/**
 * Tests IMAP connectivity by opening and closing the inbox
 */
export const testImapConnection = ({
  imapHost,
  imapPort,
  imapSecure,
  imapUser,
  imapPass,
}) =>
  new Promise((resolve, reject) => {
    const imap = new Imap({
      user: imapUser,
      password: imapPass,
      host: imapHost,
      port: imapPort,
      tls: imapSecure,
      tlsOptions: { rejectUnauthorized: false },
    });

    imap.once("ready", () => {
      imap.openBox("INBOX", true, (err) => {
        imap.end();
        if (err) return reject(err);
        resolve(true);
      });
    });

    imap.once("error", (err) => {
      reject(err);
    });

    imap.connect();
  });
