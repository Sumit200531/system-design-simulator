/**
 * Queueing approximations and latency distributions.
 *
 * Latency at a component = fixed part (processing, network, backlog drain)
 * + a waiting time that is approximately exponential. Paths through the
 * system combine these into mixtures, from which percentiles are solved.
 */

/** Utilization is capped below 1 so the steady-state formula stays finite; overload is modelled by backlog instead. */
export const MAX_STEADY_UTILIZATION = 0.98;

/**
 * Mean queueing delay in an M/M/c system (Sakasegawa's approximation):
 *   Wq ≈ ρ^(√(2(c+1)) − 1) / (c (1 − ρ)) × S
 * where S is the mean service time of one server.
 */
export function meanQueueingDelaySeconds(utilization: number, servers: number, serviceTimeSeconds: number): number {
  if (utilization <= 0 || servers <= 0 || !Number.isFinite(serviceTimeSeconds)) return 0;
  const rho = Math.min(utilization, MAX_STEADY_UTILIZATION);
  return (Math.pow(rho, Math.sqrt(2 * (servers + 1)) - 1) / (servers * (1 - rho))) * serviceTimeSeconds;
}

/** One component of a latency mixture: with probability p, latency = fixed + Exp(mean = exp). */
export interface LatencyBranch {
  readonly p: number;
  readonly fixedMs: number;
  readonly expMs: number;
}

export type LatencyMixture = readonly LatencyBranch[];

/** Mixtures are kept small; nearby branches are merged by probability-weighted averaging. */
export const MAX_BRANCHES = 16;

export const ZERO_LATENCY: LatencyMixture = [{ p: 1, fixedMs: 0, expMs: 0 }];

export function shift(mixture: LatencyMixture, fixedMs: number, expMs: number): LatencyMixture {
  return mixture.map((b) => ({ p: b.p, fixedMs: b.fixedMs + fixedMs, expMs: b.expMs + expMs }));
}

/** Latency of doing A then B (sequential calls). */
export function sequence(a: LatencyMixture, b: LatencyMixture): LatencyMixture {
  const out: LatencyBranch[] = [];
  for (const x of a) for (const y of b) out.push({ p: x.p * y.p, fixedMs: x.fixedMs + y.fixedMs, expMs: x.expMs + y.expMs });
  return compress(out);
}

/** Latency when a request takes branch i with weight w_i. Weights are normalized. */
export function choice(options: readonly { weight: number; mixture: LatencyMixture }[]): LatencyMixture {
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  if (total <= 0) return ZERO_LATENCY;
  const out: LatencyBranch[] = [];
  for (const o of options) {
    if (o.weight <= 0) continue;
    for (const b of o.mixture) out.push({ ...b, p: (b.p * o.weight) / total });
  }
  return compress(out);
}

function compress(branches: LatencyBranch[]): LatencyMixture {
  const live = branches.filter((b) => b.p > 1e-9);
  if (live.length <= MAX_BRANCHES) return live;
  const sorted = [...live].sort((a, b) => a.fixedMs + a.expMs - (b.fixedMs + b.expMs));
  while (sorted.length > MAX_BRANCHES) {
    // Merge the adjacent pair whose means are closest.
    let best = 0;
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < sorted.length - 1; i++) {
      const d = sorted[i + 1]!.fixedMs + sorted[i + 1]!.expMs - (sorted[i]!.fixedMs + sorted[i]!.expMs);
      if (d < gap) {
        gap = d;
        best = i;
      }
    }
    const a = sorted[best]!;
    const b = sorted[best + 1]!;
    const p = a.p + b.p;
    sorted.splice(best, 2, { p, fixedMs: (a.fixedMs * a.p + b.fixedMs * b.p) / p, expMs: (a.expMs * a.p + b.expMs * b.p) / p });
  }
  return sorted;
}

export function meanLatency(mixture: LatencyMixture): number {
  const total = mixture.reduce((s, b) => s + b.p, 0) || 1;
  return mixture.reduce((s, b) => s + b.p * (b.fixedMs + b.expMs), 0) / total;
}

function cdf(mixture: LatencyMixture, ms: number): number {
  const total = mixture.reduce((s, b) => s + b.p, 0) || 1;
  let value = 0;
  for (const b of mixture) {
    if (ms < b.fixedMs) continue;
    value += b.p * (b.expMs <= 0 ? 1 : 1 - Math.exp(-(ms - b.fixedMs) / b.expMs));
  }
  return value / total;
}

/** Latency below which a fraction q of requests complete, solved by bisection on the mixture CDF. */
export function percentile(mixture: LatencyMixture, q: number): number {
  let low = 0;
  let high = Math.max(1, ...mixture.map((b) => b.fixedMs + b.expMs * 30));
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (cdf(mixture, mid) >= q) high = mid;
    else low = mid;
  }
  return high;
}
