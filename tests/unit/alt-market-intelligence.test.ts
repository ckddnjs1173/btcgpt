import { describe, expect, it } from 'vitest';

import type {
  AltAssetObservation,
  DynamicBasketCandidate,
} from '../../src/shared/alt-market-intelligence';
import { buildAltMarketIntelligence } from '../../src/main/market/intelligence/alt-market';
import { AltAssetAccumulator } from '../../src/main/market/multicoin/alt-accumulator';
import {
  eligibleDynamicSymbols,
  scanDynamicBasketCandidates,
} from '../../src/main/market/multicoin/alt-binance-rest';
import {
  DYNAMIC_BASKET_MIN_RESIDENCE_MS,
  scoreDynamicBasketCandidates,
  selectDynamicBasket,
} from '../../src/main/market/multicoin/dynamic-basket';

const NOW = 1_800_000_000_000;

function candidate(
  symbol: string,
  score: number,
  overrides: Partial<DynamicBasketCandidate> = {},
): DynamicBasketCandidate {
  return {
    symbol,
    baseAsset: symbol.slice(0, -4),
    onboardDate: NOW - 7 * 24 * 60 * 60_000,
    quoteVolume24h: 1_000_000 * score,
    openInterestNotional: 500_000 * score,
    spreadBps: 20 / Math.max(score, 1),
    tradeCount24h: Math.round(10_000 * score),
    dataComplete: true,
    ...overrides,
  };
}

function observation(input: {
  symbol: string;
  tier?: 'SENTIMENT_CORE' | 'DYNAMIC';
  return5m: number;
  normalizedDelta?: number;
  oiChange5m?: number;
  fundingRate?: number;
  volumeAcceleration?: number;
  longLiquidation?: number;
  shortLiquidation?: number;
}): AltAssetObservation {
  const accumulator = new AltAssetAccumulator(
    input.symbol,
    input.symbol.slice(0, -4),
    input.tier ?? 'DYNAMIC',
  );
  const previousPrice = 100;
  const currentPrice = previousPrice * (1 + input.return5m / 10_000);
  accumulator.recordTrade({
    price: previousPrice,
    quantity: 10,
    buyerIsMaker: false,
    eventAt: NOW - 5 * 60_000,
    receivedAt: NOW - 5 * 60_000,
  });
  const delta = input.normalizedDelta ?? 0;
  const buyQuantity = 10 * (1 + delta);
  const sellQuantity = 10 * (1 - delta);
  accumulator.recordTrade({
    price: currentPrice,
    quantity: buyQuantity,
    buyerIsMaker: false,
    eventAt: NOW - 10_000,
    receivedAt: NOW - 10_000,
  });
  accumulator.recordTrade({
    price: currentPrice,
    quantity: sellQuantity,
    buyerIsMaker: true,
    eventAt: NOW - 5_000,
    receivedAt: NOW - 5_000,
  });
  accumulator.recordTrade({
    price: currentPrice,
    quantity: 1 + (input.volumeAcceleration ?? 0),
    buyerIsMaker: false,
    eventAt: NOW,
    receivedAt: NOW,
  });
  const priorOi = 1_000;
  accumulator.recordOpenInterest({
    value: priorOi,
    observedAt: NOW - 5 * 60_000,
    receivedAt: NOW - 5 * 60_000,
  });
  accumulator.recordOpenInterest({
    value: priorOi * (1 + (input.oiChange5m ?? 0) / 100),
    observedAt: NOW,
    receivedAt: NOW,
  });
  accumulator.recordBook({
    bidPrice: currentPrice - 0.01,
    askPrice: currentPrice + 0.01,
    eventAt: NOW,
    receivedAt: NOW,
  });
  accumulator.recordMark({
    markPrice: currentPrice,
    fundingRate: input.fundingRate ?? 0,
    eventAt: NOW,
    receivedAt: NOW,
  });
  if ((input.longLiquidation ?? 0) > 0)
    accumulator.recordLiquidation({
      side: 'SELL',
      price: currentPrice,
      quantity: (input.longLiquidation ?? 0) / currentPrice,
      eventAt: NOW,
      receivedAt: NOW,
    });
  if ((input.shortLiquidation ?? 0) > 0)
    accumulator.recordLiquidation({
      side: 'BUY',
      price: currentPrice,
      quantity: (input.shortLiquidation ?? 0) / currentPrice,
      eventAt: NOW,
      receivedAt: NOW,
    });
  const snapshot = accumulator.snapshot(NOW);
  if (!snapshot) throw new Error('TEST_OBSERVATION_UNAVAILABLE');
  return snapshot;
}

