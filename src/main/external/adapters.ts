import { createHash } from 'node:crypto';
import { z } from 'zod';

import type {
  ExternalContextCategory,
  ExternalContextItem,
  TrustTier,
} from '../../shared/contracts';

const REQUEST_TIMEOUT_MS = 10_000;
const jsonRecord = z.record(z.string(), z.unknown());

function textValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function clean(value: string, limit: number): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function stableId(source: string, title: string, publishedAt: number): string {
  return createHash('sha256')
    .update(`${source}|${title.toLowerCase()}|${publishedAt}`)
    .digest('hex')
    .slice(0, 24);
}

function relevance(text: string): 'HIGH' | 'MEDIUM' | 'LOW' {
  const normalized = text.toLowerCase();
  if (/\b(bitcoin|btc|crypto|binance|spot etf)\b/.test(normalized)) return 'HIGH';
  if (/\b(fomc|cpi|inflation|interest rate|employment|futures|derivative)\b/.test(normalized))
    return 'MEDIUM';
  return 'LOW';
}

export function item(
  source: string,
  category: ExternalContextCategory,
  title: string,
  url: string,
  publishedAt: number,
  observedAt: number,
  trustTier: TrustTier,
  snippet: string | null = null,
  tags: string[] = [],
): ExternalContextItem {
  const safeTitle = clean(title, 240);
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') throw new Error('EXTERNAL_URL_NOT_HTTPS');
  if (publishedAt > observedAt + 5 * 60_000) throw new Error('FUTURE_PUBLISHED_AT');
  return {
    id: stableId(source, safeTitle, publishedAt),
    source,
    category,
    title: safeTitle,
    snippet: snippet ? clean(snippet, 500) : null,
    url: parsedUrl.toString(),
    publishedAt,
    observedAt,
    language: null,
    trustTier,
    btcRelevance: relevance(`${safeTitle} ${snippet ?? ''}`),
    duplicateGroupId: null,
    duplicateCount: 1,
    tags: [...new Set(tags.map((tag) => clean(tag, 40)).filter(Boolean))].slice(0, 12),
  };
}

async function getJson(url: string, headers?: HeadersInit): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json() as Promise<unknown>;
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'BTC Futures Assistant/0.2 contact: local-user' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.text();
}

function xmlValue(block: string, names: string[]): string | null {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match?.[1]) return clean(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, ''), 2_000);
  }
  return null;
}

export async function fetchRss(
  source: string,
  category: ExternalContextCategory,
  url: string,
): Promise<ExternalContextItem[]> {
  const observedAt = Date.now();
  const xml = await getText(url);
  return [...xml.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)]
    .slice(0, 40)
    .flatMap((match) => {
      const block = match[0];
      const title = xmlValue(block, ['title']);
      const link =
        block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ??
        xmlValue(block, ['link']);
      const date = xmlValue(block, ['pubDate', 'published', 'updated']);
      if (!title || !link || !date) return [];
      const publishedAt = Date.parse(date);
      if (!Number.isFinite(publishedAt)) return [];
      try {
        return [
          item(
            source,
            category,
            title,
            link,
            publishedAt,
            observedAt,
            'OFFICIAL',
            xmlValue(block, ['description', 'summary']),
          ),
        ];
      } catch {
        return [];
      }
    });
}

