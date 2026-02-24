import dns from "dns/promises";
import net from "net";
import {
  EmailProvider,
  ConfidenceLevel,
} from "../enums/email-provider.enum.js";

const SMTP_TIMEOUT_MS = 3500;

/**
 * Weighted signal model:
 * - MX patterns: 0.6
 * - SMTP banner: 0.3
 * - Fallback heuristic: 0.1
 */
class MTADetector {
  constructor() {
    /* =========================
       MX SIGNAL PATTERNS
    ========================= */
    this.mxPatterns = {
      [EmailProvider.GOOGLE]: [/aspmx/i, /\.google\.com$/i],
      [EmailProvider.MICROSOFT]: [/\.mail\.protection\.outlook\.com$/i],
      [EmailProvider.YAHOO]: [/\.yahoodns\.net$/i],
      [EmailProvider.APPLE]: [/\.icloud\.com$/i],
      [EmailProvider.ZOHO]: [/\.zoho\.com$/i],
      [EmailProvider.PROTON]: [/\.protonmail\./i],

      // Security gateways (highest priority)
      [EmailProvider.PROOFPOINT]: [/proofpoint/i],
      [EmailProvider.MIMECAST]: [/mimecast/i],
      [EmailProvider.BARRACUDA]: [/barracuda/i],
    };

    /* =========================
       SMTP BANNER PATTERNS
    ========================= */
    this.smtpPatterns = {
      [EmailProvider.GOOGLE]: [/google/i],
      [EmailProvider.MICROSOFT]: [/microsoft/i, /outlook/i],
      [EmailProvider.PROOFPOINT]: [/proofpoint/i],
      [EmailProvider.MIMECAST]: [/mimecast/i],
      [EmailProvider.BARRACUDA]: [/barracuda/i],
      [EmailProvider.ZOHO]: [/zoho/i],
      [EmailProvider.PROTON]: [/proton/i],
    };
  }

  extractDomain(emailOrDomain) {
    if (emailOrDomain.includes("@")) {
      return emailOrDomain.split("@")[1].toLowerCase().trim();
    }
    return emailOrDomain.toLowerCase().trim();
  }

  /* =========================
     PUBLIC API
  ========================= */
  async detect(emailOrDomain) {
    const domain = this.extractDomain(emailOrDomain);
    return this._detectDomain(domain);
  }

  /* =========================
     CORE DETECTION
  ========================= */
  async _detectDomain(domain) {
    const scores = {};
    const signals = { mx: [], smtp: null };

    Object.values(EmailProvider).forEach((p) => (scores[p] = 0));

    /* ---------- MX LOOKUP ---------- */
    let mxRecords = [];
    try {
      mxRecords = await dns.resolveMx(domain);
      mxRecords.sort((a, b) => a.priority - b.priority);
    } catch {
      return this._finalize(domain, EmailProvider.UNKNOWN, 0, signals);
    }

    signals.mx = mxRecords.map((m) => ({
      exchange: m.exchange,
      priority: m.priority,
    }));

    /* ---------- MX WEIGHT (0.6) ---------- */
    for (const mx of mxRecords) {
      const host = mx.exchange.toLowerCase();
      for (const [provider, patterns] of Object.entries(this.mxPatterns)) {
        if (patterns.some((p) => p.test(host))) {
          scores[provider] += 0.6;
        }
      }
    }

    /* ---------- SMTP PROBE (0.3, best MX only) ---------- */
    console.log(`🔍 [MTADetector] Probing SMTP banner for ${mxRecords[0].exchange}`);
    const banner = await this._probeSMTP(mxRecords[0].exchange);
    signals.smtp = banner;

    if (banner) {
      console.log(`✅ [MTADetector] SMTP banner received: ${banner.substring(0, 50)}...`);
      for (const [provider, patterns] of Object.entries(this.smtpPatterns)) {
        if (patterns.some((p) => p.test(banner))) {
          scores[provider] += 0.3;
        }
      }
    } else {
      console.log(`⚠️ [MTADetector] No SMTP banner received for ${mxRecords[0].exchange}`);
    }

    /* ---------- MULTI-MX CONSISTENCY BOOST (0.1) ---------- */
    const uniqueProviders = Object.entries(scores)
      .filter(([, s]) => s >= 0.6)
      .map(([p]) => p);

    if (uniqueProviders.length === 1) {
      scores[uniqueProviders[0]] += 0.1;
    }

    /* ---------- SELECT WINNER ---------- */
    const [winner, score] = Object.entries(scores).sort(
      (a, b) => b[1] - a[1]
    )[0];

    /* ---------- SELF-HOSTED HEURISTIC ---------- */
    if (score === 0 && mxRecords.length) {
      return this._finalize(domain, EmailProvider.SELF_HOSTED, 0.4, signals);
    }

    return this._finalize(domain, winner, score, signals);
  }

  /* =========================
     SMTP SAFE PROBE
  ========================= */
  async _probeSMTP(host) {
    return new Promise((resolve) => {
      let resolved = false;
      
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.log(`🕒 [MTADetector] SMTP Probe timed out for ${host}`);
          socket.destroy();
          resolve(null);
        }
      }, SMTP_TIMEOUT_MS);

      const socket = net.createConnection(25, host);
      socket.setTimeout(SMTP_TIMEOUT_MS);

      socket.once("data", (data) => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(data.toString());
        }
      });

      socket.on("timeout", () => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(null);
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          console.log(`❌ [MTADetector] SMTP Probe error for ${host}: ${err.message}`);
          resolve(null);
        }
      });
    });
  }

  /* =========================
     NORMALIZATION
  ========================= */
  _finalize(domain, provider, score, signals) {
    const normalizedScore = Math.min(1, Number(score.toFixed(2)));

    const confidence =
      normalizedScore >= 0.9
        ? ConfidenceLevel.HIGH
        : normalizedScore >= 0.75
        ? ConfidenceLevel.MEDIUM
        : normalizedScore >= 0.5
        ? ConfidenceLevel.LOW
        : ConfidenceLevel.WEAK;

    return {
      domain,
      provider: normalizedScore === 0 ? EmailProvider.UNKNOWN : provider,
      confidence,
      score: normalizedScore,
      signals,
      detectedAt: new Date().toISOString(),
    };
  }
}

export const mtaDetector = new MTADetector();
export default mtaDetector;
