export type PositionAdjustmentAction =
  | 'PARTIAL_EXIT'
  | 'EXIT'
  | 'MOVE_STOP'
  | 'CHANGE_TP';

export interface PositionAdjustmentTargetInput {
  price: number;
  requestedPercent: number;
}

export interface PositionAdjustmentRequest {
  action: PositionAdjustmentAction;
  requestedQuantity?: number;
  requestedPercent?: number;
  stopPrice?: number;
  targets?: PositionAdjustmentTargetInput[];
  exitOrderType?: 'MAKER' | 'TAKER';
}

export interface PositionAdjustmentContext {
  side: 'LONG' | 'SHORT';
  quantity: number;
  markPrice: number;
  filters: {
    tickSize: number;
    stepSize: number;
    minQuantity: number;
    minNotional: number;
  };
  costSettings: {
    makerFeeRate: number | null;
    takerFeeRate: number | null;
    exitSlippageBps: number | null;
  };
  currentProtection: {
    stopLossQuantity: number;
    takeProfitQuantity: number;
  };
}

export interface ValidatedAdjustmentTarget {
  requestedPrice: number;
  alignedPrice: number;
  requestedPercent: number;
  alignedQuantity: number;
  notional: number;
}

export interface PositionAdjustmentResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  action: PositionAdjustmentAction;
  reduceOnlyRequired: true;
  requestedQuantity: number | null;
  alignedQuantity: number | null;
  remainingQuantity: number;
  requestedStopPrice: number | null;
  alignedStopPrice: number | null;
  targets: ValidatedAdjustmentTarget[];
  estimatedFee: number | null;
  estimatedSlippage: number | null;
  projectedProtection: {
    stopLossQuantity: number;
    takeProfitQuantity: number;
    stopLossCoverageRatio: number | null;
    takeProfitCoverageRatio: number | null;
  };
  filters: PositionAdjustmentContext['filters'];
}

const EPSILON = 1e-10;

function decimals(value: number): number {
  const text = value.toString().toLowerCase();
  if (text.includes('e-')) return Number(text.split('e-')[1] ?? 0);
  return text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
}

function normalize(value: number, step: number): number {
  return Number(value.toFixed(Math.max(decimals(step), 8)));
}

function floorToStep(value: number, step: number): number {
  return normalize(Math.floor((value + EPSILON) / step) * step, step);
}

function ceilToStep(value: number, step: number): number {
  return normalize(Math.ceil((value - EPSILON) / step) * step, step);
}

function coverage(quantity: number, positionQuantity: number): number | null {
  if (positionQuantity <= EPSILON) return null;
  return quantity / positionQuantity;
}

function validPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function validateOrderQuantity(
  quantity: number,
  price: number,
  context: PositionAdjustmentContext,
  errors: string[],
  prefix = '',
): void {
  const name = prefix ? `${prefix}_` : '';
  if (quantity < context.filters.minQuantity - EPSILON)
    errors.push(`${name}MIN_QUANTITY_NOT_MET`);
  if (quantity * price < context.filters.minNotional - EPSILON)
    errors.push(`${name}MIN_NOTIONAL_NOT_MET`);
}

function conservativePrice(
  side: PositionAdjustmentContext['side'],
  kind: 'STOP' | 'TARGET',
  requested: number,
  tickSize: number,
): number {
  if (kind === 'STOP')
    return side === 'LONG'
      ? ceilToStep(requested, tickSize)
      : floorToStep(requested, tickSize);
  return side === 'LONG'
    ? floorToStep(requested, tickSize)
    : ceilToStep(requested, tickSize);
}

