import { fetchServerTime, fetchKlines } from '../binance/public/rest';
import { fetchPremiumIndex, fetchOpenInterest } from '../binance/public/additional';

export type AnalysisGate = {
  analysisAllowed: boolean;
  overallStatus: string;
  generatedAt: number;
  ageMs: number;
  reasons: string[];
  missingFields: string[];
};

export async function generateSnapshot() {
  const generatedAt = Date.now();

  const [time, klines5m, premium, oi] = await Promise.all([
    fetchServerTime(),
    fetchKlines('BTCUSDT', '5m', 120),
    fetchPremiumIndex('BTCUSDT'),
    fetchOpenInterest('BTCUSDT'),
  ]);

  const ageMs = Date.now() - generatedAt;

  const analysisGate: AnalysisGate = {
    analysisAllowed: true,
    overallStatus: 'NORMAL',
    generatedAt,
    ageMs,
    reasons: [],
    missingFields: [],
  };

  return {
    schemaVersion: 1,
    snapshotId: `local-${generatedAt}`,
    symbol: 'BTCUSDT',
    market: 'BINANCE_USDM_PERPETUAL',
    generatedAt,
    binanceServerTime: time.serverTime,
    analysisGate,
    timeframes: {
      '5m': {
        fields: ['openTime', 'open', 'high', 'low', 'close', 'volume', 'tradeCount'],
        closed: klines5m.map((t) => [t[0], t[1], t[2], t[3], t[4], t[5], 0]),
        live: [],
      },
    },
    marketState: {
      markPrice: premium.markPrice,
      indexPrice: premium.indexPrice,
    },
    openInterest: oi,
  };
}
