import { z } from 'zod';

import type { ExternalContextItem } from '../../shared/contracts';
import type { DataProvenance } from '../../shared/market-intelligence';
import {
  ONCHAIN_INTELLIGENCE_VERSION,
  mempoolObservationSchema,
  networkDailyObservationSchema,
  onchainIntelligenceV1Schema,
  type MempoolObservation,
  type NetworkDailyObservation,
  type OnchainIntelligenceV1,
} from '../../shared/onchain-intelligence';
import { buildDataProvenance } from '../market/intelligence/provenance';
import { item } from './adapters';

const REQUEST_TIMEOUT_MS = 10_000;
const jsonRecord = z.record(z.string(), z.unknown());

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ONCHAIN_HTTP_${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function fetchMempoolObservation(
  observedAt = Date.now(),
): Promise<{ observation: MempoolObservation; item: ExternalContextItem }> {
  const [feesRaw, mempoolRaw] = await Promise.all([
    getJson('https://mempool.space/api/v1/fees/recommended'),
    getJson('https://mempool.space/api/mempool'),
  ]);
  const fees = jsonRecord.parse(feesRaw);
  const mempool = jsonRecord.parse(mempoolRaw);
  const observation = mempoolObservationSchema.parse({
    observedAt,
    transactionCount: integerOrNull(mempool.count),
    virtualSizeBytes: integerOrNull(mempool.vsize),
    totalFeeSats: numberOrNull(mempool.total_fee),
    recommendedFees: {
      fastestFeeSatVb: numberOrNull(fees.fastestFee),
      halfHourFeeSatVb: numberOrNull(fees.halfHourFee),
      hourFeeSatVb: numberOrNull(fees.hourFee),
      economyFeeSatVb: numberOrNull(fees.economyFee),
      minimumFeeSatVb: numberOrNull(fees.minimumFee),
    },
  });
  const count =
    observation.transactionCount === null
      ? 'unknown backlog'
      : `${observation.transactionCount} transactions`;
  const fastest = observation.recommendedFees.fastestFeeSatVb;
  return {
    observation,
    item: item(
      'MEMPOOL_SPACE',
      'ONCHAIN',
      `Bitcoin mempool: ${count}${fastest === null ? '' : `; fastest fee ${fastest} sat/vB`}`,
      'https://mempool.space/',
      observedAt,
      observedAt,
      'OFFICIAL',
      'Current mempool backlog and fee recommendation snapshot; not a guaranteed confirmation time or trading signal.',
      ['mempool', 'fees', 'onchain-v1'],
    ),
  };
}

export async function fetchCoinMetricsDailyObservation(
  observedAt = Date.now(),
): Promise<{
  observation: NetworkDailyObservation;
  item: ExternalContextItem;
}> {
  const raw = jsonRecord.parse(
    await getJson(
      'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=AdrActCnt,TxCnt,FeeTotNtv&frequency=1d&page_size=2',
    ),
  );
  const rows = z.array(jsonRecord).parse(raw.data);
  const latest = rows.at(-1);
  if (!latest) throw new Error('COIN_METRICS_NO_DATA');
  const periodText =
    typeof latest.time === 'string' || typeof latest.time === 'number'
      ? String(latest.time)
      : '';
  const periodAt = Date.parse(periodText);
  if (!Number.isFinite(periodAt)) throw new Error('COIN_METRICS_TIME_INVALID');
  const observation = networkDailyObservationSchema.parse({
    periodAt,
    observedAt,
    activeAddressCount: numberOrNull(latest.AdrActCnt),
    transactionCount: numberOrNull(latest.TxCnt),
    totalFeesBtc: numberOrNull(latest.FeeTotNtv),
    // Community history is treated conservatively as revision-capable evidence.
    // Replay freezes the exact decision-time payload before research use.
    metricNature: 'REVISED',
  });
  const addresses =
    observation.activeAddressCount === null
      ? 'active addresses n/a'
      : `${observation.activeAddressCount} active addresses`;
  const transactions =
    observation.transactionCount === null
      ? 'transactions n/a'
      : `${observation.transactionCount} transactions`;
  return {
    observation,
    item: item(
      'COIN_METRICS_COMMUNITY',
      'ONCHAIN',
      `BTC daily network activity: ${addresses}, ${transactions}`,
      'https://charts.coinmetrics.io/network-data/',
      periodAt,
      observedAt,
      'OFFICIAL',
      observation.totalFeesBtc === null
        ? 'Coin Metrics Community daily metric snapshot.'
        : `Daily total fees ${observation.totalFeesBtc} BTC.`,
      ['network', 'activity', 'fees', 'onchain-v1'],
    ),
  };
}

function provenance(input: {
  now: number;
  mempool: MempoolObservation | null;
  networkDaily: NetworkDailyObservation | null;
}): DataProvenance[] {
  const rows: DataProvenance[] = [];
  if (input.mempool) {
    rows.push(
      buildDataProvenance({
        source: 'MEMPOOL_SPACE',
        venue: null,
        instrument: 'BTC_MEMPOOL',
        sourceEventAt: null,
        collectorReceivedAt: input.mempool.observedAt,
        generatedAt: input.now,
        metricNature: 'OBSERVED',
        coverage: 'SNAPSHOT',
        status: 'NORMAL',
        now: input.now,
      }),
    );
  }
  if (input.networkDaily) {
    rows.push(
      buildDataProvenance({
        source: 'COIN_METRICS_COMMUNITY',
        venue: null,
        instrument: 'BTC_NETWORK_DAILY',
        // The metric period is carried separately. It is not labeled as
        // transport/event latency because daily history may later be revised.
        sourceEventAt: null,
        collectorReceivedAt: input.networkDaily.observedAt,
        generatedAt: input.now,
        metricNature: 'REVISED',
        coverage: 'SNAPSHOT',
        status: 'NORMAL',
        now: input.now,
      }),
    );
  }
  return rows;
}

export function buildOnchainIntelligenceV1(input: {
  now: number;
  mempool: MempoolObservation | null;
  networkDaily: NetworkDailyObservation | null;
}): OnchainIntelligenceV1 | null {
  if (!input.mempool && !input.networkDaily) return null;
  return onchainIntelligenceV1Schema.parse({
    version: ONCHAIN_INTELLIGENCE_VERSION,
    generatedAt: input.now,
    objectiveOnly: true,
    role: 'BACKGROUND_REGIME_ONLY',
    mempool: input.mempool,
    networkDaily: input.networkDaily,
    health: {
      mempoolCollectionAgeMs:
        input.mempool === null
          ? null
          : Math.max(0, Math.trunc(input.now - input.mempool.observedAt)),
      networkDailyCollectionAgeMs:
        input.networkDaily === null
          ? null
          : Math.max(0, Math.trunc(input.now - input.networkDaily.observedAt)),
      networkDailyPeriodAgeMs:
        input.networkDaily === null
          ? null
          : Math.max(0, Math.trunc(input.now - input.networkDaily.periodAt)),
    },
    provenance: provenance(input),
  });
}
