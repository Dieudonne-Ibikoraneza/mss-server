/** Substitutes {{token}} placeholders in a template string. Unknown tokens render as empty. */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => variables[key] ?? '');
}

/** Escapes HTML special characters before interpolating untrusted values (e.g. a user's name) into an HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
