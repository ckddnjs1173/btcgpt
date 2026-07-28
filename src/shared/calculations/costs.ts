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
    initialMargin: entryNotional / 10,
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
      (input.availableMargin * 10) / input.entry,
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
