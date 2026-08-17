const FUTURE_HORIZONS = ['1m', '3m', '5m', '15m'];

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function at(root, ...path) {
  let current = root;
  for (const key of path) {
    const next = record(current);
    if (!next) return null;
    current = next[key];
  }
  return finite(current);
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (index - lower);
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const xMean = mean(xs);
  const yMean = mean(ys);
  if (xMean === null || yMean === null) return null;
  let numerator = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const x = (xs[index] ?? 0) - xMean;
    const y = (ys[index] ?? 0) - yMean;
    numerator += x * y;
    xVariance += x * x;
    yVariance += y * y;
  }
  const denominator = Math.sqrt(xVariance * yVariance);
  return denominator > 0 ? numerator / denominator : null;
}

function ranks(values) {
  const indexed = values
    .map((value, index) => ({ value, index }))
    .sort(
      (left, right) => left.value - right.value || left.index - right.index,
    );
  const output = new Array(values.length);
  let start = 0;
  while (start < indexed.length) {
    let end = start + 1;
    while (
      end < indexed.length &&
      indexed[end]?.value === indexed[start]?.value
    )
      end += 1;
    const averageRank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) {
      const original = indexed[index]?.index;
      if (original !== undefined) output[original] = averageRank;
    }
    start = end;
  }
  return output;
}

function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  return pearson(ranks(xs), ranks(ys));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function horizonReturn(outcome, horizon) {
  return finite(record(outcome?.futurePath)?.[`returnBps${horizon}`]);
}

function btcReturn(snapshot, horizon) {
  return at(snapshot, 'btcCore', 'orderFlow', horizon, 'priceChangeBps');
}

function leadReturn(snapshot, symbol, horizon) {
  return at(
    snapshot,
    'cryptoMarket',
    'leadCore',
    symbol,
    'returnsBps',
    horizon,
  );
}

function relativeLead(snapshot, symbol, horizon) {
  const lead = leadReturn(snapshot, symbol, horizon);
  const btc = btcReturn(snapshot, horizon);
  return lead === null || btc === null ? null : lead - btc;
}

function altMedian(snapshot, horizon) {
  return at(
    snapshot,
    'cryptoMarket',
    'altMarket',
    'breadth',
    'price',
    horizon,
    'medianReturnBps',
  );
}

function altRelative(snapshot, horizon) {
  return at(
    snapshot,
    'cryptoMarket',
    'altMarket',
    'relativeStrength',
    'altMedianMinusBtcBps',
    horizon,
  );
}

function breadthMedian(snapshot, category, horizon) {
  return at(
    snapshot,
    'cryptoMarket',
    'altMarket',
    'breadth',
    category,
    horizon,
    'median',
  );
}

const FEATURES = [
  ...['15s', '30s', '1m', '3m', '5m'].flatMap((horizon) => [
    {
      key: `ETH_RETURN_${horizon.toUpperCase()}`,
      extractor: (snapshot) => leadReturn(snapshot, 'ETHUSDT', horizon),
    },
    {
      key: `SOL_RETURN_${horizon.toUpperCase()}`,
      extractor: (snapshot) => leadReturn(snapshot, 'SOLUSDT', horizon),
    },
  ]),
  ...['1m', '3m', '5m'].flatMap((horizon) => [
    {
      key: `ETH_MINUS_BTC_${horizon.toUpperCase()}`,
      extractor: (snapshot) => relativeLead(snapshot, 'ETHUSDT', horizon),
    },
    {
      key: `SOL_MINUS_BTC_${horizon.toUpperCase()}`,
      extractor: (snapshot) => relativeLead(snapshot, 'SOLUSDT', horizon),
    },
    {
      key: `ALT_MEDIAN_RETURN_${horizon.toUpperCase()}`,
      extractor: (snapshot) => altMedian(snapshot, horizon),
    },
    {
      key: `ALT_MINUS_BTC_${horizon.toUpperCase()}`,
      extractor: (snapshot) => altRelative(snapshot, horizon),
    },
  ]),
  {
    key: 'ALT_DELTA_MEDIAN_1M',
    extractor: (snapshot) => breadthMedian(snapshot, 'delta', '1m'),
  },
  {
    key: 'ALT_OI_CHANGE_MEDIAN_1M',
    extractor: (snapshot) => breadthMedian(snapshot, 'openInterest', '1m'),
  },
];

