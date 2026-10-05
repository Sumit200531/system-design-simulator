export function rate(perSecond: number): string {
  if (!Number.isFinite(perSecond)) return "∞";
  if (perSecond >= 1_000_000) return `${(perSecond / 1_000_000).toFixed(1)}M`;
  if (perSecond >= 10_000) return `${Math.round(perSecond / 1_000)}k`;
  if (perSecond >= 1_000) return `${(perSecond / 1_000).toFixed(1)}k`;
  return perSecond >= 10 ? Math.round(perSecond).toString() : perSecond.toFixed(1);
}

export function ms(value: number): string {
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)} s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} s`;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ms`;
}

export function percent(fraction: number, digits = 1): string {
  const value = fraction * 100;
  return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(digits)}%`;
}

export function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function money(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
