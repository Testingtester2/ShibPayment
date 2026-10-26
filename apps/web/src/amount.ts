/**
 * Reads a price as people type it: "10000", "10,000", "1 000 000", "12.50",
 * "12,50", "1.234,56", "10,00,000". A comma followed by exactly three digits is a thousands
 * separator; with both "," and ".", the last one is the decimal point.
 * Returns a plain decimal string ("10000", "12.5") or null.
 */
export function parsePrice(raw: string): string | null {
  // Spaces, apostrophes and underscores only ever group thousands: check the groups before dropping them.
  const spaced = raw.trim();
  if (/[\s'_]/.test(spaced) && !/^\d{1,3}([\s'_]\d{3})+([.,]\d+)?$/.test(spaced)) return null;
  const s = spaced.replace(/[\s'_]/g, '');
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return null;
  const seps = s.match(/[.,]/g) ?? [];
  let int = s, frac = '';
  if (seps.length) {
    const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    const lastSep = s[last];
    const mixed = new Set(seps).size > 1;
    const grouping = !mixed && (seps.length > 1 || (lastSep === ',' && /^\d{1,3},\d{3}$/.test(s)));
    if (grouping) {
      const western = new RegExp(`^\\d{1,3}(\\${lastSep}\\d{3})+$`).test(s);
      const indian = lastSep === ',' && /^\d{1,2}(,\d{2})+,\d{3}$/.test(s); // 10,00,000
      if (!western && !indian) return null;
      int = s.split(lastSep).join('');
    } else {
      int = s.slice(0, last);
      frac = s.slice(last + 1);
      if (mixed) {
        const group = lastSep === '.' ? ',' : '.';
        if (int.includes(lastSep) || !new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(int)) return null;
        int = int.split(group).join('');
      }
    }
  }
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return Number(out) > 0 ? out : null;
}

/** "10000.5" → "10,000.5", for showing the merchant what buyers will pay. */
export function groupDigits(amount: string): string {
  const [i, f] = amount.split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : '');
}
