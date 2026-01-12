import Redis from "ioredis";
import { mtaDetector } from "./mta-detector.service.js";
import EmailDomainProvider from "../models/email-domain-provider.model.js";

class MTADetectorCache {
  constructor() {
    this.redis = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL)
      : null;

    this.localCache = new Map();
    this.localTTL = 5 * 60 * 1000; // 5 minutes
    this.dbTTL = 24 * 60 * 60 * 1000; // 24 hours
  }

  async detect(email) {
    const domain = mtaDetector.extractDomain(email);
    const cacheKey = `mta:${domain}`;

    /* =========================
       1️⃣ LOCAL MEMORY CACHE
    ========================= */
    const local = this.localCache.get(cacheKey);
    if (local && Date.now() - local.ts < this.localTTL) {
      return local.data;
    }

    /* =========================
       2️⃣ REDIS CACHE
    ========================= */
    if (this.redis) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const data = JSON.parse(cached);
        this.localCache.set(cacheKey, { data, ts: Date.now() });
        return data;
      }
    }

    /* =========================
       3️⃣ DATABASE CACHE (CRITICAL)
    ========================= */
    const dbRecord = await EmailDomainProvider.findOne({
      where: { domain },
    });

    if (
      dbRecord &&
      dbRecord.ttlExpiresAt &&
      new Date(dbRecord.ttlExpiresAt) > new Date()
    ) {
      const data = this._fromDB(dbRecord);

      this.localCache.set(cacheKey, { data, ts: Date.now() });
      if (this.redis) {
        await this.redis.setex(cacheKey, 3600, JSON.stringify(data));
      }

      return data;
    }

    /* =========================
       4️⃣ HARD DETECTION
    ========================= */
    const detected = await mtaDetector.detect(email);

    /* =========================
       5️⃣ PERSIST RESULT (UPSERT)
    ========================= */
    await EmailDomainProvider.upsert({
      domain,
      provider: detected.provider,
      confidence: detected.confidence,
      score: detected.score,
      signals: detected.signals,
      detectedAt: new Date(),
      ttlExpiresAt: new Date(Date.now() + this.dbTTL),
    });

    this.localCache.set(cacheKey, { data: detected, ts: Date.now() });
    if (this.redis) {
      await this.redis.setex(cacheKey, 3600, JSON.stringify(detected));
    }

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
