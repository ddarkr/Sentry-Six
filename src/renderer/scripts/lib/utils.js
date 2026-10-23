export function cssEscape(s) {
  if (window.CSS?.escape) return window.CSS.escape(String(s));
  // minimal escape for attribute selector usage
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

export function isRcloneStreamUrl(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/sentry-rclone\/[a-f0-9]{64}\/((?:[A-Za-z0-9_.!~*'()-]|%[a-fA-F0-9]{2})+)$/);
  if (!match || Number(match[1]) > 65535) return false;
  try {
    const name = decodeURIComponent(match[2]);
    return name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
  } catch { return false; }
}

/**
 * Encode a file path for use in a file:// URL.
 * Unlike encodeURI(), this also encodes # and ? characters which are valid URI
 * characters but have special meaning (fragment/query) and break file paths.
 * @param {string} filePath - The file path to encode
 * @returns {string} The encoded file:// URL
 */
export function filePathToUrl(filePath) {
  if (isRcloneStreamUrl(filePath)) return filePath;
  const normalizedPath = filePath.replace(/\\/g, '/');
  // encodeURI handles most characters but NOT # and ? which have special URL meaning
  // We need to encode those separately after encodeURI
  const encoded = encodeURI(normalizedPath)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  return normalizedPath.startsWith('/') 
    ? `file://${encoded}` 
    : `file:///${encoded}`;
}

