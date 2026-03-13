export function renderTemplate(template, variables = {}) {
  if (!template) return "";

  // 1. Handle Spintax: {Option A|Option B|Option C}
  // We use a regex that handles nested brackets if needed, though simple is usually enough.
  const spintaxRegex = /{([^{}]+?)}/g;
  while (template.match(spintaxRegex)) {
    template = template.replace(spintaxRegex, (match, optionsStr) => {
      const choices = optionsStr.split('|');
      return choices[Math.floor(Math.random() * choices.length)];
    });
  }

  // 2. Handle Variables: {{variable}}
  return template.replace(/{{\s*([\s\S]+?)\s*}}/g, (match, key) => {
    const cleanedKey = key.replace(/<[^>]*>?/gm, "").trim();
    const value = variables[cleanedKey] ?? variables[cleanedKey.toLowerCase()];
    return value === undefined || value === null ? "" : String(value);
  });
}
