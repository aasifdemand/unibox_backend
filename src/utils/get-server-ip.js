import axios from "axios";

let _cachedIp = null;
let _cachedAt = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Returns the server's real public IPv4 address.
 * Result is cached for 1 hour to avoid hitting external services on every request.
 */
export async function getServerPublicIp() {
  if (_cachedIp && _cachedAt && Date.now() - _cachedAt < CACHE_TTL_MS) {
    return _cachedIp;
  }

  // Try multiple providers in order for resilience
  const providers = [
    "https://api.ipify.org?format=json",
    "https://api4.my-ip.io/v2/ip.json",
    "https://ipv4.icanhazip.com",
  ];

  for (const url of providers) {
    try {
      const res = await axios.get(url, { timeout: 5000 });
      const ip =
        typeof res.data === "string"
          ? res.data.trim()
          : res.data?.ip || res.data?.ipv4;

      if (ip && ip !== "::1") {
        _cachedIp = ip;
        _cachedAt = Date.now();
        return ip;
      }
    } catch {
      // Try next provider
    }
  }

  return null; // Could not determine public IP
}
