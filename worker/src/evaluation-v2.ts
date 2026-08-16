import type { StructuredTriggerInput } from '../../src/shared/trading/structured-trigger';

export const EVALUATION_V2_VERSION = 'eval-v2' as const;
export const PRICE_PATH_VERSION = 'path-v1' as const;
export const EVALUATION_HORIZONS = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '60m': 60 * 60_000,
} as const;

export type EvaluationHorizon = keyof typeof EVALUATION_HORIZONS;
export type PricePathPoint = readonly [ageMs: number, markPrice: number];

export interface EnterPlanEvaluationInput {
  side: 'LONG' | 'SHORT';
  anchorMarkPrice: number;
  entry: number;
  stop: number;
  targets: number[];
  pricePath: PricePathPoint[];
  realizedNetR?: number | null;
  entryDriftBps?: number | null;
}

export interface WaitTriggerEvaluationInput {
  side: 'LONG' | 'SHORT' | 'NEUTRAL';
  marketGeneratedAt: number;
  anchorMarkPrice: number;
  triggerContract: StructuredTriggerInput;
  pricePath: PricePathPoint[];
}

export interface ManagementEvaluationInput {
  decision: 'HOLD' | 'PARTIAL_EXIT' | 'EXIT' | 'MOVE_STOP' | 'CHANGE_TP';
  side: 'LONG' | 'SHORT' | 'NEUTRAL';
  anchorMarkPrice: number;
  pricePath: PricePathPoint[];
  realizedNetR?: number | null;
  mfeCaptureRatio?: number | null;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function normalizePricePath(value: unknown): PricePathPoint[] {
  if (!Array.isArray(value)) return [];
  const points: PricePathPoint[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const ageMs: unknown = item[0];
    const markPrice: unknown = item[1];
    if (
      typeof ageMs !== 'number' ||
      !Number.isFinite(ageMs) ||
      ageMs <= 0 ||
      typeof markPrice !== 'number' ||
      !finitePositive(markPrice)
    )
      continue;
    points.push([Math.trunc(ageMs), markPrice]);
  }
  points.sort((left, right) => left[0] - right[0]);
  const deduped: PricePathPoint[] = [];
  let lastAge = -1;
  for (const point of points) {
    if (point[0] === lastAge) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    deduped.push(point);
    lastAge = point[0];
  }
  return deduped;
}

export function parsePricePathJson(raw: string | null): PricePathPoint[] {
  if (!raw) return [];
  try {
    return normalizePricePath(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function signedMoveBps(
  side: 'LONG' | 'SHORT',
  reference: number,
  price: number,
): number {
  const raw = ((price - reference) / reference) * 10_000;
  return side === 'LONG' ? raw : -raw;
}

function rawMoveBps(reference: number, price: number): number {
  return ((price - reference) / reference) * 10_000;
}

function firstHit(
  path: PricePathPoint[],
  predicate: (price: number) => boolean,
): number | null {
  for (const [ageMs, price] of path) if (predicate(price)) return ageMs;
  return null;
}

function planLevelHit(
  side: 'LONG' | 'SHORT',
  kind: 'STOP' | 'TARGET',
  level: number,
): (price: number) => boolean {
  if (kind === 'STOP')
    return side === 'LONG'
      ? (price) => price <= level
      : (price) => price >= level;
  return side === 'LONG'
    ? (price) => price >= level
    : (price) => price <= level;
}

function ordering(
  targetHitMs: number | null,
  stopHitMs: number | null,
): 'TARGET_FIRST' | 'STOP_FIRST' | 'AMBIGUOUS_SAME_SAMPLE' | 'UNRESOLVED' {
  if (targetHitMs === null && stopHitMs === null) return 'UNRESOLVED';
  if (targetHitMs === null) return 'STOP_FIRST';
  if (stopHitMs === null) return 'TARGET_FIRST';
  if (targetHitMs === stopHitMs) return 'AMBIGUOUS_SAME_SAMPLE';
  return targetHitMs < stopHitMs ? 'TARGET_FIRST' : 'STOP_FIRST';
}

function excursionFromReference(
  side: 'LONG' | 'SHORT',
  reference: number,
  path: PricePathPoint[],
  maxAgeMs = Number.POSITIVE_INFINITY,
) {
  let mfeBps = 0;
  let maeBps = 0;
  let timeToMfeMs: number | null = null;
  let timeToMaeMs: number | null = null;
  for (const [ageMs, price] of path) {
    if (ageMs > maxAgeMs) break;
    const signed = signedMoveBps(side, reference, price);
    if (signed > mfeBps) {
      mfeBps = signed;
      timeToMfeMs = ageMs;
    }
    const adverse = Math.max(0, -signed);
    if (adverse > maeBps) {
      maeBps = adverse;
      timeToMaeMs = ageMs;
    }
  }
  return { mfeBps, maeBps, timeToMfeMs, timeToMaeMs };
}

export function evaluateEnterPlan(input: EnterPlanEvaluationInput) {
  if (
    !finitePositive(input.anchorMarkPrice) ||
    !finitePositive(input.entry) ||
    !finitePositive(input.stop) ||
    input.targets.length === 0 ||
    input.pricePath.length === 0
  ) {
    return {
      available: false as const,
      reason: 'PRICE_PATH_OR_PLAN_UNAVAILABLE' as const,
    };
  }

  const riskBps = Math.abs(rawMoveBps(input.entry, input.stop));
  if (riskBps <= 0) {
    return {
      available: false as const,
      reason: 'ZERO_STOP_DISTANCE' as const,
    };
  }

  const stopHitMs = firstHit(
    input.pricePath,
    planLevelHit(input.side, 'STOP', input.stop),
  );
  const targets = input.targets.slice(0, 3).map((target, index) => {
    const hitMs = firstHit(
      input.pricePath,
      planLevelHit(input.side, 'TARGET', target),
    );
    return {
      index: index + 1,
      price: target,
      hitMs,
      orderingVsStop: ordering(hitMs, stopHitMs),
      beforeStop:
        hitMs === null || stopHitMs === null
          ? hitMs !== null
          : hitMs < stopHitMs,
    };
  });
  const excursion = excursionFromReference(
    input.side,
    input.entry,
    input.pricePath,
  );
  const initial = excursionFromReference(
    input.side,
    input.entry,
    input.pricePath,
    60_000,
  );

  return {
    available: true as const,
    samplingBasis: 'RELAY_MARK_PRICE_PATH' as const,
    riskBps,
    anchorToPlannedEntryBps: rawMoveBps(input.entry, input.anchorMarkPrice),
    mfeBps: excursion.mfeBps,
    maeBps: excursion.maeBps,
    mfeR: excursion.mfeBps / riskBps,
    maeR: excursion.maeBps / riskBps,
    timeToMfeMs: excursion.timeToMfeMs,
    timeToMaeMs: excursion.timeToMaeMs,
    initialAdverseExcursionBps: initial.maeBps,
    stopHitMs,
    targets,
    realizedNetR: input.realizedNetR ?? null,
    actualEntryDriftBps: input.entryDriftBps ?? null,
    notes: [
      'TP/SL ordering is based on sampled relay mark-price path, not tick-perfect exchange trades.',
      'Equal sample timestamps are reported as ambiguous rather than forcing an ordering.',
    ],
  };
}

function priceConditionMet(
  condition: StructuredTriggerInput['triggerCondition'],
  price: number,
  threshold: number,
): boolean {
  return condition === 'AT_OR_ABOVE' ? price >= threshold : price <= threshold;
}

export function evaluateWaitTrigger(input: WaitTriggerEvaluationInput) {
  if (!finitePositive(input.anchorMarkPrice) || input.pricePath.length === 0) {
    return {
      available: false as const,
      reason: 'PRICE_PATH_UNAVAILABLE' as const,
    };
  }

  const trigger = input.triggerContract;
  const expiryAgeMs = Math.max(0, trigger.expiresAt - input.marketGeneratedAt);
  const confirmationMs = trigger.confirmWindowSec * 1_000;
  let matchedAtMs: number | null = null;
  let triggerHitMs: number | null = null;
  let triggerObservedPrice: number | null = null;
  let invalidationHitMs: number | null = null;

  for (const [ageMs, price] of input.pricePath) {
    if (expiryAgeMs > 0 && ageMs > expiryAgeMs) break;
    if (
      triggerHitMs === null &&
      invalidationHitMs === null &&
      priceConditionMet(
        trigger.invalidationCondition,
        price,
        trigger.invalidationPrice,
      )
    ) {
      invalidationHitMs = ageMs;
      break;
    }

    if (triggerHitMs !== null) continue;
    const matched = priceConditionMet(
      trigger.triggerCondition,
      price,
      trigger.triggerPrice,
    );
    if (!matched) {
      matchedAtMs = null;
      continue;
    }
    matchedAtMs ??= ageMs;
    if (ageMs - matchedAtMs >= confirmationMs) {
      triggerHitMs = ageMs;
      triggerObservedPrice = price;
    }
  }

  let chaseBpsAtTrigger: number | null = null;
  if (triggerObservedPrice !== null) {
    if (input.side === 'LONG')
      chaseBpsAtTrigger = Math.max(
        0,
        rawMoveBps(trigger.triggerPrice, triggerObservedPrice),
      );
    else if (input.side === 'SHORT')
      chaseBpsAtTrigger = Math.max(
        0,
        -rawMoveBps(trigger.triggerPrice, triggerObservedPrice),
      );
    else
      chaseBpsAtTrigger = Math.abs(
        rawMoveBps(trigger.triggerPrice, triggerObservedPrice),
      );
  }

  let postTrigger: ReturnType<typeof excursionFromReference> | null = null;
  if (
    triggerHitMs !== null &&
    triggerObservedPrice !== null &&
    input.side !== 'NEUTRAL'
  ) {
    const relative = input.pricePath
      .filter(
        ([ageMs]) =>
          ageMs >= triggerHitMs && ageMs <= triggerHitMs + 15 * 60_000,
      )
      .map(([ageMs, price]) => [ageMs - triggerHitMs, price] as PricePathPoint);
    postTrigger = excursionFromReference(
      input.side,
      triggerObservedPrice,
      relative,
    );
  }

  const lastAge = input.pricePath.at(-1)?.[0] ?? 0;
  return {
    available: true as const,
    samplingBasis: 'RELAY_MARK_PRICE_PATH' as const,
    triggerHit: triggerHitMs !== null,
    timeToTriggerMs: triggerHitMs,
    triggerObservedPrice,
    invalidationBeforeTrigger: invalidationHitMs !== null,
    invalidationHitMs,
    expiredWithoutTrigger:
      triggerHitMs === null &&
      invalidationHitMs === null &&
      expiryAgeMs > 0 &&
      lastAge >= expiryAgeMs,
    expiryAgeMs,
    anchorToTriggerObservedBps:
      triggerObservedPrice === null
        ? null
        : rawMoveBps(input.anchorMarkPrice, triggerObservedPrice),
    chaseBpsAtTrigger,
    maxChaseBps: trigger.maxChaseBps,
    maxChaseExceededAtTrigger:
      chaseBpsAtTrigger === null
        ? null
        : chaseBpsAtTrigger > trigger.maxChaseBps,
    postTrigger15m:
      postTrigger === null
        ? null
        : {
            favorableBps: postTrigger.mfeBps,
            adverseBps: postTrigger.maeBps,
            timeToFavorableMs: postTrigger.timeToMfeMs,
            timeToAdverseMs: postTrigger.timeToMaeMs,
          },
    notes: [
      'Trigger confirmation is replayed from sampled mark prices using the exact GPT-authored mechanical condition.',
      'No directional score is assigned to WAIT_TRIGGER.',
    ],
  };
}

export function evaluateManagementDecision(input: ManagementEvaluationInput) {
  if (
    input.side === 'NEUTRAL' ||
    !finitePositive(input.anchorMarkPrice) ||
    input.pricePath.length === 0
  ) {
    return {
      available: false as const,
      reason: 'POSITION_SIDE_OR_PRICE_PATH_UNAVAILABLE' as const,
    };
  }

  const horizons = Object.fromEntries(
    Object.entries(EVALUATION_HORIZONS).map(([key, maxAgeMs]) => {
      const excursion = excursionFromReference(
        input.side as 'LONG' | 'SHORT',
        input.anchorMarkPrice,
        input.pricePath,
        maxAgeMs,
      );
      return [
        key,
        {
          favorableBps: excursion.mfeBps,
          adverseBps: excursion.maeBps,
          timeToFavorableMs: excursion.timeToMfeMs,
          timeToAdverseMs: excursion.timeToMaeMs,
        },
      ];
    }),
  ) as Record<
    EvaluationHorizon,
    {
      favorableBps: number;
      adverseBps: number;
      timeToFavorableMs: number | null;
      timeToAdverseMs: number | null;
    }
  >;

  return {
    available: true as const,
    decision: input.decision,
    positionSide: input.side,
    horizons,
    realizedNetR: input.realizedNetR ?? null,
    mfeCaptureRatio: input.mfeCaptureRatio ?? null,
    interpretation:
      input.decision === 'EXIT' || input.decision === 'PARTIAL_EXIT'
        ? {
            favorableMoveAfterDecisionBps30m: horizons['30m'].favorableBps,
            adverseMoveAfterDecisionBps30m: horizons['30m'].adverseBps,
          }
        : null,
    notes: [
      'Management outcomes are descriptive vectors and are not converted into a scalar strategy score.',
    ],
  };
}
