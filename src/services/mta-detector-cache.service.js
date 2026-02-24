import Redis from "ioredis";
import { mtaDetector } from "./mta-detector.service.js";
import EmailDomainProvider from "../models/email-domain-provider.model.js";

class MTADetectorCache {
  constructor() {
    this.redis = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL)
      : null;

    this.localCache = new Map();
    this.localTTL = 5 * 60 * 1000; // 5 min
    this.dbTTL = 24 * 60 * 60 * 1000; // 24 hrs
  }

  async detect(emailOrDomain) {
    const domain = mtaDetector.extractDomain(emailOrDomain);
    const key = `mta:${domain}`;

    /* ---------- LOCAL ---------- */
    const local = this.localCache.get(key);
    if (local && Date.now() - local.ts < this.localTTL) {
      return local.data;
    }

    /* ---------- REDIS ---------- */
    if (this.redis) {
      const cached = await this.redis.get(key);
      if (cached) {
        const data = JSON.parse(cached);
        this._storeLocal(key, data);
        return data;
      }
    }

    /* ---------- DB ---------- */
    console.log(`🔍 [MTACache] Checking DB for ${domain}`);
    const record = await EmailDomainProvider.findOne({ where: { domain } });
    if (record && new Date(record.ttlExpiresAt) > new Date()) {
      console.log(`✅ [MTACache] DB hit for ${domain}`);
      const data = this._fromDB(record);
      await this._storeAll(key, data);
      return data;
    }

    /* ---------- HARD DETECTION ---------- */
    console.log(`🔍 [MTACache] Hard detection required for ${domain}`);
    const detected = await mtaDetector.detect(domain);

    await EmailDomainProvider.upsert({
      domain,
      provider: detected.provider,
      confidence: detected.confidence,
      score: detected.score,
      signals: detected.signals,
      detectedAt: new Date(),
      ttlExpiresAt: new Date(Date.now() + this.dbTTL),
    });

    await this._storeAll(key, detected);
    return detected;
  }

  async clearCache(domain) {
    if (!domain) {
      this.localCache.clear();
      if (this.redis) {
        const keys = await this.redis.keys("mta:*");
        if (keys.length) await this.redis.del(...keys);
      }
      return;
    }

    const key = `mta:${domain}`;
    this.localCache.delete(key);
    if (this.redis) await this.redis.del(key);
  }

  _storeLocal(key, data) {
    this.localCache.set(key, { data, ts: Date.now() });
  }

  async _storeAll(key, data) {
    this._storeLocal(key, data);
    if (this.redis) {
      await this.redis.setex(key, 3600, JSON.stringify(data));
    }
  }

  _fromDB(record) {
    return {
      domain: record.domain,
      provider: record.provider,
      confidence: record.confidence,
      score: record.score,
      signals: record.signals,
      detectedAt: record.detectedAt,
    };
  }
}

export const mtaDetectorCache = new MTADetectorCache();
export default mtaDetectorCache;
