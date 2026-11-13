/**
 * Phi-accrual suspicion (Hayashibara et al.). Instead of asking "has this
 * reply taken longer than a fixed limit?", ask "how surprising is this delay
 * given how this particular peer usually behaves?".
 *
 * phi = -log10(probability that a reply this late is still coming). phi 1
 * means a 10% chance, phi 3 means 0.1%, and so on.
 */
export function phi(elapsed: number, mean: number, std: number): number {
  const y = (elapsed - mean) / std;
  // Logistic approximation of the normal tail, as used by Cassandra and Akka.
  const e = Math.exp(-y * (1.5976 + 0.070566 * y * y));
  const pLater = elapsed > mean ? e / (1 + e) : 1 - 1 / (1 + e);
  return -Math.log10(Math.max(pLater, 1e-300));
}

export function stats(samples: readonly number[]): { mean: number; std: number } {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  // Floor the deviation: a peer that has been perfectly regular must not get a zero tolerance.
  return { mean, std: Math.max(Math.sqrt(variance), mean * 0.1, 1) };
}

/** How long to wait for this peer before phi crosses `threshold`. */
export function phiTimeout(samples: readonly number[], threshold: number): number {
  const { mean, std } = stats(samples);
  let lo = mean;
  let hi = mean + 40 * std;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (phi(mid, mean, std) < threshold) lo = mid;
    else hi = mid;
  }
  return hi;
}
