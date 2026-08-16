import type { MarketSnapshot } from '../../../shared/contracts';
import {
  buildLocalMarketIntelligence,
  type LocalMarketIntelligence,
} from '../../../shared/decision-context';
import type { AltMarketService } from '../multicoin/alt-service';
import type { LeadCoreMarketService } from '../multicoin/lead-service';

export function buildLocalDecisionMarketIntelligence(input: {
  snapshot: MarketSnapshot;
  leadCoreMarket: LeadCoreMarketService;
  altMarket: AltMarketService;
}): LocalMarketIntelligence {
  const generatedAt = input.snapshot.generatedAt;
  const leadCore = input.leadCoreMarket.getObservations(generatedAt);
  const altMarket = input.altMarket.buildIntelligence(
    {
      '1m': input.snapshot.orderFlow['1m'].priceChangeBps,
      '3m': input.snapshot.orderFlow['3m'].priceChangeBps,
      '5m': input.snapshot.orderFlow['5m'].priceChangeBps,
      '15m': input.snapshot.orderFlow['15m'].priceChangeBps,
      '1h': input.snapshot.orderFlow['1h'].priceChangeBps,
    },
    generatedAt,
  );

  return buildLocalMarketIntelligence({
    generatedAt,
    leadCore,
    altMarket,
    evidenceHealth: [
      ...input.leadCoreMarket.getEvidenceHealth(generatedAt),
      ...input.altMarket.getEvidenceHealth(generatedAt),
    ],
  });
}
