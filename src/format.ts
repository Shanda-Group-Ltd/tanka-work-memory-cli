/** Small display-formatting helpers. */

/** Human-readable byte size. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Relative time from an epoch-ms timestamp ("3m ago", "2d ago"). */
export function fmtRelTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

/** Ultra-compact age from an epoch-ms timestamp ("5m", "2h", "6d") for dense rows. */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'now';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d`;
  return `${Math.floor(d / 365)}y`;
}

/** Format an ISO string or epoch-ms as a short local datetime. */
export function fmtDateTime(value: string | number | undefined): string {
  if (value === undefined || value === '') return '—';
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Shorten a UUID-ish id to its leading segment for compact lists. */
export function shortId(id: string): string {
  if (id.length <= 12) return id;
  const dash = id.indexOf('-');
  if (dash >= 6 && dash <= 12) return id.slice(0, dash);
  return id.slice(0, 8);
}

/**
 * Terminal columns a single code point occupies: 2 for East-Asian wide /
 * fullwidth characters (CJK, Kana, Hangul, fullwidth forms) and most emoji, 1
 * otherwise. An approximation of Unicode East_Asian_Width good enough for
 * aligning list columns — `padEnd`/`.length` count these as 1 and misalign
 * anything after a CJK name.
 */
function codePointWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals · Kangxi · CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Kana · CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B and beyond
  )
    return 2;
  return 1;
}

/** Total terminal columns a string occupies (CJK-aware; see codePointWidth). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += codePointWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Right-pad a string to a display-column width (CJK-aware counterpart of padEnd). */
export function padEndWidth(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** Clip a string to a column width (CJK-aware), adding an ellipsis. */
export function clip(s: string, width: number): string {
  const flat = s.replace(/\s+/g, ' ');
  if (displayWidth(flat) <= width) return flat;
  let out = '';
  let w = 0;
  for (const ch of flat) {
    const cw = codePointWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > Math.max(0, width - 1)) break; // reserve 1 col for the ellipsis
    out += ch;
    w += cw;
  }
  return `${out}…`;
}
