import { z } from 'zod';

export const approvedPlanPriceConditionSchema = z.enum([
  'AT_OR_ABOVE',
  'AT_OR_BELOW',
]);
export type ApprovedPlanPriceCondition = z.infer<
  typeof approvedPlanPriceConditionSchema
>;

export const structuredTriggerTypeSchema = z.enum([
  'PRICE_CROSS',
  'PRICE_RECLAIM',
  'BREAKOUT_CONFIRM',
  'PULLBACK_HOLD',
]);
export type StructuredTriggerType = z.infer<typeof structuredTriggerTypeSchema>;

export const structuredTriggerInputSchema = z
  .object({
    authoredBy: z.literal('GPT'),
    triggerId: z.string().trim().min(1).max(100),
    decisionId: z.string().trim().min(1).max(100),
    sourceSnapshotId: z.string().trim().min(1).max(100),
    triggerType: structuredTriggerTypeSchema,
    referencePrice: z.literal('MARK_PRICE').default('MARK_PRICE'),
    triggerCondition: approvedPlanPriceConditionSchema,
    triggerPrice: z.number().positive().max(10_000_000),
    confirmWindowSec: z.number().int().min(0).max(300).default(0),
    invalidationCondition: approvedPlanPriceConditionSchema,
    invalidationPrice: z.number().positive().max(10_000_000),
    expiresAt: z.number().int().positive(),
    maxChaseBps: z.number().min(0).max(1_000).default(0),
  })
  .strict();
export type StructuredTriggerInput = z.infer<
  typeof structuredTriggerInputSchema
>;

export type ApprovedPlanMonitoringState =
  'ARMED' | 'WATCHING' | 'TRIGGERED' | 'INVALIDATED' | 'EXPIRED' | 'CANCELLED';

export interface ApprovedPlanMonitoring extends StructuredTriggerInput {
  state: ApprovedPlanMonitoringState;
  armedAt: number;
  conditionMatchedAt: number | null;
  triggeredAt: number | null;
  invalidatedAt: number | null;
  expiredAt: number | null;
  cancelledAt: number | null;
}

export function armStructuredTrigger(
  input: StructuredTriggerInput,
  armedAt: number,
): ApprovedPlanMonitoring {
  const validated = structuredTriggerInputSchema.parse(input);
  if (validated.expiresAt <= armedAt)
    throw new Error('TRIGGER_EXPIRES_AT_MUST_BE_IN_FUTURE');
  return {
    ...validated,
    state: 'ARMED',
    armedAt,
    conditionMatchedAt: null,
    triggeredAt: null,
    invalidatedAt: null,
    expiredAt: null,
    cancelledAt: null,
  };
}
