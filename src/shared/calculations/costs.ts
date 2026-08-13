export function notionalEntry(q: number, price: number) {
  return Math.abs(q) * price;
}

export function grossPnlLong(q: number, entry: number, exit: number) {
  return q * (exit - entry);
}

export function grossPnlShort(q: number, entry: number, exit: number) {
  return Math.abs(q) * (entry - exit);
}

export function fee(notional: number, rate: number) {
  return notional * rate;
}

export function netPnl(
  gross: number,
  entryFee: number,
  exitFee: number,
  slippage = 0,
  funding = 0,
) {
  return gross - entryFee - exitFee - slippage - funding;
}

export function signedFundingPayment(
  side: 'LONG' | 'SHORT',
  notional: number,
  fundingRate: number,
): number {
  return notional * fundingRate * (side === 'LONG' ? 1 : -1);
}

export interface PositionPlanInput {
  side: 'LONG' | 'SHORT';
  entry: number;
  exit: number;
  quantity: number;
  entryFeeRate: number;
  exitFeeRate: number;
  slippageRate?: number;
  entrySlippageRate?: number;
  exitSlippageRate?: number;
  fundingRate?: number;
  leverage?: number;
}

export function calculatePositionPlan(input: PositionPlanInput) {
  const quantity = Math.abs(input.quantity);
  const entryNotional = quantity * input.entry;
  const exitNotional = quantity * input.exit;
  const gross =
    input.side === 'LONG'
      ? grossPnlLong(quantity, input.entry, input.exit)
      : grossPnlShort(quantity, input.entry, input.exit);
  const entryFee = fee(entryNotional, input.entryFeeRate);
  const exitFee = fee(exitNotional, input.exitFeeRate);
  const entrySlippageRate = Math.max(
    0,
    input.entrySlippageRate ?? input.slippageRate ?? 0,
  );
  const exitSlippageRate = Math.max(
    0,
    input.exitSlippageRate ?? input.slippageRate ?? 0,
  );
  const entrySlippage = entryNotional * entrySlippageRate;
  const exitSlippage = exitNotional * exitSlippageRate;
  const slippage = entrySlippage + exitSlippage;
  const funding = entryNotional * (input.fundingRate ?? 0);
  return {
    entryNotional,
    exitNotional,
    initialMargin: entryNotional / (input.leverage ?? 10),
    grossPnl: gross,
    entryFee,
    exitFee,
    entrySlippage,
    exitSlippage,
    slippage,
    funding,
    netPnl: netPnl(gross, entryFee, exitFee, slippage, funding),
  };
}

export type SizeMode =
  | 'MARGIN_USDT'
  | 'QUANTITY_BTC'
  | 'NOTIONAL_USDT'
  | 'MAX_LOSS_USDT';

export interface ExactSizeValidationInput extends QuantityValidationInput {
  side: 'LONG' | 'SHORT';
  leverage: number;
  sizeMode: SizeMode;
  sizeValue: number;
  maximumLeverage: number;
  maximumNotional: number;
  maintenanceMarginRate: number;
}

export interface ExactSizeValidationResult extends QuantityValidationResult {
  requestedQuantity: number;
  notional: number;
  isolatedMargin: number;
  maximumQuantity: number;
  maximumMargin: number;
  estimatedLiquidationPrice: number | null;
  liquidationDistancePercent: number | null;
}

