export const EmailProvider = Object.freeze({
  GOOGLE: "google",
  MICROSOFT: "microsoft",
  YAHOO: "yahoo",
  APPLE: "apple",
  ZOHO: "zoho",
  PROTON: "proton",

  // Gateways
  PROOFPOINT: "proofpoint",
  MIMECAST: "mimecast",
  BARRACUDA: "barracuda",

  // Hosting / infra
  GENERIC_HOSTED: "generic_hosted",
  SELF_HOSTED: "self_hosted",

  UNKNOWN: "unknown",
});

export const ConfidenceLevel = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  WEAK: "weak",
});
