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

export function netPnl(gross: number, entryFee: number, exitFee: number, slippage = 0, funding = 0) {
  return gross - entryFee - exitFee - slippage - funding;
}