describe('dynamic basket selection', () => {
  it('scores only non-directional representativeness inputs deterministically', () => {
    const rows = [candidate('AAAUSDT', 1), candidate('BBBUSDT', 2)];
    const first = scoreDynamicBasketCandidates(rows);
    const second = scoreDynamicBasketCandidates([...rows].reverse());
    expect(first).toEqual(second);
    expect(first[0]?.symbol).toBe('BBBUSDT');
    expect(first[0]?.representativenessScore).toBeGreaterThan(
      first[1]?.representativenessScore ?? 0,
    );
  });

  it('respects minimum residence and limits elective churn after residence', () => {
    const initialCandidates = Array.from({ length: 12 }, (_, index) =>
      candidate(`A${String(index).padStart(2, '0')}USDT`, 100 - index),
    );
    const initial = selectDynamicBasket({
      generatedAt: NOW,
      candidates: initialCandidates,
    });
    const challengers = Array.from({ length: 12 }, (_, index) =>
      candidate(`Z${String(index).padStart(2, '0')}USDT`, 1_000 - index),
    );
    const tooSoon = selectDynamicBasket({
      generatedAt: NOW + 10 * 60_000,
      candidates: [...initialCandidates, ...challengers],
      previous: initial,
    });
    expect(tooSoon.members.map((row) => row.symbol).sort()).toEqual(
      initial.members.map((row) => row.symbol).sort(),
    );

    const later = selectDynamicBasket({
      generatedAt: NOW + DYNAMIC_BASKET_MIN_RESIDENCE_MS + 1,
      candidates: [...initialCandidates, ...challengers],
      previous: initial,
    });
    const retained = later.members.filter((member) =>
      initial.members.some((old) => old.symbol === member.symbol),
    );
    expect(initial.members.length - retained.length).toBeLessThanOrEqual(3);
    expect(initial.members.length - retained.length).toBeGreaterThan(0);
  });

  it('removes ineligible members even when churn protection would otherwise keep them', () => {
    const initial = selectDynamicBasket({
      generatedAt: NOW,
      candidates: Array.from({ length: 12 }, (_, index) =>
        candidate(`A${String(index).padStart(2, '0')}USDT`, 100 - index),
      ),
    });
    const removed = initial.members[0]!.symbol;
    const nextCandidates = initial.members
      .filter((member) => member.symbol !== removed)
      .map((member, index) => candidate(member.symbol, 100 - index));
    nextCandidates.push(candidate('NEWUSDT', 50));
    const next = selectDynamicBasket({
      generatedAt: NOW + 60_000,
      candidates: nextCandidates,
      previous: initial,
    });
    expect(next.members.some((member) => member.symbol === removed)).toBe(
      false,
    );
    expect(next.members.some((member) => member.symbol === 'NEWUSDT')).toBe(
      true,
    );
  });
});

