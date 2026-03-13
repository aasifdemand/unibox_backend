import axios from "axios";

let cachedProxies = [];
let lastFetchTime = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

export async function fetchWebshareProxies() {
  const apiKey = process.env.WEBSHARE_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ WEBSHARE_API_KEY is not set in .env");
    return [];
  }

  // Use cache if still valid
  if (cachedProxies.length > 0 && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedProxies;
  }

  try {
    console.log("📡 Fetching fresh proxies from Webshare...");
    const response = await axios.get("https://proxy.webshare.io/api/v2/proxy/list/", {
      params: {
        mode: "direct",
        page_size: 100, // Adjust as needed
      },
      headers: {
        Authorization: `Token ${apiKey}`,
      },
      timeout: 15000,
    });

    if (response.data && response.data.results) {
      // Format: http://user:pass@ip:port
      cachedProxies = response.data.results.map(p => {
        return `http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`;
      });
      lastFetchTime = Date.now();
      console.log(`✅ Successfully loaded ${cachedProxies.length} proxies from Webshare`);
      return cachedProxies;
    }
    
    return [];
  } catch (error) {
    console.error("❌ Error fetching proxies from Webshare:", error.response?.data || error.message);
    // Return cached even if expired if fetch fails
    return cachedProxies;
  }
}

let lastProxyIndex = -1;
export async function getNextProxy() {
  const proxies = await fetchWebshareProxies();
  if (proxies.length === 0) return null;
  
  lastProxyIndex = (lastProxyIndex + 1) % proxies.length;
  return proxies[lastProxyIndex];
}
