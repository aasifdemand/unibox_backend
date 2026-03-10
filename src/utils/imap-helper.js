import Imap from "imap";
import util from "util";
import AppError from "./app-error.js";

/**
 * Creates and connects a new IMAP client
 * @param {Object} sender - The sender model instance
 * @returns {Promise<Imap>} - A connected IMAP instance
 */
export function createImapConnection(sender) {
    const imap = new Imap({
        user: sender.email,
        password: sender.imapPassword,
        host: sender.imapHost,
        port: sender.imapPort,
        tls: sender.imapSecure,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 15000,
        connTimeout: 15000,
    });

    return new Promise((resolve, reject) => {
        imap.once("ready", () => resolve(imap));
        imap.once("error", (err) => {
            const isAuthError =
                err.message.toLowerCase().includes("authentication failed") ||
                err.message.toLowerCase().includes("invalid credentials");
            reject(
                new AppError(
                    `IMAP connection failed: ${err.message}`,
                    isAuthError ? 401 : 500,
                ),
            );
        });
        imap.connect();
    });
}

/**
 * Recursively flattens IMAP box tree into path strings
 * @param {Object} boxes
 * @param {string} prefix
 * @returns {string[]}
 */
export function flattenBoxes(boxes, prefix = "") {
    const result = [];
    for (const [name, box] of Object.entries(boxes || {})) {
        const fullPath = prefix ? `${prefix}${box.delimiter || "/"}${name}` : name;
        result.push(fullPath);
        if (box.children) {
            result.push(...flattenBoxes(box.children, fullPath));
        }
    }
    return result;
}

/**
 * Resolves a friendly folder name (e.g. "SENT") to the actual provider folder name
 * @param {Imap} imap
 * @param {Object} sender
 * @param {string} friendlyName
 * @returns {Promise<string>}
 */
export async function resolveFolder(imap, sender, friendlyName) {
    const upper = friendlyName.toUpperCase();

    // --- Provider detection ------------------------------------------------
    const host = (sender.imapHost || "").toLowerCase();
    const isGmail = host.includes("gmail") || host.includes("googlemail");
    const isOutlook =
        host.includes("outlook") ||
        host.includes("hotmail") ||
        host.includes("live.com") ||
        host.includes("office365");

    // --- Static mappings -------------------------------------------------------
    const GMAIL_MAP = {
        INBOX: "INBOX",
        SENT: "[Gmail]/Sent Mail",
        DRAFTS: "[Gmail]/Drafts",
        TRASH: "[Gmail]/Trash",
        SPAM: "[Gmail]/Spam",
        ARCHIVE: "[Gmail]/All Mail",
        STARRED: "[Gmail]/Starred",
        IMPORTANT: "[Gmail]/Important",
    };

    const OUTLOOK_MAP = {
        INBOX: "INBOX",
        SENT: "Sent Items",
        DRAFTS: "Drafts",
        TRASH: "Deleted Items",
        SPAM: "Junk Email",
        ARCHIVE: "Archive",
    };

    // Return a known mapping immediately if available
    if (isGmail && GMAIL_MAP[upper]) return GMAIL_MAP[upper];
    if (isOutlook && OUTLOOK_MAP[upper]) return OUTLOOK_MAP[upper];

    // If not a special folder or unknown provider, try the name directly first
    // but fall back to a fuzzy search against the real folder list
    const candidateNames = [friendlyName];
    if (upper === "SENT")
        candidateNames.push("Sent Items", "Sent", "[Gmail]/Sent Mail");
    if (upper === "DRAFTS") candidateNames.push("Drafts", "[Gmail]/Drafts");
    if (upper === "TRASH")
        candidateNames.push("Deleted Items", "Trash", "[Gmail]/Trash", "Bin");
    if (upper === "SPAM")
        candidateNames.push("Junk Email", "Junk", "[Gmail]/Spam");
    if (upper === "ARCHIVE") candidateNames.push("[Gmail]/All Mail", "Archive");

    // Flatten the live box list and match against our candidates
    try {
        const boxes = await util.promisify(imap.getBoxes).bind(imap)();
        const flatBoxes = flattenBoxes(boxes);
        for (const candidate of candidateNames) {
            const match = flatBoxes.find(
                (b) =>
                    b.toLowerCase() === candidate.toLowerCase() ||
                    b.toLowerCase().endsWith("/" + candidate.toLowerCase()),
            );
            if (match) return match;
        }
    } catch (error) {
        console.error("Folder resolution warning:", error.message);
        // Ignore — fall through to the raw name
    }

    // Last resort: return whatever was requested
    return friendlyName;
}

/**
 * Appends a message to a specific folder
 * @param {Imap} imap
 * @param {string} folder
 * @param {Buffer|string} message
 * @returns {Promise<void>}
 */
export function appendToFolder(imap, folder, message) {
    return new Promise((resolve, reject) => {
        // node-imap append method: append(data, [options], [callback])
        imap.append(message, { mailbox: folder }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}
