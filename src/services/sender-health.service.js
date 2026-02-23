import dns from "dns/promises";
import SenderHealth from "../models/sender-health.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import Email from "../models/email.model.js";
import BounceEvent from "../models/bounce-event.model.js";

class SenderHealthService {
  async evaluateSender(senderId) {
    const sender = await SmtpSender.findByPk(senderId);
    if (!sender) throw new Error("Sender not found");

    const domain = sender.email.split("@")[1];

    const spf = await this.checkSPF(domain);
    const dkim = await this.checkDKIM(domain, sender.dkimSelector);
    const dmarc = await this.checkDMARC(domain);
    const ptr = await this.checkPTR(sender.sendingIp);
    const blacklist = await this.checkBlacklist(sender.sendingIp);

    const behavior = await this.calculateBehavioralMetrics(senderId);

    const score = this.calculateReputationScore({
      spf,
      dkim,
      dmarc,
      ptr,
      blacklist,
      behavior,
    });

    await SenderHealth.upsert({
      senderId,
      spfValid: spf.valid,
      dkimValid: dkim.valid,
      dmarcPolicy: dmarc.policy || "none",
      ptrValid: ptr.valid,
      blacklisted: blacklist.blacklisted,
      reputationScore: score,
      bounceRate: behavior.bounceRate,
      complaintRate: behavior.complaintRate,
      lastCheckedAt: new Date(),
    });

    return score;
  }

  /* =========================
     DNS CHECKS
  ========================= */

  async checkSPF(domain) {
    try {
      const records = await dns.resolveTxt(domain);
      const spf = records
        .flat()
        .find((r) => r.toLowerCase().startsWith("v=spf1"));
      return { valid: !!spf };
    } catch {
      return { valid: false };
    }
  }

  async checkDKIM(domain, selector) {
    if (!selector) return { valid: false };

    try {
      const record = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
      return { valid: record.flat().join("").includes("v=DKIM1") };
    } catch {
      return { valid: false };
    }
  }

  async checkDMARC(domain) {
    try {
      const record = await dns.resolveTxt(`_dmarc.${domain}`);
      const value = record.flat().join("");
      const policy = value.match(/p=(none|quarantine|reject)/)?.[1];
      return { valid: true, policy };
    } catch {
      return { valid: false };
    }
  }

  async checkPTR(ip) {
    if (!ip) return { valid: false };
    try {
      const ptr = await dns.reverse(ip);
      return { valid: !!ptr.length };
    } catch {
      return { valid: false };
    }
  }

  async checkBlacklist(ip) {
    if (!ip) return { blacklisted: false };

    const reversed = ip.split(".").reverse().join(".");
    try {
      await dns.resolve4(`${reversed}.zen.spamhaus.org`);
      return { blacklisted: true };
    } catch {
      return { blacklisted: false };
    }
  }

  /* =========================
     BEHAVIORAL METRICS
  ========================= */

  async calculateBehavioralMetrics(senderId) {
    const last7Days = new Date(Date.now() - 7 * 86400000);

    const totalSent = await Email.count({
      where: { senderId, sentAt: { $gte: last7Days } },
    });

    const bounces = await BounceEvent.count({
      where: { senderId, createdAt: { $gte: last7Days } },
    });

    const bounceRate = totalSent ? (bounces / totalSent) * 100 : 0;

    return {
      bounceRate,
      complaintRate: 0, // Expand later
    };
  }

  /* =========================
     REPUTATION SCORE
  ========================= */

  calculateReputationScore({ spf, dkim, dmarc, ptr, blacklist, behavior }) {
    let score = 0;

    if (spf.valid) score += 20;
    if (dkim.valid) score += 25;
    if (dmarc.policy === "reject") score += 20;
    if (ptr.valid) score += 15;
    if (!blacklist.blacklisted) score += 20;

    if (behavior.bounceRate < 2) score += 10;
    else if (behavior.bounceRate > 5) score -= 20;

    return Math.max(0, Math.min(score, 100));
  }
}

export const senderHealthService = new SenderHealthService();
