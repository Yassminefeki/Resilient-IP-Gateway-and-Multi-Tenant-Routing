const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const compactDateTime = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const timeOnly = new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
}

export function formatCompactDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : compactDateTime.format(d);
}

export function formatTime(ms: number | undefined): string {
  return ms ? timeOnly.format(new Date(ms)) : '—';
}

export function formatDuration(startIso: string, endIso: string | null | undefined): string {
  if (!endIso) return '—';
  const s = Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000));
  if (Number.isNaN(s)) return '—';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const percent = (part: number, total: number): number =>
  total === 0 ? 0 : Math.round((part / total) * 100);

export function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