export function validateExactPositionSize(
  input: ExactSizeValidationInput,
): ExactSizeValidationResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 150)
    reasons.push('LEVERAGE_OUT_OF_RANGE');
  if (input.leverage > input.maximumLeverage)
    reasons.push('LEVERAGE_EXCEEDS_BINANCE_BRACKET');
  const lossPerUnit =
    Math.abs(input.entry - input.stop) +
    input.entry * (input.entryFeeRate + input.slippageRate) +
    input.stop * (input.exitFeeRate + input.slippageRate);
  const maxLoss =
    input.maxLossUsdt && input.maxLossUsdt > 0
      ? input.maxLossUsdt
      : input.sizeMode === 'MAX_LOSS_USDT'
        ? input.sizeValue
        : null;
  let requestedQuantity: number;
  if (input.sizeMode === 'MARGIN_USDT')
    requestedQuantity = (input.sizeValue * input.leverage) / input.entry;
  else if (input.sizeMode === 'QUANTITY_BTC')
    requestedQuantity = input.sizeValue;
  else if (input.sizeMode === 'NOTIONAL_USDT')
    requestedQuantity = input.sizeValue / input.entry;
  else requestedQuantity = floorToStep(input.sizeValue / lossPerUnit, input.stepSize);
  const quantity =
    input.sizeMode === 'MAX_LOSS_USDT'
      ? requestedQuantity
      : requestedQuantity;
  const notional = quantity * input.entry;
  const isolatedMargin = notional / input.leverage;
  const estimatedMaxLoss = quantity * lossPerUnit;
  if (input.tickSize && (!isStepAligned(input.entry, input.tickSize) || !isStepAligned(input.stop, input.tickSize)))
    reasons.push('PRICE_NOT_ALIGNED_TO_TICK_SIZE');
  if (!isStepAligned(quantity, input.stepSize))
    reasons.push('QUANTITY_NOT_ALIGNED_TO_STEP_SIZE');
  if (quantity < input.minQuantity) reasons.push('BELOW_MIN_QUANTITY');
  if (notional < input.minNotional) reasons.push('BELOW_MIN_NOTIONAL');
  if (notional > input.maximumNotional) reasons.push('NOTIONAL_EXCEEDS_BINANCE_BRACKET');
  if (
    input.availableMargin !== null &&
    input.availableMargin !== undefined &&
    isolatedMargin > input.availableMargin
  )
    reasons.push('INSUFFICIENT_AVAILABLE_MARGIN');
  if (maxLoss !== null && estimatedMaxLoss > maxLoss + 1e-9)
    reasons.push('MAX_LOSS_EXCEEDED');
  const maximumQuantity = floorToStep(
    Math.min(
      input.maximumNotional / input.entry,
      input.availableMargin === null || input.availableMargin === undefined
        ? Number.POSITIVE_INFINITY
        : (input.availableMargin * input.leverage) / input.entry,
      maxLoss === null ? Number.POSITIVE_INFINITY : maxLoss / lossPerUnit,
    ),
    input.stepSize,
  );
  const liquidationFraction =
    1 / input.leverage - input.maintenanceMarginRate;
  const estimatedLiquidationPrice =
    liquidationFraction > 0
      ? input.side === 'LONG'
        ? input.entry * (1 - liquidationFraction)
        : input.entry * (1 + liquidationFraction)
      : null;
  const liquidationDistancePercent =
    estimatedLiquidationPrice === null
      ? null
      : (Math.abs(input.entry - estimatedLiquidationPrice) / input.entry) * 100;
  if (
    estimatedLiquidationPrice !== null &&
    (input.side === 'LONG'
      ? input.stop <= estimatedLiquidationPrice
      : input.stop >= estimatedLiquidationPrice)
  )
    reasons.push('STOP_BEYOND_ESTIMATED_LIQUIDATION');
  return {
    valid: reasons.length === 0,
    quantity,
    requestedQuantity,
    notional,
    isolatedMargin,
    maxLoss,
    estimatedMaxLoss,
    reasons,
    warnings,
    maximumQuantity,
    maximumMargin: (maximumQuantity * input.entry) / input.leverage,
    estimatedLiquidationPrice,
    liquidationDistancePercent,
  };
}

function floorToStep(value: number, step: number): number {
  if (step <= 0) throw new Error('stepSize must be positive');
  const precision = Math.max(0, (String(step).split('.')[1] ?? '').length);
  return Number(
    (Math.floor((value + Number.EPSILON) / step) * step).toFixed(precision),
  );
}