export function validatePositionAdjustment(
  request: PositionAdjustmentRequest,
  context: PositionAdjustmentContext,
): PositionAdjustmentResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const currentQuantity = context.quantity;
  const action = request.action;
  let requestedQuantity: number | null = null;
  let alignedQuantity: number | null = null;
  let remainingQuantity = currentQuantity;
  let requestedStopPrice: number | null = null;
  let alignedStopPrice: number | null = null;
  const targets: ValidatedAdjustmentTarget[] = [];

  if (
    !Number.isFinite(currentQuantity) ||
    currentQuantity <= 0 ||
    !Number.isFinite(context.markPrice) ||
    context.markPrice <= 0
  )
    errors.push('OPEN_POSITION_REQUIRED');

  if (
    context.filters.tickSize <= 0 ||
    context.filters.stepSize <= 0 ||
    context.filters.minQuantity <= 0 ||
    context.filters.minNotional <= 0
  )
    errors.push('PRODUCT_FILTERS_INVALID');

  if (action === 'PARTIAL_EXIT') {
    const hasQuantity = validPositive(request.requestedQuantity);
    const hasPercent = validPositive(request.requestedPercent);
    if (hasQuantity === hasPercent)
      errors.push('EXACTLY_ONE_EXIT_SIZE_REQUIRED');
    if (hasPercent && (request.requestedPercent ?? 0) > 100)
      errors.push('REQUESTED_PERCENT_OUT_OF_RANGE');
    if (hasQuantity) requestedQuantity = request.requestedQuantity ?? null;
    if (hasPercent)
      requestedQuantity =
        currentQuantity * ((request.requestedPercent ?? 0) / 100);
    if (requestedQuantity !== null) {
      alignedQuantity = floorToStep(
        requestedQuantity,
        context.filters.stepSize,
      );
      if (alignedQuantity <= EPSILON)
        errors.push('ALIGNED_QUANTITY_IS_ZERO');
      if (alignedQuantity >= currentQuantity - EPSILON)
        errors.push('PARTIAL_EXIT_MUST_LEAVE_POSITION');
      if (alignedQuantity > EPSILON)
        validateOrderQuantity(
          alignedQuantity,
          context.markPrice,
          context,
          errors,
        );
      remainingQuantity = Math.max(
        0,
        normalize(currentQuantity - alignedQuantity, context.filters.stepSize),
      );
      if (remainingQuantity > EPSILON) {
        if (remainingQuantity < context.filters.minQuantity - EPSILON)
          errors.push('REMAINING_BELOW_MIN_QUANTITY');
        if (
          remainingQuantity * context.markPrice <
          context.filters.minNotional - EPSILON
        )
          errors.push('REMAINING_BELOW_MIN_NOTIONAL');
      }
    }
  } else if (action === 'EXIT') {
    requestedQuantity = currentQuantity;
    alignedQuantity = floorToStep(currentQuantity, context.filters.stepSize);
    if (Math.abs(alignedQuantity - currentQuantity) > EPSILON)
      errors.push('POSITION_QUANTITY_NOT_STEP_ALIGNED');
    if (alignedQuantity > EPSILON)
      validateOrderQuantity(
        alignedQuantity,
        context.markPrice,
        context,
        errors,
      );
    remainingQuantity = 0;
  } else if (action === 'MOVE_STOP') {
    if (!validPositive(request.stopPrice)) errors.push('STOP_PRICE_REQUIRED');
    else {
      requestedStopPrice = request.stopPrice ?? null;
      alignedStopPrice = conservativePrice(
        context.side,
        'STOP',
        request.stopPrice ?? 0,
        context.filters.tickSize,
      );
      if (
        (context.side === 'LONG' && alignedStopPrice >= context.markPrice) ||
        (context.side === 'SHORT' && alignedStopPrice <= context.markPrice)
      )
        errors.push('STOP_MUST_REMAIN_PROTECTIVE');
    }
  } else if (action === 'CHANGE_TP') {
    const requestedTargets = request.targets ?? [];
    if (requestedTargets.length < 1 || requestedTargets.length > 3)
      errors.push('TARGETS_REQUIRED');
    const totalPercent = requestedTargets.reduce(
      (sum, target) => sum + target.requestedPercent,
      0,
    );
    if (
      requestedTargets.some(
        (target) =>
          !Number.isFinite(target.requestedPercent) ||
          target.requestedPercent <= 0 ||
          target.requestedPercent > 100,
      ) ||
      totalPercent > 100 + EPSILON
    )
      errors.push('TARGET_PERCENT_OUT_OF_RANGE');

    let allocated = 0;
    requestedTargets.forEach((target, index) => {
      if (!validPositive(target.price)) {
        errors.push(`TARGET_${index + 1}_PRICE_REQUIRED`);
        return;
      }
      const alignedPrice = conservativePrice(
        context.side,
        'TARGET',
        target.price,
        context.filters.tickSize,
      );
      if (
        (context.side === 'LONG' && alignedPrice <= context.markPrice) ||
        (context.side === 'SHORT' && alignedPrice >= context.markPrice)
      )
        errors.push(`TARGET_${index + 1}_MUST_BE_PROFIT_TAKING`);
      const quantity = floorToStep(
        currentQuantity * (target.requestedPercent / 100),
        context.filters.stepSize,
      );
      validateOrderQuantity(
        quantity,
        alignedPrice,
        context,
        errors,
        `TARGET_${index + 1}`,
      );
      allocated += quantity;
      targets.push({
        requestedPrice: target.price,
        alignedPrice,
        requestedPercent: target.requestedPercent,
        alignedQuantity: quantity,
        notional: quantity * alignedPrice,
      });
    });
    if (allocated > currentQuantity + EPSILON)
      errors.push('TARGET_QUANTITY_EXCEEDS_POSITION');
    if (allocated < currentQuantity - EPSILON)
      warnings.push('TAKE_PROFIT_COVERAGE_GAP');
  }

  const orderQuantity =
    action === 'PARTIAL_EXIT' || action === 'EXIT' ? alignedQuantity : null;
  const orderNotional =
    orderQuantity === null ? null : orderQuantity * context.markPrice;
  const feeRate =
    (request.exitOrderType ?? 'TAKER') === 'MAKER'
      ? context.costSettings.makerFeeRate
      : context.costSettings.takerFeeRate;
  const estimatedFee =
    orderNotional === null || feeRate === null
      ? null
      : orderNotional * feeRate;
  const estimatedSlippage =
    orderNotional === null || context.costSettings.exitSlippageBps === null
      ? null
      : orderNotional * (context.costSettings.exitSlippageBps / 10_000);
  if (orderNotional !== null && feeRate === null)
    warnings.push('FEE_RATE_UNAVAILABLE');
  if (orderNotional !== null && context.costSettings.exitSlippageBps === null)
    warnings.push('SLIPPAGE_UNAVAILABLE');

  let projectedStopQuantity = context.currentProtection.stopLossQuantity;
  let projectedTargetQuantity = context.currentProtection.takeProfitQuantity;
  if (action === 'EXIT') {
    projectedStopQuantity = 0;
    projectedTargetQuantity = 0;
  } else if (action === 'MOVE_STOP') {
    projectedStopQuantity = currentQuantity;
  } else if (action === 'CHANGE_TP') {
    projectedTargetQuantity = targets.reduce(
      (sum, target) => sum + target.alignedQuantity,
      0,
    );
  }
  const projectedPositionQuantity = remainingQuantity;
  const stopCoverage = coverage(
    projectedStopQuantity,
    projectedPositionQuantity,
  );
  const targetCoverage = coverage(
    projectedTargetQuantity,
    projectedPositionQuantity,
  );
  if (stopCoverage !== null && stopCoverage > 1 + EPSILON)
    warnings.push('STOP_QUANTITY_EXCEEDS_REMAINING_POSITION');
  if (targetCoverage !== null && targetCoverage > 1 + EPSILON)
    warnings.push('TP_QUANTITY_EXCEEDS_REMAINING_POSITION');
  if (
    projectedPositionQuantity > EPSILON &&
    (stopCoverage === null || stopCoverage < 1 - EPSILON)
  )
    warnings.push('STOP_COVERAGE_GAP_AFTER_ADJUSTMENT');

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    action,
    reduceOnlyRequired: true,
    requestedQuantity,
    alignedQuantity,
    remainingQuantity,
    requestedStopPrice,
    alignedStopPrice,
    targets,
    estimatedFee,
    estimatedSlippage,
    projectedProtection: {
      stopLossQuantity: projectedStopQuantity,
      takeProfitQuantity: projectedTargetQuantity,
      stopLossCoverageRatio: stopCoverage,
      takeProfitCoverageRatio: targetCoverage,
    },
    filters: context.filters,
  };
}
