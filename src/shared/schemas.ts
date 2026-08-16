import { z } from 'zod';

import { structuredTriggerInputSchema } from './trading/structured-trigger';

export const clipboardTextSchema = z
  .string()
  .trim()
  .min(1, '복사할 내용이 없습니다.')
  .max(90_000, '복사할 내용이 너무 깁니다.');

export const databaseCheckInputSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, '저장할 값이 없습니다.')
    .max(200, '테스트 값은 200자 이하여야 합니다.'),
});

const allowedExternalOrigins = new Set(['https://chatgpt.com']);

export const allowedExternalUrlSchema = z
  .url('올바른 URL이 아닙니다.')
  .transform((value, context) => {
    const parsed = new URL(value);

    if (
      parsed.protocol !== 'https:' ||
      !allowedExternalOrigins.has(parsed.origin)
    ) {
      context.addIssue({
        code: 'custom',
        message: '허용되지 않은 외부 URL입니다.',
      });

      return z.NEVER;
    }

    return parsed.toString();
  });

export const accountConfigurationSchema = z.object({
  apiKey: z.string().trim().min(16).max(128),
  apiSecret: z.string().trim().min(16).max(128),
});

export const manualPositionInputSchema = z.object({
  side: z.enum(['LONG', 'SHORT']),
  quantity: z.number().positive().max(100),
  entryPrice: z.number().positive().max(10_000_000),
  leverage: z.number().int().min(1).max(150).default(10),
  stopPrice: z.number().positive().max(10_000_000).nullable().optional(),
  targetPrices: z
    .array(z.number().positive().max(10_000_000))
    .max(3)
    .optional(),
  entryOrderType: z.enum(['MAKER', 'TAKER']).optional(),
  plannedExitOrderType: z.enum(['MAKER', 'TAKER']).optional(),
  openedAt: z.number().int().positive().nullable().optional(),
});

export const manualPositionSchema = z.object({
  source: z.literal('MANUAL'),
  side: z.enum(['LONG', 'SHORT']),
  quantity: z.number().positive(),
  entryPrice: z.number().positive(),
  notional: z.number().positive(),
  isolatedMargin: z.number().positive(),
  leverage: z.number().int().min(1).max(150).default(10),
  marginMode: z.literal('ISOLATED'),
  stopPrice: z.number().positive().nullable(),
  targetPrices: z.array(z.number().positive()).max(3),
  entryOrderType: z.enum(['MAKER', 'TAKER']),
  plannedExitOrderType: z.enum(['MAKER', 'TAKER']),
  openedAt: z.number().int().positive().nullable(),
  updatedAt: z.number().int().positive(),
});

export const userSettingsSchema = z.object({
  gptUrl: allowedExternalUrlSchema,
  makerFeeRate: z.number().min(0).max(0.01).nullable(),
  takerFeeRate: z.number().min(0).max(0.01).nullable(),
  entrySlippageBps: z.number().min(0).max(1_000).nullable(),
  exitSlippageBps: z.number().min(0).max(1_000).nullable(),
  maxLossUsdt: z.number().positive().max(10_000_000).nullable(),
  riskPercent: z.number().positive().max(1).nullable(),
  partialTakeProfitRatios: z
    .tuple([z.number().min(0), z.number().min(0), z.number().min(0)])
    .refine(
      (values) =>
        Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-8,
      'Partial take-profit ratios must sum to 1',
    ),
  minimumNetMarginRoiPercent: z.literal(2),
  autoStart: z.boolean(),
  tradingMode: z.enum(['PAPER', 'LIVE_MANUAL']).default('PAPER'),
  defaultLeverage: z.number().int().min(1).max(150).default(10),
});

export const positionCalculationInputSchema = z.object({
  side: z.enum(['LONG', 'SHORT']),
  entry: z.number().positive().max(10_000_000),
  stop: z.number().positive().max(10_000_000),
  target: z.number().positive().max(10_000_000),
  leverage: z.number().int().min(1).max(150).default(10),
  sizeMode: z
    .enum(['MARGIN_USDT', 'QUANTITY_BTC', 'NOTIONAL_USDT', 'MAX_LOSS_USDT'])
    .default('MAX_LOSS_USDT'),
  sizeValue: z.number().positive().max(1_000_000_000).optional(),
  maxLossUsdt: z.number().positive().nullable().optional(),
  accountEquity: z.number().positive().nullable().optional(),
  riskPercent: z.number().positive().max(1).nullable().optional(),
  entryOrderType: z.enum(['MAKER', 'TAKER']).optional(),
  exitOrderType: z.enum(['MAKER', 'TAKER']).optional(),
  expectedFundingPeriods: z.number().int().min(0).max(90).default(1),
});

export const lockTradePlanInputSchema = positionCalculationInputSchema.extend({
  targets: z
    .array(z.number().positive().max(10_000_000))
    .min(1)
    .max(3)
    .optional(),
  trigger: structuredTriggerInputSchema.optional(),
});

export const paperCloseInputSchema = z.object({
  quantity: z.number().positive().max(100).optional(),
  exitPrice: z.number().positive().max(10_000_000).optional(),
});

export const relayConfigurationSchema = z.object({
  baseUrl: z.url().transform((value, context) => {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.port !== '' ||
      !parsed.hostname.endsWith('.workers.dev')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Relay must be an HTTPS workers.dev URL on port 443',
      });
      return z.NEVER;
    }
    return parsed.origin;
  }),
  uploadKey: z.string().min(32).max(256),
});

export const naverConfigurationSchema = z.object({
  clientId: z.string().trim().min(8).max(100),
  clientSecret: z.string().trim().min(8).max(200),
});
