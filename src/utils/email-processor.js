// utils/email.utils.js
export const normalizeEmail = (email) => {
  if (!email || typeof email !== 'string') return null;
  
  const trimmed = email.trim().toLowerCase();
  
  // Extract domain
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  
  const [localPart, domain] = parts;
  
  // Check if domain is valid
  if (!domain || domain.length < 1 || domain.includes(' ') || !domain.includes('.')) {
    return null;
  }
  
  // Microsoft/Outlook specific normalization
  if (domain === "outlook.com" || domain === "hotmail.com" || 
      domain === "live.com" || domain === "msn.com" || domain.endsWith(".outlook.com")) {
    // Outlook doesn't ignore dots or plus addresses
    // But we can still handle some basic normalization
    return trimmed; // Outlook treats dots as significant, so keep as-is
  }
  
  // Gmail specific normalization
  if (domain === "gmail.com" || domain === "googlemail.com") {
    // Remove dots for Gmail
    let normalizedLocal = localPart.replace(/\./g, "");
    // Remove everything after +
    const plusIndex = normalizedLocal.indexOf("+");
    if (plusIndex > -1) {
      normalizedLocal = normalizedLocal.substring(0, plusIndex);
    }
    return `${normalizedLocal}@${domain}`;
  }
  
  // Yahoo specific normalization
  if (domain === "yahoo.com" || domain === "ymail.com" || domain === "rocketmail.com") {
    // Yahoo treats hyphen-minus as hyphen, but not dots
    // Yahoo also removes dots
    let normalizedLocal = localPart.replace(/\./g, "");
    // Remove everything after hyphen (not dash)
    const hyphenIndex = normalizedLocal.indexOf("-");
    if (hyphenIndex > -1) {
      normalizedLocal = normalizedLocal.substring(0, hyphenIndex);
    }
    return `${normalizedLocal}@${domain}`;
  }
  
  // iCloud/Apple specific normalization
  if (domain === "icloud.com" || domain === "me.com" || domain === "mac.com") {
    // Apple removes dots and plus addresses
    let normalizedLocal = localPart.replace(/\./g, "");
    const plusIndex = normalizedLocal.indexOf("+");
    if (plusIndex > -1) {
      normalizedLocal = normalizedLocal.substring(0, plusIndex);
    }
    return `${normalizedLocal}@${domain}`;
  }
  
  // For custom domains, we might want to handle them differently
  // Many companies use Google Workspace or Microsoft 365
  // We can add custom domain normalization rules here if needed
  
  // For most other domains, just lowercase
  return trimmed;
};

export const extractDomain = (email) => {
  if (!email) return null;
  const parts = email.split("@");
  return parts.length === 2 ? parts[1] : null;
};

export const isValidEmail = (email) => {
  if (!email) return false;
  // RFC 5322 compliant regex (simplified version)
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return emailRegex.test(email);
};

// Additional helper functions
export const isDisposableEmail = (domain) => {
  const disposableDomains = [
    "tempmail.com", "10minutemail.com", "guerrillamail.com",
    "mailinator.com", "yopmail.com", "throwawaymail.com"
  ];
  return disposableDomains.some(d => domain.includes(d));
};

export const getEmailProvider = (domain) => {
  const providers = {
    "gmail.com": "Google",
    "googlemail.com": "Google",
    "outlook.com": "Microsoft",
    "hotmail.com": "Microsoft",
    "live.com": "Microsoft",
    "msn.com": "Microsoft",
    "yahoo.com": "Yahoo",
    "ymail.com": "Yahoo",
    "rocketmail.com": "Yahoo",
    "icloud.com": "Apple",
    "me.com": "Apple",
    "mac.com": "Apple",
    "aol.com": "AOL",
    "protonmail.com": "ProtonMail",
    "zoho.com": "Zoho"
  };
  
  return providers[domain] || "Custom/Other";
};