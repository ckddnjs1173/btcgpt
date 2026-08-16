import { describe, expect, it } from 'vitest';

import type { DynamicBasketCandidate } from '../../src/shared/alt-market-intelligence';
import { AltMarketService } from '../../src/main/market/multicoin/alt-service';

const NOW = 1_800_000_000_000;

function candidate(symbol: string, rank: number): DynamicBasketCandidate {
  return {
    symbol,
    baseAsset: symbol.slice(0, -4),
    onboardDate: NOW - 7 * 24 * 60 * 60_000,
    quoteVolume24h: rank * 1_000_000,
    openInterestNotional: rank * 500_000,
    spreadBps: 10 / rank,
    tradeCount24h: rank * 10_000,
    dataComplete: true,
  };
}

function ingestMarketFacts(
  service: AltMarketService,
  symbol: string,
  price: number,
): void {
  service.ingestRecordedMessage(
    JSON.stringify({
      stream: `${symbol.toLowerCase()}@bookTicker`,
      data: {
        E: NOW,
        T: NOW,
        s: symbol,
        b: String(price - 0.01),
        a: String(price + 0.01),
      },
    }),
    NOW,
  );
  service.ingestRecordedMessage(
    JSON.stringify({
      stream: `${symbol.toLowerCase()}@aggTrade`,
      data: {
        E: NOW,
        s: symbol,
        p: String(price),
        q: '10',
        T: NOW,
        m: false,
      },
    }),
    NOW,
  );
  service.ingestRecordedMessage(
    JSON.stringify({
      stream: `${symbol.toLowerCase()}@markPrice@1s`,
      data: {
        E: NOW,
        s: symbol,
        p: String(price),
        r: '0.0001',
      },
    }),
    NOW,
  );
}

describe('AltMarketService', () => {
  it('keeps fixed sentiment assets separate from the dynamic representative basket', () => {
    const service = new AltMarketService({ now: () => NOW });
    service.applyCandidatesForTest(
      [
        candidate('BNBUSDT', 100),
        candidate('AAAUSDT', 90),
        candidate('BBBUSDT', 80),
      ],
      NOW,
    );

    const basket = service.getBasket();
    expect(basket?.members.map((member) => member.symbol)).toEqual([
      'AAAUSDT',
      'BBBUSDT',
    ]);
    expect(basket?.members.some((member) => member.symbol === 'BNBUSDT')).toBe(
      false,
    );
  });

  it('parses active fixed and dynamic symbols into objective intelligence', () => {
    const service = new AltMarketService({ now: () => NOW });
    service.applyCandidatesForTest(
      [candidate('AAAUSDT', 90), candidate('BBBUSDT', 80)],
      NOW,
    );
    ingestMarketFacts(service, 'BNBUSDT', 600);
    ingestMarketFacts(service, 'AAAUSDT', 10);
    ingestMarketFacts(service, 'BBBUSDT', 20);
    service.ingestRecordedMessage(
      JSON.stringify({
        stream: 'aaausdt@forceOrder',
        data: {
          E: NOW,
          o: {
            s: 'AAAUSDT',
            S: 'SELL',
            q: '5',
            ap: '10',
            p: '10',
            T: NOW,
          },
        },
      }),
      NOW,
    );

    const observations = service.getObservations(NOW);
    expect(
      observations.sentimentCore.some((row) => row.symbol === 'BNBUSDT'),
    ).toBe(true);
    expect(observations.dynamic.map((row) => row.symbol)).toEqual([
      'AAAUSDT',
      'BBBUSDT',
    ]);

    const intelligence = service.buildIntelligence({ '5m': 0 }, NOW);
    expect(intelligence?.objectiveOnly).toBe(true);
    expect(intelligence?.dynamic).toHaveLength(2);
    expect(intelligence?.breadth.liquidations['5m'].coverage).toBe('SNAPSHOT');
    expect(JSON.stringify(intelligence)).not.toMatch(
      /buySignal|sellSignal|longSignal|shortSignal|bullishScore|bearishScore/i,
    );

    for (const health of service.getEvidenceHealth(NOW)) {
      expect(health.requiredForEntry).toBe(false);
    }
  });

  it('rejects symbols outside the fixed or current dynamic universe', () => {
    const service = new AltMarketService({ now: () => NOW });
    service.applyCandidatesForTest([candidate('AAAUSDT', 90)], NOW);

    expect(() => ingestMarketFacts(service, 'ZZZUSDT', 1)).toThrow(
      'INACTIVE_ALT_SYMBOL:ZZZUSDT',
    );
  });
});