export interface QuantityValidationInput {
  entry: number;
  stop: number;
  leverage?: number;
  maxLossUsdt?: number | null;
  accountEquity?: number | null;
  riskPercent?: number | null;
  availableMargin?: number | null;
  entryFeeRate: number;
  exitFeeRate: number;
  slippageRate: number;
  stepSize: number;
  minQuantity: number;
  minNotional: number;
  tickSize?: number;
}

export interface QuantityValidationResult {
  valid: boolean;
  quantity: number;
  maxLoss: number | null;
  estimatedMaxLoss: number | null;
  reasons: string[];
  warnings: string[];
}

export function validateRiskQuantity(
  input: QuantityValidationInput,
): QuantityValidationResult {
  const maxLoss =
    input.maxLossUsdt && input.maxLossUsdt > 0
      ? input.maxLossUsdt
      : input.accountEquity &&
          input.accountEquity > 0 &&
          input.riskPercent &&
          input.riskPercent > 0
        ? input.accountEquity * input.riskPercent
        : null;
  if (maxLoss === null)
    return {
      valid: false,
      quantity: 0,
      maxLoss: null,
      estimatedMaxLoss: null,
      reasons: ['RISK_INPUT_REQUIRED'],
      warnings: [],
    };
  if (input.entry <= 0 || input.stop <= 0 || maxLoss <= 0) {
    return {
      valid: false,
      quantity: 0,
      maxLoss,
      estimatedMaxLoss: null,
      reasons: ['INVALID_RISK_INPUT'],
      warnings: [],
    };
  }
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (
    input.tickSize &&
    (!isStepAligned(input.entry, input.tickSize) ||
      !isStepAligned(input.stop, input.tickSize))
  )
    reasons.push('PRICE_NOT_ALIGNED_TO_TICK_SIZE');
  const lossPerUnit =
    Math.abs(input.entry - input.stop) +
    input.entry * (input.entryFeeRate + input.slippageRate) +
    input.stop * (input.exitFeeRate + input.slippageRate);
  if (lossPerUnit <= 0)
    return {
      valid: false,
      quantity: 0,
      maxLoss,
      estimatedMaxLoss: null,
      reasons: ['INVALID_STOP_DISTANCE'],
      warnings,
    };
  let quantity = floorToStep(maxLoss / lossPerUnit, input.stepSize);
  if (input.availableMargin !== null && input.availableMargin !== undefined) {
    const marginQuantity = floorToStep(
      (input.availableMargin * (input.leverage ?? 10)) / input.entry,
      input.stepSize,
    );
    if (quantity > marginQuantity) {
      quantity = marginQuantity;
      warnings.push('CAPPED_BY_AVAILABLE_MARGIN');
    }
  }
  if (quantity < input.minQuantity) reasons.push('BELOW_MIN_QUANTITY');
  if (quantity * input.entry < input.minNotional)
    reasons.push('BELOW_MIN_NOTIONAL');
  const estimatedMaxLoss = quantity * lossPerUnit;
  if (estimatedMaxLoss > maxLoss + 1e-9) reasons.push('MAX_LOSS_EXCEEDED');
  return {
    valid: reasons.length === 0,
    quantity,
    maxLoss,
    estimatedMaxLoss,
    reasons,
    warnings,
  };
}

export function isStepAligned(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
    return false;
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-8;
}

export function breakevenExitPrice(
  side: 'LONG' | 'SHORT',
  entry: number,
  entryFeeRate: number,
  exitFeeRate: number,
  entrySlippageRate = 0,
  fundingRate = 0,
  exitSlippageRate = entrySlippageRate,
): number {
  const fixed = entry * (entryFeeRate + entrySlippageRate + fundingRate);
  if (side === 'LONG') {
    return (entry + fixed) / (1 - exitFeeRate - exitSlippageRate);
  }
  return (entry - fixed) / (1 + exitFeeRate + exitSlippageRate);
}
