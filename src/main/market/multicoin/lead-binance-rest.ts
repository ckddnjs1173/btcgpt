import { z } from 'zod';

import { numericStringSchema } from '../../binance/schemas';
import type { LeadSymbol } from './lead-accumulator';

const BASE = 'https://fapi.binance.com';
const leadSymbolSchema = z.enum(['ETHUSDT', 'SOLUSDT']);
const openInterestSchema = z.object({
  symbol: leadSymbolSchema,
  openInterest: numericStringSchema,
  time: z.number(),
});

export type LeadOpenInterestResponse = z.infer<typeof openInterestSchema>;

async function parseJson<T>(
  response: Response,
  schema: { parse(input: unknown): T },
): Promise<T> {
  if (!response.ok)
    throw new Error(`Binance public API returned HTTP ${response.status}`);
  return schema.parse((await response.json()) as unknown);
}

export async function fetchLeadOpenInterest(
  symbol: LeadSymbol,
): Promise<LeadOpenInterestResponse> {
  const url = new URL('/fapi/v1/openInterest', BASE);
  url.searchParams.set('symbol', symbol);
  return parseJson(
    await fetch(url, { signal: AbortSignal.timeout(5_000) }),
    openInterestSchema,
  );
}
