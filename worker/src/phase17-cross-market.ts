import type { Env } from './index';

const CROSS_MARKET_VERSION = 'cross-market-v1';
const CACHE_TTL_MS = 20_000;
const FALLBACK_MAX_AGE_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 2_500;
const ASSETS = ['BTC', 'ETH', 'SOL'] as const;

type Asset = (typeof ASSETS)[number];
type RecordLike = Record<string, unknown>;

type VenueQuote = {
  venue: 'BINANCE_USDM' | 'COINBASE_SPOT';
  symbol: string;
  lastPrice: number | null;
  return24hPercent: number | null;
  volume24h: number | null;
  quoteVolume24h: number | null;
  observedAt: number;
};

type SourceStatus = {
  status: 'NORMAL' | 'PARTIAL' | 'UNAVAILABLE' | 'CACHED';
  observedAt: number | null;
  errorCount: number;
};

export type CrossMarketContext = {
  version: typeof CROSS_MARKET_VERSION;
  generatedAt: number;
  cacheAgeMs: number;
  sources: {
    binanceUsdm: SourceStatus;
    coinbaseSpot: SourceStatus;
  };
  assets: Record<
    Asset,
    {
      binanceUsdm: VenueQuote | null;
      coinbaseSpot: VenueQuote | null;
      crossVenueSpreadBps: number | null;
    }
  >;
  relativePerformance24h: {
    ethMinusBtcPercentPoints: number | null;
    solMinusBtcPercentPoints: number | null;
    coinbaseEthMinusBtcPercentPoints: number | null;
    coinbaseSolMinusBtcPercentPoints: number | null;
  };
  completeness: number;
};

type CachedRow = {
  payload: string;
  generatedAt: number;
};

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function ratioBps(
  numerator: number | null,
  denominator: number | null,
): number | null {
  if (
    numerator === null ||
    denominator === null ||
    denominator <= 0 ||
    numerator <= 0
  )
    return null;
  return ((numerator - denominator) / denominator) * 10_000;
}

function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
      'user-agent': 'btc-futures-assistant/phase17',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json() as Promise<unknown>;
}

async function fetchBinance(
  asset: Asset,
  observedAt: number,
): Promise<VenueQuote> {
  const symbol = `${asset}USDT`;
  const raw = asRecord(
    await getJson(
      `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`,
    ),
  );
  if (!raw) throw new Error('BINANCE_INVALID_RESPONSE');
  return {
    venue: 'BINANCE_USDM',
    symbol,
    lastPrice: finiteNumber(raw.lastPrice),
    return24hPercent: finiteNumber(raw.priceChangePercent),
    volume24h: finiteNumber(raw.volume),
    quoteVolume24h: finiteNumber(raw.quoteVolume),
    observedAt,
  };
}