function analyzePair(samples, minSamples) {
  const xs = samples.map((sample) => sample.feature);
  const ys = samples.map((sample) => sample.futureReturn);
  const positive = samples.filter((sample) => sample.feature > 0);
  const negative = samples.filter((sample) => sample.feature < 0);
  const nonZero = samples.filter(
    (sample) => sample.feature !== 0 && sample.futureReturn !== 0,
  );
  const q25 = percentile(xs, 0.25);
  const q75 = percentile(xs, 0.75);
  const bottom =
    q25 === null ? [] : samples.filter((sample) => sample.feature <= q25);
  const top =
    q75 === null ? [] : samples.filter((sample) => sample.feature >= q75);
  const signedAgreement = nonZero.filter(
    (sample) => Math.sign(sample.feature) === Math.sign(sample.futureReturn),
  ).length;
  const positiveReturns = positive.map((sample) => sample.futureReturn);
  const negativeReturns = negative.map((sample) => sample.futureReturn);
  const topReturns = top.map((sample) => sample.futureReturn);
  const bottomReturns = bottom.map((sample) => sample.futureReturn);
  const positiveMedian = median(positiveReturns);
  const negativeMedian = median(negativeReturns);
  const topMedian = median(topReturns);
  const bottomMedian = median(bottomReturns);

  return {
    sampleCount: samples.length,
    sampleStatus: samples.length >= minSamples ? 'RESEARCH_READY' : 'SPARSE',
    pearsonCorrelation: pearson(xs, ys),
    spearmanCorrelation: spearman(xs, ys),
    signAgreementRate: ratio(signedAgreement, nonZero.length),
    conditional: {
      positiveFeature: {
        sampleCount: positive.length,
        meanFutureReturnBps: mean(positiveReturns),
        medianFutureReturnBps: positiveMedian,
      },
      negativeFeature: {
        sampleCount: negative.length,
        meanFutureReturnBps: mean(negativeReturns),
        medianFutureReturnBps: negativeMedian,
      },
      positiveMinusNegativeMedianFutureReturnBps:
        positiveMedian !== null && negativeMedian !== null
          ? positiveMedian - negativeMedian
          : null,
    },
    tails: {
      bottomQuartile: {
        threshold: q25,
        sampleCount: bottom.length,
        medianFutureReturnBps: bottomMedian,
      },
      topQuartile: {
        threshold: q75,
        sampleCount: top.length,
        medianFutureReturnBps: topMedian,
      },
      topMinusBottomMedianFutureReturnBps:
        topMedian !== null && bottomMedian !== null
          ? topMedian - bottomMedian
          : null,
    },
  };
}

export function analyzeLeadLag(cases, options = {}) {
  const minSamples = Number.isSafeInteger(options.minSamples)
    ? Math.max(5, options.minSamples)
    : 20;
  const byFeature = Object.fromEntries(
    FEATURES.map((feature) => [
      feature.key,
      Object.fromEntries(FUTURE_HORIZONS.map((horizon) => [horizon, []])),
    ]),
  );
  let usableCases = 0;

  for (const entry of cases) {
    const snapshot = record(entry?.input?.snapshot);
    const outcome = record(entry?.outcome);
    if (!snapshot || !outcome) continue;
    let contributed = false;
    for (const feature of FEATURES) {
      const value = finite(feature.extractor(snapshot));
      if (value === null) continue;
      for (const horizon of FUTURE_HORIZONS) {
        const futureReturn = horizonReturn(outcome, horizon);
        if (futureReturn === null) continue;
        byFeature[feature.key][horizon].push({
          feature: value,
          futureReturn,
        });
        contributed = true;
      }
    }
    if (contributed) usableCases += 1;
  }

  return {
    version: 'lead-lag-research-v1',
    generatedAt: Date.now(),
    objectiveOnly: true,
    inputCases: cases.length,
    usableCases,
    minimumSamplesPerPair: minSamples,
    targets: FUTURE_HORIZONS,
    features: Object.fromEntries(
      FEATURES.map((feature) => [
        feature.key,
        Object.fromEntries(
          FUTURE_HORIZONS.map((horizon) => [
            horizon,
            analyzePair(byFeature[feature.key][horizon], minSamples),
          ]),
        ),
      ]),
    ),
    interpretationBoundary: {
      causalClaim: false,
      liveTradingRule: false,
      automaticPromotion: false,
      note: 'Statistics describe replay-time association between frozen auxiliary evidence and later BTC returns. They do not establish causality or permission to create a live LONG/SHORT rule.',
    },
  };
}

export { FUTURE_HORIZONS, FEATURES };
