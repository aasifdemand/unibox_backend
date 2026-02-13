// utils/rate-limiter.js
import pLimit from "p-limit";

// Store limiters per mailbox
const mailboxLimiters = new Map();

// Default concurrency limits
const CONCURRENCY_LIMITS = {
  gmail: 10, // Gmail allows higher concurrency
  outlook: 4, // Outlook is stricter
  smtp: 5, // SMTP custom limit
};

/**
 * Get or create a rate limiter for a specific mailbox
 */
export const getMailboxLimiter = (mailboxId, type = "outlook") => {
  const key = `${type}:${mailboxId}`;

  if (!mailboxLimiters.has(key)) {
    const limit = CONCURRENCY_LIMITS[type] || 5;
    mailboxLimiters.set(key, pLimit(limit));

    // Clean up after 1 hour of inactivity
    setTimeout(
      () => {
        mailboxLimiters.delete(key);
      },
      60 * 60 * 1000,
    );
  }

  return mailboxLimiters.get(key);
};

/**
 * Clear limiter for a mailbox (useful on disconnect)
 */
export const clearMailboxLimiter = (mailboxId, type) => {
  const key = `${type}:${mailboxId}`;
  mailboxLimiters.delete(key);
};

/**
 * Execute a function with rate limiting
 */
export const withRateLimit = async (mailboxId, type, fn) => {
  const limiter = getMailboxLimiter(mailboxId, type);
  return limiter(fn);
};
