export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>\'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[char]!)
}