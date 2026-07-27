import type { Candle, Timeframe } from './types';

const INTERVAL_MS: Record<Timeframe, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

export function detectCandleGaps(
  candles: Candle[],
  timeframe: Timeframe,
): number[] {
  if (candles.length < 2) return [];
  const interval = INTERVAL_MS[timeframe];
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const missing: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!previous || !current) continue;
    for (
      let openTime = previous.openTime + interval;
      openTime < current.openTime;
      openTime += interval
    )
      missing.push(openTime);
  }
  return missing;
}
