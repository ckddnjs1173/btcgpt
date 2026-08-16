from pathlib import Path

ROOT = Path('.')


def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'anchor missing in {path}: {old[:140]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8', newline='\n')

# Replay lease must understand both legacy detailed snapshots and the official
# decision-context-v1 payload used by the Custom GPT live path.
replace_once(
    'worker/src/phase16-replay.ts',
    "function anchorMarkPrice(snapshot: unknown): number | null {\n  return asNumber(at(asRecord(snapshot), 'marketState', 'markPrice'));\n}",
    "function replayInputBasis(snapshot: unknown): 'DECISION_CONTEXT' | 'MARKET_SNAPSHOT' {\n  const root = asRecord(snapshot);\n  return root?.version === 'decision-context-v1'\n    ? 'DECISION_CONTEXT'\n    : 'MARKET_SNAPSHOT';\n}\n\nfunction replayMarketGeneratedAt(snapshot: unknown): number | null {\n  const root = asRecord(snapshot);\n  return asNumber(root?.marketGeneratedAt) ?? asNumber(root?.generatedAt);\n}\n\nfunction anchorMarkPrice(snapshot: unknown): number | null {\n  const root = asRecord(snapshot);\n  return (\n    asNumber(at(root, 'btcCore', 'marketState', 'markPrice')) ??\n    asNumber(at(root, 'marketState', 'markPrice'))\n  );\n}",
)
replace_once(
    'worker/src/phase16-replay.ts',
    "  const marketGeneratedAt = asNumber(root?.generatedAt);\n  if (!snapshotId || marketGeneratedAt === null) return false;",
    "  const marketGeneratedAt = replayMarketGeneratedAt(snapshotResponse);\n  if (!snapshotId || marketGeneratedAt === null) return false;",
)
replace_once(
    'worker/src/phase16-replay.ts',
    "  return json({\n    decisionId: replay.decisionId,\n    replayVersion: replay.replayVersion,",
    "  const frozenInput = safeParse(replay.snapshotPayload);\n  return json({\n    decisionId: replay.decisionId,\n    replayVersion: replay.replayVersion,\n    inputBasis: replayInputBasis(frozenInput),",
)
replace_once(
    'worker/src/phase16-replay.ts',
    "    snapshot: safeParse(replay.snapshotPayload),",
    "    snapshot: frozenInput,",
)

# Lease the exact official Decision Context returned to the GPT, not only the
# legacy detailed snapshot endpoint. Analytics failures stay non-blocking.
replace_once(
    'worker/src/phase13.ts',
    "  const isSnapshotRead =\n    request.method === 'GET' && url.pathname === '/v1/snapshot/latest';",
    "  const isDecisionContextRead =\n    request.method === 'GET' && url.pathname === '/v1/decision-context/latest';\n  if (isDecisionContextRead) {\n    const response = await legacyHandler(request, env);\n    if (response.ok) {\n      try {\n        const decisionContext = (await response.clone().json()) as unknown;\n        await saveReplaySnapshotLease(env, decisionContext);\n      } catch {\n        // Replay leasing is analytics-only and must never block a live read.\n      }\n    }\n    return response;\n  }\n\n  const isSnapshotRead =\n    request.method === 'GET' && url.pathname === '/v1/snapshot/latest';",
)

# Add a fixture and an immutable Decision Context replay test.
test_path = ROOT / 'tests/unit/worker.phase16-replay.test.ts'
text = test_path.read_text(encoding='utf-8')
anchor = "function authRequest(path: string, authenticated = true) {"
fixture = r'''function decisionContext(
  snapshotId: string,
  marketGeneratedAt: number,
  markPrice: number,
  dvol: number,
) {
  return {
    version: 'decision-context-v1',
    snapshotId,
    marketGeneratedAt,
    generatedAt: marketGeneratedAt + 800,
    btcCore: { marketState: { markPrice } },
    external: {
      optionsV2: {
        version: 'deribit-options-v2',
        generatedAt: marketGeneratedAt - 2_000,
        objectiveOnly: true,
        dvol: { value: dvol, observedAt: marketGeneratedAt - 3_000 },
      },
      onchain: {
        metricNature: 'POINT_IN_TIME',
        value: 123,
      },
    },
  };
}

'''
if anchor not in text:
    raise SystemExit('phase16 replay fixture anchor missing')
