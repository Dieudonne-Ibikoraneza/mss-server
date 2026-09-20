/** Shared minimal shell so every transactional email looks consistent. */
export const emailShell = (bodyHtml: string) => `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1f2937;">
  <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #b8860b; font-weight: 600; margin: 0 0 20px;">Magnificat Smart Space</p>
  ${bodyHtml}
  <p style="margin-top: 32px; font-size: 12px; color: #9ca3af;">This is an automated message — please don't reply directly to this email.</p>
</div>
`.trim();
