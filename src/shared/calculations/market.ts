export interface Ohlcv {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

export function atr(candles: Ohlcv[], period = 14): number | null {
  if (period <= 0 || candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index]?.close ?? candle.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  if (ranges.length < period) return null;
  let value =
    ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  for (const range of ranges.slice(period))
    value = (value * (period - 1) + range) / period;
  return value;
}

export function vwap(candles: Ohlcv[]): number | null {
  const totalVolume = candles.reduce((sum, candle) => sum + candle.volume, 0);
  if (candles.length === 0 || totalVolume <= 0) return null;
  return (
    candles.reduce(
      (sum, candle) =>
        sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume,
      0,
    ) / totalVolume
  );
}

export function volumeZScore(volumes: number[], period = 20): number | null {
  if (volumes.length < period || period < 2) return null;
  const window = volumes.slice(-period);
  const mean = window.reduce((sum, value) => sum + value, 0) / period;
  const variance =
    window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
  const deviation = Math.sqrt(variance);
  return deviation === 0 ? 0 : ((window.at(-1) ?? mean) - mean) / deviation;
}

export function pivotLevels(high: number, low: number, close: number) {
  const pivot = (high + low + close) / 3;
  return {
    pivot,
    resistance1: 2 * pivot - low,
    support1: 2 * pivot - high,
    resistance2: pivot + (high - low),
    support2: pivot - (high - low),
  };
}

export function orderBookImbalance(
  bids: Array<[number, number]>,
  asks: Array<[number, number]>,
  levels = 20,
): number | null {
  const bid = bids
    .slice(0, levels)
    .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  const ask = asks
    .slice(0, levels)
    .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  return bid + ask === 0 ? null : (bid - ask) / (bid + ask);
}

export function estimateSlippage(
  side: 'BUY' | 'SELL',
  quantity: number,
  levels: Array<[number, number]>,
): { averagePrice: number; slippageBps: number } | null {
  if (quantity <= 0 || levels.length === 0) return null;
  let remaining = quantity;
  let cost = 0;
  for (const [price, available] of levels) {
    const fill = Math.min(remaining, available);
    cost += fill * price;
    remaining -= fill;
    if (remaining <= 1e-12) break;
  }
  if (remaining > 1e-12) return null;
  const averagePrice = cost / quantity;
  const reference = levels[0]?.[0] ?? averagePrice;
  const signed =
    side === 'BUY' ? averagePrice - reference : reference - averagePrice;
  return { averagePrice, slippageBps: (signed / reference) * 10_000 };
}

export function percentageChange(
  current: number,
  previous: number,
): number | null {
  return previous === 0 ? null : ((current - previous) / previous) * 100;
}

export function realizedVolatility(
  closes: number[],
  periodsPerYear: number,
): number | null {
  if (closes.length < 3 || periodsPerYear <= 0) return null;
  const returns = closes.slice(1).map((value, index) => {
    const previous = closes[index] ?? value;
    return Math.log(value / previous);
  });
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (returns.length - 1);
  return Math.sqrt(variance * periodsPerYear) * 100;
}

export function recentExtremes(values: number[], period: number) {
  if (values.length < period || period <= 0) return { high: null, low: null };
  const window = values.slice(-period);
  return { high: Math.max(...window), low: Math.min(...window) };
}

export function confirmedPivots(
  highs: number[],
  lows: number[],
  strength = 2,
): { high: number | null; low: number | null } {
  let pivotHigh: number | null = null;
  let pivotLow: number | null = null;
  for (let index = strength; index < highs.length - strength; index += 1) {
    const high = highs[index];
    const low = lows[index];
    if (
      high !== undefined &&
      highs
        .slice(index - strength, index + strength + 1)
        .every((value) => value <= high)
    )
      pivotHigh = high;
    if (
      low !== undefined &&
      lows
        .slice(index - strength, index + strength + 1)
        .every((value) => value >= low)
    )
      pivotLow = low;
  }
  return { high: pivotHigh, low: pivotLow };
}
