export function fmtTime(seconds: number, decimals = 1): string {
  if (!Number.isFinite(seconds)) return '–';
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  s -= m * 60;
  const ss = s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `${neg ? '−' : ''}${m}:${ss}`;
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  return fmtTime(seconds, 0);
}

export function fmtDb(v: number, unit = 'dB', digits = 1): string {
  if (!Number.isFinite(v)) return v < 0 ? `−∞ ${unit}` : '–';
  const s = Math.abs(v).toFixed(digits);
  return `${v < 0 && Number(s) !== 0 ? '−' : v > 0 ? '+' : ''}${s} ${unit}`;
}

export function fmtLufs(v: number): string {
  if (!Number.isFinite(v)) return '–';
  return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtHz(f: number): string {
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`;
}

export function fmtAgo(ts: number): string {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}
