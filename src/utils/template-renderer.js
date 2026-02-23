export function renderTemplate(template, variables = {}) {
  if (!template) return "";

  // Simply replace any {{variable}} with its value, or an empty string if not found.
  return template.replace(/{{\s*([\s\S]+?)\s*}}/g, (match, key) => {
    // Strip any HTML tags that might have been accidentally included inside the brackets
    const cleanedKey = key.replace(/<[^>]*>?/gm, "").trim();
    
    // Check original, then lowercase versions of the key
    const value = variables[cleanedKey] ?? variables[cleanedKey.toLowerCase()];
    
    return value === undefined || value === null ? "" : String(value);
  });
}
