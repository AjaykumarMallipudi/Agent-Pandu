export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtNum(n: number | undefined | null): string {
  return (n ?? 0).toLocaleString();
}

export function location(c: { city?: string | null; state?: string | null; country?: string | null }): string {
  return [c.city, c.state, c.country].filter(Boolean).join(', ') || '—';
}
