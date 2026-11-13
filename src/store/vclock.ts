/** Vector clock: per-node write counters. Missing entries count as zero. */
export type VClock = Readonly<Record<string, number>>;

export type Order = 'equal' | 'before' | 'after' | 'concurrent';

export function compare(a: VClock, b: VClock): Order {
  let aAhead = false;
  let bAhead = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x > y) aAhead = true;
    else if (y > x) bAhead = true;
  }
  if (aAhead && bAhead) return 'concurrent';
  return aAhead ? 'after' : bAhead ? 'before' : 'equal';
}

/** True when `a` has seen everything `b` has. */
export function descends(a: VClock, b: VClock): boolean {
  const order = compare(a, b);
  return order === 'after' || order === 'equal';
}

/** Least upper bound: entry-wise maximum. */
export function merge(a: VClock, b: VClock): VClock {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) if (v > (out[k] ?? 0)) out[k] = v;
  return out;
}

export function increment(clock: VClock, node: string): VClock {
  return { ...clock, [node]: (clock[node] ?? 0) + 1 };
}

/** Canonical text form, independent of key insertion order. */
export function clockKey(clock: VClock): string {
  return Object.keys(clock)
    .filter((k) => clock[k] > 0)
    .sort()
    .map((k) => `${k}:${clock[k]}`)
    .join(',');
}

export interface Version {
  value: string;
  clock: VClock;
}

/**
 * Reduces a pile of versions to the sibling set: drops every version that
 * another one descends, and duplicates. Result is in canonical order, so two
 * replicas holding the same siblings hold identical arrays.
 */
export function reconcile(versions: readonly Version[]): Version[] {
  const unique = new Map<string, Version>();
  for (const v of versions) if (!unique.has(clockKey(v.clock))) unique.set(clockKey(v.clock), v);
  const all = [...unique.values()];
  return all
    .filter((v) => !all.some((other) => compare(other.clock, v.clock) === 'after'))
    .sort((a, b) => (clockKey(a.clock) < clockKey(b.clock) ? -1 : 1));
}

/** The context a client must send back to supersede all of these versions. */
export function contextOf(versions: readonly Version[]): VClock {
  return versions.reduce<VClock>((acc, v) => merge(acc, v.clock), {});
}

/** Stable text form of a sibling set, for equality checks and Merkle hashing. */
export function fingerprint(versions: readonly Version[]): string {
  return versions.map((v) => `${clockKey(v.clock)}=${v.value}`).join('|');
}
