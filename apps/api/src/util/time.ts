/** Time helpers: ISO conversion at the DB edge, absolute-timestamp rendering (§4.0 rule 15/16). */

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function isoOrNow(d: Date | null | undefined, now: Date): string {
  return (d ?? now).toISOString();
}

export function toDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function ageMs(now: Date, then: Date | null | undefined): number {
  return then ? now.getTime() - then.getTime() : Number.POSITIVE_INFINITY;
}

/** `09:41:07Z` for the digest's per-line stamps (§9.3). */
export function hhmmss(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toISOString().slice(11, 19) + 'Z';
}

/** `09:41Z` (minute resolution) for compact renderings. */
export function hhmm(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toISOString().slice(11, 16) + 'Z';
}

/** `2026-09-11 11:02Z` for handoff and decision lines. */
export function dateMinute(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toISOString().slice(0, 10) + ' ' + x.toISOString().slice(11, 16) + 'Z';
}

/** "12m" / "3h" / "2d" for idle labels. */
export function shortDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Parses `since` arguments: ISO time or "1d" / "7d" / "12h" / "30m" (§9.2). */
export function parseSince(value: string | undefined, now: Date, fallbackMs: number): Date {
  if (!value) return new Date(now.getTime() - fallbackMs);
  const m = /^(\d+)([mhd])$/.exec(value.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() - n * unit);
  }
  const d = toDate(value);
  return d ?? new Date(now.getTime() - fallbackMs);
}

/** Parses claim ttl strings like "4h", "30m", "1d"; null when unparseable. */
export function parseTtlMs(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  return Math.round(n * unit);
}
