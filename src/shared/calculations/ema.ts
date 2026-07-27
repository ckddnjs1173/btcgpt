export function ema(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;

  const k = 2 / (period + 1);
  let emaPrev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    const v = values[i] ?? 0;
    emaPrev = v * k + (emaPrev ?? 0) * (1 - k);
  }

  return emaPrev;
}
