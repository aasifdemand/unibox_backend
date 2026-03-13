import dns from "node:dns/promises";

/**
 * DNSChecker verifies critical email deliverability records (SPF, DMARC).
 */
export class DNSChecker {
  /**
   * Checks if domain has valid SPF records.
   */
  static async checkSPF(domain) {
    try {
      const records = await dns.resolveTxt(domain);
      const spfRecord = records.flat().find(r => r.startsWith("v=spf1"));
      
      return {
        valid: !!spfRecord,
        record: spfRecord || null,
        error: spfRecord ? null : "No SPF record found"
      };
    } catch (err) {
      return { valid: false, record: null, error: err.message };
    }
  }

  /**
   * Checks for DMARC record.
   */
  static async checkDMARC(domain) {
    try {
      const dmarcDomain = `_dmarc.${domain}`;
      const records = await dns.resolveTxt(dmarcDomain);
      const dmarcRecord = records.flat().find(r => r.startsWith("v=DMARC1"));

      return {
        valid: !!dmarcRecord,
        record: dmarcRecord || null,
        error: dmarcRecord ? null : "No DMARC record found"
      };
    } catch (err) {
      return { valid: false, record: null, error: err.message };
    }
  }

  /**
   * Full Health Check
   */
  static async getHealth(domain) {
    const [spf, dmarc] = await Promise.all([
      this.checkSPF(domain),
      this.checkDMARC(domain)
    ]);

    const score = (spf.valid ? 50 : 0) + (dmarc.valid ? 50 : 0);

    return {
      domain,
      score,
      spf,
      dmarc,
      isProductionReady: score === 100
    };
  }
}
