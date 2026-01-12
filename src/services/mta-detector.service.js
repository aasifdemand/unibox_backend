import dns from "dns/promises";
import net from "net";
import {
  EmailProvider,
  ConfidenceLevel,
} from "../enums/email-provider.enum.js";

const SMTP_TIMEOUT_MS = 4000;

class MTADetector {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 60 * 60 * 1000;

    /* =========================
       MX PATTERN SIGNALS
    ========================= */
    this.mxPatterns = {
      [EmailProvider.GOOGLE]: [/aspmx/i, /\.google\.com$/i],
      [EmailProvider.MICROSOFT]: [/\.mail\.protection\.outlook\.com$/i],
      [EmailProvider.ZOHO]: [/\.zoho\.com$/i, /\.zmx\.com$/i],
      [EmailProvider.PROTON]: [/\.protonmail/i],
      [EmailProvider.PROOFPOINT]: [/proofpoint/i],
      [EmailProvider.MIMECAST]: [/mimecast/i],
      [EmailProvider.BARRACUDA]: [/barracuda/i],
    };

    /* =========================
       SMTP BANNER SIGNALS
    ========================= */
    this.smtpPatterns = {
      [EmailProvider.GOOGLE]: [/google/i],
      [EmailProvider.MICROSOFT]: [/microsoft/i, /outlook/i],
      [EmailProvider.PROOFPOINT]: [/proofpoint/i],
      [EmailProvider.MIMECAST]: [/mimecast/i],
      [EmailProvider.BARRACUDA]: [/barracuda/i],
    };
  }

  extractDomain(email) {
    if (!email.includes("@")) {
      throw new Error("Invalid email");
    }
    return email.split("@")[1].toLowerCase().trim();
  }

  async detect(email) {
    const domain = this.extractDomain(email);
    const cacheKey = `mta:${domain}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return cached.data;
    }

    const result = await this.performDetection(domain);

    this.cache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  /* =========================
     CORE DETECTION
  ========================= */
  async performDetection(domain) {
    const scores = {};
    const signals = {
      mx: [],
      smtp: null,
    };

    Object.values(EmailProvider).forEach((p) => (scores[p] = 0));

    /* ---------- MX LOOKUP ---------- */
    let mxRecords = [];
    try {
      mxRecords = await dns.resolveMx(domain);
      mxRecords.sort((a, b) => a.priority - b.priority);
    } catch (_) {}

    signals.mx = mxRecords.map((r) => ({
      exchange: r.exchange,
      priority: r.priority,
    }));

    /* MX PATTERN WEIGHT: 0.6 */
    for (const mx of mxRecords) {
      const host = mx.exchange.toLowerCase();
      for (const [provider, patterns] of Object.entries(this.mxPatterns)) {
        if (patterns.some((p) => p.test(host))) {
          scores[provider] += 0.6;
        }
      }
    }

    /* ---------- SMTP PROBE (fallback) ---------- */
    if (mxRecords.length) {
      const banner = await this.probeSMTP(mxRecords[0].exchange);
      signals.smtp = banner;

      if (banner) {
        for (const [provider, patterns] of Object.entries(this.smtpPatterns)) {
          if (patterns.some((p) => p.test(banner))) {
            scores[provider] += 0.3;
          }
        }
      }
    }

    /* ---------- NORMALIZE ---------- */
    const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [winner, rawScore] = entries[0];

    const score = Math.min(1, Number(rawScore.toFixed(3)));

    const confidence =
      score >= 0.9
        ? ConfidenceLevel.HIGH
        : score >= 0.7
        ? ConfidenceLevel.MEDIUM
        : score >= 0.5
        ? ConfidenceLevel.LOW
        : ConfidenceLevel.WEAK;

    return {
      domain,
      provider: score === 0 ? EmailProvider.UNKNOWN : winner,
      confidence,
      score,
      signals,
      detectedAt: new Date().toISOString(),
    };
  }

  /* =========================
     SAFE SMTP BANNER PROBE
  ========================= */
  async probeSMTP(host) {
    return new Promise((resolve) => {
      const socket = net.createConnection(25, host);
      socket.setTimeout(SMTP_TIMEOUT_MS);

      socket.once("data", (data) => {
        socket.destroy();
        resolve(data.toString());
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve(null);
      });

      socket.on("error", () => resolve(null));
    });
  }
}

export const mtaDetector = new MTADetector();
export default mtaDetector;
