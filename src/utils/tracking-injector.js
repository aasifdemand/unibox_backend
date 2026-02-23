export function injectTracking(html, emailId, options = {}) {
  const { trackOpens = true, trackClicks = true, baseUrl = process.env.APP_URL || "http://localhost:8080" } = options;
  let trackedHtml = html;

  // 1. Inject Open Tracking Pixel
  if (trackOpens) {
    const pixelUrl = `${baseUrl}/api/v1/tracking/open/${emailId}`;
    const pixelTag = `<img src="${pixelUrl}" width="1" height="1" style="display:none !important;" alt="" />`;
    
    if (trackedHtml.includes("</body>")) {
      trackedHtml = trackedHtml.replace("</body>", `${pixelTag}</body>`);
    } else {
      trackedHtml += pixelTag;
    }
  }

  // 2. Inject Click Tracking
  if (trackClicks) {
    const clickUrlBase = `${baseUrl}/api/v1/tracking/click/${emailId}?url=`;
    
    // Regex to find all href attributes in anchor tags
    const hrefRegex = /<a\s+(?:[^>]*?\s+)?href=["']([^"']*)["']/gi;
    
    trackedHtml = trackedHtml.replace(hrefRegex, (match, url) => {
      // Don't track empty URLs, mailto, or anchor links
      if (!url || url.startsWith("mailto:") || url.startsWith("#") || url.startsWith("tel:")) {
        return match;
      }
      
      const trackedUrl = `${clickUrlBase}${encodeURIComponent(url)}`;
      return match.replace(url, trackedUrl);
    });
  }

  return trackedHtml;
}