async function fetchCoinbase(
  asset: Asset,
  observedAt: number,
): Promise<VenueQuote> {
  const symbol = `${asset}-USD`;
  const raw = asRecord(
    await getJson(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/stats`,
    ),
  );
  if (!raw) throw new Error('COINBASE_INVALID_RESPONSE');
  const open = finiteNumber(raw.open);
  const last = finiteNumber(raw.last);
  const return24hPercent =
    open !== null && last !== null && open > 0
      ? ((last - open) / open) * 100
      : null;
  return {
    venue: 'COINBASE_SPOT',
    symbol,
    lastPrice: last,
    return24hPercent,
    volume24h: finiteNumber(raw.volume),
    quoteVolume24h: null,
    observedAt,
  };
}

function sourceStatus(
  values: Array<VenueQuote | null>,
  observedAt: number,
): SourceStatus {
  const successCount = values.filter(Boolean).length;
  return {
    status:
      successCount === values.length
        ? 'NORMAL'
        : successCount > 0
          ? 'PARTIAL'
          : 'UNAVAILABLE',
    observedAt: successCount > 0 ? observedAt : null,
    errorCount: values.length - successCount,
  };
}

export function buildCrossMarketContext(input: {
  generatedAt: number;
  binance: Partial<Record<Asset, VenueQuote | null>>;
  coinbase: Partial<Record<Asset, VenueQuote | null>>;
  cacheAgeMs?: number;
}): CrossMarketContext {
  const binance = Object.fromEntries(
    ASSETS.map((asset) => [asset, input.binance[asset] ?? null]),
  ) as Record<Asset, VenueQuote | null>;
  const coinbase = Object.fromEntries(
    ASSETS.map((asset) => [asset, input.coinbase[asset] ?? null]),
  ) as Record<Asset, VenueQuote | null>;
  const observedAt = input.generatedAt;
  const totalSlots = ASSETS.length * 2;
  const populated = [
    ...Object.values(binance),
    ...Object.values(coinbase),
  ].filter(Boolean).length;

  return {
    version: CROSS_MARKET_VERSION,
    generatedAt: input.generatedAt,
    cacheAgeMs: input.cacheAgeMs ?? 0,
    sources: {
      binanceUsdm: sourceStatus(Object.values(binance), observedAt),
      coinbaseSpot: sourceStatus(Object.values(coinbase), observedAt),
    },
    assets: {
      BTC: {
        binanceUsdm: binance.BTC,
        coinbaseSpot: coinbase.BTC,
        crossVenueSpreadBps: ratioBps(
          coinbase.BTC?.lastPrice ?? null,
          binance.BTC?.lastPrice ?? null,
        ),
      },
      ETH: {
        binanceUsdm: binance.ETH,
        coinbaseSpot: coinbase.ETH,
        crossVenueSpreadBps: ratioBps(
          coinbase.ETH?.lastPrice ?? null,
          binance.ETH?.lastPrice ?? null,
        ),
      },
      SOL: {
        binanceUsdm: binance.SOL,
        coinbaseSpot: coinbase.SOL,
        crossVenueSpreadBps: ratioBps(
          coinbase.SOL?.lastPrice ?? null,
          binance.SOL?.lastPrice ?? null,
        ),
      },
    },
    relativePerformance24h: {
      ethMinusBtcPercentPoints: difference(
        binance.ETH?.return24hPercent ?? null,
        binance.BTC?.return24hPercent ?? null,
      ),
      solMinusBtcPercentPoints: difference(
        binance.SOL?.return24hPercent ?? null,
        binance.BTC?.return24hPercent ?? null,
      ),
      coinbaseEthMinusBtcPercentPoints: difference(
        coinbase.ETH?.return24hPercent ?? null,
        coinbase.BTC?.return24hPercent ?? null,
      ),
      coinbaseSolMinusBtcPercentPoints: difference(
        coinbase.SOL?.return24hPercent ?? null,
        coinbase.BTC?.return24hPercent ?? null,
      ),
    },
    completeness: populated / totalSlots,
  };
}

async function loadCached(env: Env): Promise<CachedRow | null> {
  if (!env.DB) return null;
  try {
    return await env.DB.prepare(
      `SELECT payload, generated_at AS generatedAt
       FROM cross_market_latest WHERE id = 1`,
    ).first<CachedRow>();
  } catch {
    return null;
  }
}

async function saveCached(
  env: Env,
  context: CrossMarketContext,
  receivedAt: number,
): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO cross_market_latest (id, payload, generated_at, received_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload=excluded.payload,
         generated_at=excluded.generated_at,
         received_at=excluded.received_at
       WHERE excluded.generated_at >= cross_market_latest.generated_at`,
    )
      .bind(JSON.stringify(context), context.generatedAt, receivedAt)
      .run();
  } catch {
    // Cross-market data is optional enrichment and must not block live analysis.
  }
}

function cachedContext(row: CachedRow, now: number): CrossMarketContext | null {
  try {
    const parsed = JSON.parse(row.payload) as CrossMarketContext;
    return {
      ...parsed,
      cacheAgeMs: Math.max(0, now - row.generatedAt),
      sources: {
        binanceUsdm: {
          ...parsed.sources.binanceUsdm,
          status: 'CACHED',
        },
        coinbaseSpot: {
          ...parsed.sources.coinbaseSpot,
          status: 'CACHED',
        },
      },
    };
  } catch {
    return null;
  }
}

export async function getCrossMarketContext(
  env: Env,
  now = Date.now(),
): Promise<CrossMarketContext> {
  const cached = await loadCached(env);
  if (cached && now - cached.generatedAt <= CACHE_TTL_MS) {
    const parsed = cachedContext(cached, now);
    if (parsed) return parsed;
  }

  const binanceSettled = await Promise.allSettled(
    ASSETS.map((asset) => fetchBinance(asset, now)),
  );
  const coinbaseSettled = await Promise.allSettled(
    ASSETS.map((asset) => fetchCoinbase(asset, now)),
  );
  const binance = Object.fromEntries(
    ASSETS.map((asset, index) => [
      asset,
      binanceSettled[index]?.status === 'fulfilled'
        ? binanceSettled[index].value
        : null,
    ]),
  ) as Partial<Record<Asset, VenueQuote | null>>;
  const coinbase = Object.fromEntries(
    ASSETS.map((asset, index) => [
      asset,
      coinbaseSettled[index]?.status === 'fulfilled'
        ? coinbaseSettled[index].value
        : null,
    ]),
  ) as Partial<Record<Asset, VenueQuote | null>>;

  const fresh = buildCrossMarketContext({
    generatedAt: now,
    binance,
    coinbase,
  });
  if (fresh.completeness > 0) {
    await saveCached(env, fresh, Date.now());
    return fresh;
  }

  if (cached && now - cached.generatedAt <= FALLBACK_MAX_AGE_MS) {
    const parsed = cachedContext(cached, now);
    if (parsed) return parsed;
  }
  return fresh;
}
