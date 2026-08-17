type UnknownRecord = Record<string, unknown>;

export type EvalV2ScoreRow = {
  decisionId: string;
  scorePayload: string | null;
};

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function parseScore(raw: string | null): UnknownRecord | null {
  if (!raw) return null;
  try {
    return record(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function pushFinite(target: number[], value: unknown) {
  const numeric = finite(value);
  if (numeric !== null) target.push(numeric);
}

export function aggregateEvalV2PathQuality(rows: EvalV2ScoreRow[]) {
  const enterMfeR: number[] = [];
  const enterMaeR: number[] = [];
  const enterInitialAdverseBps: number[] = [];
  const enterTimeToMfeMs: number[] = [];
  const enterTimeToMaeMs: number[] = [];
  let enterSamples = 0;
  let tp1ResolvedSamples = 0;
  let tp1TargetFirst = 0;
  let tp1StopFirst = 0;
  let tp1Ambiguous = 0;

  let waitSamples = 0;
  let waitTriggerHit = 0;
  let waitInvalidationBeforeTrigger = 0;
  let waitExpiredWithoutTrigger = 0;
  let waitTriggeredWithChaseStatus = 0;
  let waitMaxChaseExceeded = 0;
  const waitTimeToTriggerMs: number[] = [];
  const waitPostTriggerFavorableBps: number[] = [];
  const waitPostTriggerAdverseBps: number[] = [];

  let managementSamples = 0;
  const managementFavorable30mBps: number[] = [];
  const managementAdverse30mBps: number[] = [];

  let parsedEvalV2Scores = 0;
  let invalidScorePayloads = 0;
  let unavailableDecisionEvaluations = 0;

  for (const row of rows) {
    const score = parseScore(row.scorePayload);
    if (!score) {
      invalidScorePayloads += 1;
      continue;
    }
    if (score.evaluatorVersion !== 'eval-v2') continue;
    parsedEvalV2Scores += 1;

    const decisionClass = score.decisionClass;
    const evaluation = record(score.decisionEvaluation);
    if (!evaluation || evaluation.available !== true) {
      unavailableDecisionEvaluations += 1;
      continue;
    }

    if (decisionClass === 'ENTER') {
      enterSamples += 1;
      pushFinite(enterMfeR, evaluation.mfeR);
      pushFinite(enterMaeR, evaluation.maeR);
      pushFinite(enterInitialAdverseBps, evaluation.initialAdverseExcursionBps);
      pushFinite(enterTimeToMfeMs, evaluation.timeToMfeMs);
      pushFinite(enterTimeToMaeMs, evaluation.timeToMaeMs);

      const targets = Array.isArray(evaluation.targets) ? evaluation.targets : [];
      const tp1 = record(targets[0]);
      const ordering = tp1?.orderingVsStop;
      if (
        ordering === 'TARGET_FIRST' ||
        ordering === 'STOP_FIRST' ||
        ordering === 'AMBIGUOUS_SAME_SAMPLE'
      ) {
        tp1ResolvedSamples += 1;
        if (ordering === 'TARGET_FIRST') tp1TargetFirst += 1;
        if (ordering === 'STOP_FIRST') tp1StopFirst += 1;
        if (ordering === 'AMBIGUOUS_SAME_SAMPLE') tp1Ambiguous += 1;
      }
      continue;
    }

    if (decisionClass === 'WAIT') {
      waitSamples += 1;
      const triggerHit = bool(evaluation.triggerHit);
      if (triggerHit === true) waitTriggerHit += 1;
      if (bool(evaluation.invalidationBeforeTrigger) === true)
        waitInvalidationBeforeTrigger += 1;
      if (bool(evaluation.expiredWithoutTrigger) === true)
        waitExpiredWithoutTrigger += 1;
      if (triggerHit === true) {
        pushFinite(waitTimeToTriggerMs, evaluation.timeToTriggerMs);
        const chaseExceeded = bool(evaluation.maxChaseExceededAtTrigger);
        if (chaseExceeded !== null) {
          waitTriggeredWithChaseStatus += 1;
          if (chaseExceeded) waitMaxChaseExceeded += 1;
        }
        const postTrigger = record(evaluation.postTrigger15m);
        if (postTrigger) {
          pushFinite(waitPostTriggerFavorableBps, postTrigger.favorableBps);
          pushFinite(waitPostTriggerAdverseBps, postTrigger.adverseBps);
        }
      }
      continue;
    }

    if (decisionClass === 'POSITION_MANAGEMENT') {
      managementSamples += 1;
      const horizons = record(evaluation.horizons);
      const thirty = record(horizons?.['30m']);
      if (thirty) {
        pushFinite(managementFavorable30mBps, thirty.favorableBps);
        pushFinite(managementAdverse30mBps, thirty.adverseBps);
      }
    }
  }

  return {
    version: 'eval-v2-path-quality-v1',
    rows: {
      total: rows.length,
      parsedEvalV2Scores,
      invalidScorePayloads,
      unavailableDecisionEvaluations,
    },
    enter: {
      samples: enterSamples,
      mfeR: {
        samples: enterMfeR.length,
        mean: mean(enterMfeR),
        median: median(enterMfeR),
      },
      maeR: {
        samples: enterMaeR.length,
        mean: mean(enterMaeR),
        median: median(enterMaeR),
      },
      initialAdverseExcursionBps: {
        samples: enterInitialAdverseBps.length,
        mean: mean(enterInitialAdverseBps),
        median: median(enterInitialAdverseBps),
      },
      timeToMfeMs: {
        samples: enterTimeToMfeMs.length,
        mean: mean(enterTimeToMfeMs),
        median: median(enterTimeToMfeMs),
      },
      timeToMaeMs: {
        samples: enterTimeToMaeMs.length,
        mean: mean(enterTimeToMaeMs),
        median: median(enterTimeToMaeMs),
      },
      tp1Ordering: {
        resolvedSamples: tp1ResolvedSamples,
        targetFirst: tp1TargetFirst,
        stopFirst: tp1StopFirst,
        ambiguousSameSample: tp1Ambiguous,
        targetFirstRate: rate(tp1TargetFirst, tp1ResolvedSamples),
        stopFirstRate: rate(tp1StopFirst, tp1ResolvedSamples),
        ambiguousRate: rate(tp1Ambiguous, tp1ResolvedSamples),
      },
    },
    wait: {
      samples: waitSamples,
      triggerHit: waitTriggerHit,
      triggerHitRate: rate(waitTriggerHit, waitSamples),
      invalidationBeforeTrigger: waitInvalidationBeforeTrigger,
      invalidationBeforeTriggerRate: rate(
        waitInvalidationBeforeTrigger,
        waitSamples,
      ),
      expiredWithoutTrigger: waitExpiredWithoutTrigger,
      expiredWithoutTriggerRate: rate(waitExpiredWithoutTrigger, waitSamples),
      timeToTriggerMs: {
        samples: waitTimeToTriggerMs.length,
        mean: mean(waitTimeToTriggerMs),
        median: median(waitTimeToTriggerMs),
      },
      chase: {
        samples: waitTriggeredWithChaseStatus,
        maxChaseExceeded: waitMaxChaseExceeded,
        maxChaseExceededRate: rate(
          waitMaxChaseExceeded,
          waitTriggeredWithChaseStatus,
        ),
      },
      postTrigger15m: {
        favorableBps: {
          samples: waitPostTriggerFavorableBps.length,
          mean: mean(waitPostTriggerFavorableBps),
          median: median(waitPostTriggerFavorableBps),
        },
        adverseBps: {
          samples: waitPostTriggerAdverseBps.length,
          mean: mean(waitPostTriggerAdverseBps),
          median: median(waitPostTriggerAdverseBps),
        },
      },
    },
    management: {
      samples: managementSamples,
      favorable30mBps: {
        samples: managementFavorable30mBps.length,
        mean: mean(managementFavorable30mBps),
        median: median(managementFavorable30mBps),
      },
      adverse30mBps: {
        samples: managementAdverse30mBps.length,
        mean: mean(managementAdverse30mBps),
        median: median(managementAdverse30mBps),
      },
    },
    policy: {
      scalarScore: false,
      automaticPromotion: false,
      note: 'Path-quality vectors are descriptive. ENTER, WAIT_TRIGGER and position-management samples remain separate and are not collapsed into one strategy score.',
    },
  };
}