text = text.replace(anchor, fixture + anchor, 1)
insert_anchor = "  it('keeps future labels separate and stores 1/3/5/15/30/60m plus a sampled price path', async () => {"
new_test = r'''  it('freezes the exact Decision Context including external evidence for replay', async () => {
    const marketGeneratedAt = 1_500_000;
    const decisionId = 'decision-context-freeze';
    database
      .prepare(
        `INSERT INTO decision_log (
          decision_id, recorded_at, intent, decision, side, analysis_mode,
          confidence_band, plan_validation, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decisionId,
        marketGeneratedAt + 2_000,
        'MARKET_ANALYSIS',
        'NO_TRADE',
        'NEUTRAL',
        'VERIFY',
        'MEDIUM',
        'NOT_APPLICABLE',
        JSON.stringify({ reasonTags: ['OPTIONS_CONTEXT'] }),
      );

    expect(
      await saveReplaySnapshotLease(
        env,
        decisionContext('snapshot-context-a', marketGeneratedAt, 100, 55.5),
        marketGeneratedAt + 1_000,
      ),
    ).toBe(true);
    expect(
      await attachReplayCaseToDecision(env, {
        decisionId,
        snapshotId: 'snapshot-context-a',
        marketGeneratedAt,
        capturedAt: marketGeneratedAt + 2_000,
      }),
    ).toBe(true);

    // A later provider refresh for the same market anchor must never rewrite
    // the already-captured replay case.
    await saveReplaySnapshotLease(
      env,
      decisionContext('snapshot-context-a', marketGeneratedAt, 999, 88.8),
      marketGeneratedAt + 3_000,
    );
    await attachReplayCaseToDecision(env, {
      decisionId,
      snapshotId: 'snapshot-context-a',
      marketGeneratedAt,
      capturedAt: marketGeneratedAt + 4_000,
    });

    const response = await handleReplayReadRequest(
      authRequest(`/v1/replay/case/${decisionId}/input`),
      env,
    );
    expect(response?.status).toBe(200);
    const input = (await response?.json()) as {
      inputBasis: string;
      anchorMarkPrice: number;
      marketGeneratedAt: number;
      snapshot: {
        version: string;
        external: {
          optionsV2: { dvol: { value: number } };
          onchain: { metricNature: string; value: number };
        };
      };
    };
    expect(input.inputBasis).toBe('DECISION_CONTEXT');
    expect(input.marketGeneratedAt).toBe(marketGeneratedAt);
    expect(input.anchorMarkPrice).toBe(100);
    expect(input.snapshot.version).toBe('decision-context-v1');
    expect(input.snapshot.external.optionsV2.dvol.value).toBe(55.5);
    expect(input.snapshot.external.onchain).toEqual({
      metricNature: 'POINT_IN_TIME',
      value: 123,
    });
  });

'''
if insert_anchor not in text:
    raise SystemExit('phase16 replay test insertion anchor missing')
text = text.replace(insert_anchor, new_test + insert_anchor, 1)
# Make the legacy replay basis explicit too.
text = text.replace(
    "      replayVersion: 'replay-v1',\n      snapshotId: 'snapshot-replay-a',",
    "      replayVersion: 'replay-v1',\n      inputBasis: 'MARKET_SNAPSHOT',\n      snapshotId: 'snapshot-replay-a',",
    1,
)
test_path.write_text(text, encoding='utf-8', newline='\n')

print('Decision Context replay freeze patch staged')
