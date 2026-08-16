import type { MarketSnapshot } from '../../../shared/contracts';
import {
  buildLocalMarketIntelligence,
  type LocalMarketIntelligence,
} from '../../../shared/decision-context';
import type { CoinbaseSpotMarketService } from '../cross-venue/coinbase-spot-service';
import type { AltMarketService } from '../multicoin/alt-service';
import type { LeadCoreMarketService } from '../multicoin/lead-service';
import { buildCrossVenueIntelligence } from './cross-venue';

export function buildLocalDecisionMarketIntelligence(input: {
  snapshot: MarketSnapshot;
  leadCoreMarket: LeadCoreMarketService;
  altMarket: AltMarketService;
  coinbaseSpotMarket: CoinbaseSpotMarketService;
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
  const coinbase = input.coinbaseSpotMarket.getObservations(generatedAt);
  const crossVenue = buildCrossVenueIntelligence({
    snapshot: input.snapshot,
    lead: leadCore,
    coinbase,
  });

  return buildLocalMarketIntelligence({
    generatedAt,
    leadCore,
    altMarket,
    crossVenue,
    evidenceHealth: [
      ...input.leadCoreMarket.getEvidenceHealth(generatedAt),
      ...input.altMarket.getEvidenceHealth(generatedAt),
      ...input.coinbaseSpotMarket.getEvidenceHealth(generatedAt),
    ],
  });
}