describe('dynamic universe scanner', () => {
  it('filters execution/lead assets, stablecoins, tradfi and fresh listings', () => {
    const exchangeInfo = {
      serverTime: NOW,
      symbols: [
        ['BTCUSDT', 'BTC', 'PERPETUAL', 'COIN', NOW - 10 * 24 * 60 * 60_000],
        ['ETHUSDT', 'ETH', 'PERPETUAL', 'COIN', NOW - 10 * 24 * 60 * 60_000],
        ['USDCUSDT', 'USDC', 'PERPETUAL', 'COIN', NOW - 10 * 24 * 60 * 60_000],
        [
          'AAAUSDT',
          'AAA',
          'TRADIFI_PERPETUAL',
          'EQUITY',
          NOW - 10 * 24 * 60 * 60_000,
        ],
        ['NEWUSDT', 'NEW', 'PERPETUAL', 'COIN', NOW - 60_000],
        ['GOODUSDT', 'GOOD', 'PERPETUAL', 'COIN', NOW - 10 * 24 * 60 * 60_000],
      ].map(
        ([symbol, baseAsset, contractType, underlyingType, onboardDate]) => ({
          symbol: String(symbol),
          contractType: String(contractType),
          status: 'TRADING',
          onboardDate: Number(onboardDate),
          baseAsset: String(baseAsset),
          quoteAsset: 'USDT',
          underlyingType: String(underlyingType),
        }),
      ),
    };
    expect(
      eligibleDynamicSymbols(exchangeInfo, NOW).map((row) => row.symbol),
    ).toEqual(['GOODUSDT']);
  });

  it('joins ticker, book and current OI into auditable candidates', async () => {
    const rows = await scanDynamicBasketCandidates(NOW, {
      fetchExchangeInfo: () =>
        Promise.resolve({
          serverTime: NOW,
          symbols: [
            {
              symbol: 'GOODUSDT',
              contractType: 'PERPETUAL',
              status: 'TRADING',
              onboardDate: NOW - 10 * 24 * 60 * 60_000,
              baseAsset: 'GOOD',
              quoteAsset: 'USDT',
              underlyingType: 'COIN',
            },
          ],
        }),
      fetchTickers: () =>
        Promise.resolve([
          {
            symbol: 'GOODUSDT',
            lastPrice: '10',
            quoteVolume: '1000000',
            count: 5000,
          },
        ]),
      fetchBookTickers: () =>
        Promise.resolve([
          {
            symbol: 'GOODUSDT',
            bidPrice: '9.99',
            bidQty: '100',
            askPrice: '10.01',
            askQty: '100',
            time: NOW,
          },
        ]),
      fetchOpenInterest: (symbol) =>
        Promise.resolve({
          symbol,
          openInterest: '100000',
          time: NOW,
        }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.openInterestNotional).toBe(1_000_000);
    expect(rows[0]?.spreadBps).toBeCloseTo(20);
    expect(rows[0]?.dataComplete).toBe(true);
  });
});

describe('alt breadth', () => {
  it('keeps price, delta, OI, funding and liquidation breadth as objective facts', () => {
    const dynamic = [
      observation({
        symbol: 'AAAUSDT',
        return5m: 100,
        normalizedDelta: 0.4,
        oiChange5m: 2,
        fundingRate: 0.0001,
        longLiquidation: 1_000,
      }),
      observation({
        symbol: 'BBBUSDT',
        return5m: -50,
        normalizedDelta: -0.3,
        oiChange5m: -1,
        fundingRate: -0.0001,
        shortLiquidation: 500,
      }),
      observation({
        symbol: 'CCCUSDT',
        return5m: 25,
        normalizedDelta: 0.1,
        oiChange5m: 0.5,
        fundingRate: 0.0002,
      }),
    ];
    const candidates = [
      candidate('AAAUSDT', 3),
      candidate('BBBUSDT', 2),
      candidate('CCCUSDT', 1),
    ];
    const basket = selectDynamicBasket({
      generatedAt: NOW,
      candidates,
      targetSize: 3,
    });
    const intelligence = buildAltMarketIntelligence({
      generatedAt: NOW,
      basket,
      sentimentCore: [],
      dynamic,
      candidates,
      btcReturnsBps: { '5m': 10 },
    });

    expect(intelligence.objectiveOnly).toBe(true);
    expect(intelligence.breadth.price['5m'].validCount).toBe(3);
    expect(intelligence.breadth.price['5m'].advancers).toBe(2);
    expect(intelligence.breadth.price['5m'].decliners).toBe(1);
    expect(intelligence.breadth.price['5m'].medianReturnBps).toBeCloseTo(25);
    expect(intelligence.breadth.delta['5m'].positive).toBeGreaterThan(0);
    expect(intelligence.breadth.openInterest['5m'].positive).toBe(2);
    expect(intelligence.breadth.funding.negative).toBe(1);
    expect(intelligence.breadth.liquidations['5m'].coverage).toBe('SNAPSHOT');
    expect(
      intelligence.relativeStrength.altMedianMinusBtcBps['5m'],
    ).toBeCloseTo(15);
    expect(JSON.stringify(intelligence)).not.toMatch(
      /bullish|bearish|longSignal|shortSignal/i,
    );
  });
});