export const sourceAdapters = {
  async deribit(): Promise<ExternalContextItem[]> {
    const observedAt = Date.now();
    const raw = jsonRecord.parse(
      await getJson(
        'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
      ),
    );
    const rows = z.array(jsonRecord).parse(raw.result);
    const totalOi = rows.reduce((sum, row) => sum + Number(row.open_interest ?? 0), 0);
    const ivs = rows.map((row) => Number(row.mark_iv)).filter(Number.isFinite);
    const averageIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
    return [
      item(
        'DERIBIT',
        'OPTIONS',
        `BTC options summary: OI ${totalOi.toFixed(2)} BTC${averageIv === null ? '' : `, average IV ${averageIv.toFixed(2)}`}`,
        'https://www.deribit.com/statistics/BTC/options-data',
        observedAt,
        observedAt,
        'OFFICIAL',
        'Public option book summaries; not a directional signal.',
        ['options', 'open-interest', 'implied-volatility'],
      ),
    ];
  },
  async mempool(): Promise<ExternalContextItem[]> {
    const observedAt = Date.now();
    const [fees, mempool] = await Promise.all([
      getJson('https://mempool.space/api/v1/fees/recommended'),
      getJson('https://mempool.space/api/mempool'),
    ]);
    const fee = jsonRecord.parse(fees);
    const state = jsonRecord.parse(mempool);
    return [
      item(
        'MEMPOOL_SPACE',
        'ONCHAIN',
        `Bitcoin mempool ${Number(state.count ?? 0)} transactions; fastest fee ${Number(fee.fastestFee ?? 0)} sat/vB`,
        'https://mempool.space/',
        observedAt,
        observedAt,
        'OFFICIAL',
        `Mempool virtual size ${Number(state.vsize ?? 0)} bytes.`,
        ['mempool', 'fees'],
      ),
    ];
  },
  async coinMetrics(): Promise<ExternalContextItem[]> {
    const observedAt = Date.now();
    const raw = jsonRecord.parse(
      await getJson(
        'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=AdrActCnt,TxCnt,FeeTotNtv&frequency=1d&page_size=2',
      ),
    );
    const rows = z.array(jsonRecord).parse(raw.data);
    const latest = rows.at(-1);
    if (!latest) return [];
    const publishedAt = Date.parse(textValue(latest.time));
    return [
      item(
        'COIN_METRICS_COMMUNITY',
        'ONCHAIN',
        `BTC daily network activity: ${Number(latest.AdrActCnt ?? 0)} active addresses, ${Number(latest.TxCnt ?? 0)} transactions`,
        'https://charts.coinmetrics.io/network-data/',
        Number.isFinite(publishedAt) ? publishedAt : observedAt,
        observedAt,
        'OFFICIAL',
        `Community API daily total fees: ${Number(latest.FeeTotNtv ?? 0)} BTC.`,
        ['network', 'activity', 'fees'],
      ),
    ];
  },
  async fearAndGreed(): Promise<ExternalContextItem[]> {
    const observedAt = Date.now();
    const raw = jsonRecord.parse(await getJson('https://api.alternative.me/fng/?limit=1&format=json'));
    const latest = z.array(jsonRecord).parse(raw.data)[0];
    if (!latest) return [];
    const at = Number(latest.timestamp) * 1_000;
    return [
      item(
        'ALTERNATIVE_ME',
        'SENTIMENT',
        `Fear & Greed: ${String(latest.value)} (${String(latest.value_classification)})`,
        'https://alternative.me/crypto/fear-and-greed-index/',
        Number.isFinite(at) ? at : observedAt,
        observedAt,
        'SINGLE_SOURCE',
        'Third-party sentiment index value and classification.',
        ['fear-greed'],
      ),
    ];
  },
  async gdelt(): Promise<ExternalContextItem[]> {
    const observedAt = Date.now();
    const url =
      'https://api.gdeltproject.org/api/v2/doc/doc?query=(bitcoin%20OR%20btc%20OR%20binance)%20sourcelang:english&mode=artlist&maxrecords=50&format=json&sort=datedesc';
    const raw = jsonRecord.parse(await getJson(url));
    return z.array(jsonRecord).parse(raw.articles ?? []).flatMap((row) => {
      const publishedAt = Date.parse(textValue(row.seendate));
      try {
        return [
          item(
            'GDELT',
            'NEWS',
            textValue(row.title),
            textValue(row.url),
            Number.isFinite(publishedAt) ? publishedAt : observedAt,
            observedAt,
            'SINGLE_SOURCE',
            null,
            ['news'],
          ),
        ];
      } catch {
        return [];
      }
    });
  },
  async naver(clientId?: string, clientSecret?: string): Promise<ExternalContextItem[]> {
    if (!clientId || !clientSecret) return [];
    const observedAt = Date.now();
    const raw = jsonRecord.parse(
      await getJson(
        'https://openapi.naver.com/v1/search/news.json?query=%EB%B9%84%ED%8A%B8%EC%BD%94%EC%9D%B8&display=50&sort=date',
        { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
      ),
    );
    return z.array(jsonRecord).parse(raw.items).flatMap((row) => {
      try {
        return [
          item(
            'NAVER_NEWS',
            'NEWS',
            textValue(row.title),
            textValue(row.originallink) || textValue(row.link),
            Date.parse(textValue(row.pubDate)),
            observedAt,
            'SINGLE_SOURCE',
            textValue(row.description),
            ['news', 'ko'],
          ),
        ];
      } catch {
        return [];
      }
    });
  },
};

export const officialFeeds = [
  ['FED', 'MACRO', 'https://www.federalreserve.gov/feeds/press_all.xml'],
  ['SEC', 'REGULATION', 'https://www.sec.gov/news/pressreleases.rss'],
  ['CFTC', 'REGULATION', 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml'],
  ['BLS', 'MACRO', 'https://www.bls.gov/feed/bls_latest.rss'],
] as const;
