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

  // 3. Inject Unsubscribe Link
  if (options.unsubscribeLink) {
    const unsubUrl = `${baseUrl}/api/v1/tracking/unsubscribe/${emailId}`;
    const unsubHtml = `<div style="text-align: center; font-size: 11px; color: #777; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
      If you no longer wish to receive emails from us, you can <a href="${unsubUrl}" style="color: #777; text-decoration: underline;">unsubscribe here</a>.
    </div>`;

    if (trackedHtml.includes("</body>")) {
      trackedHtml = trackedHtml.replace("</body>", `${unsubHtml}</body>`);
    } else {
      trackedHtml += unsubHtml;
    }
  }

  return trackedHtml;
}
