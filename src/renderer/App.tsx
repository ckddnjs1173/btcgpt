import { useCallback, useEffect, useState } from 'react';

import type {
  ActionResult,
  AccountStatus,
  MarketSnapshot,
  MarketStatus,
  ManualPosition,
  RelayStatus,
  PositionCalculationResult,
  UserSettings,
} from '../shared/contracts';
import { MarketChart } from './MarketChart';

type Timeframe = Extract<
  keyof MarketSnapshot['timeframes'],
  '1m' | '5m' | '15m' | '1h' | '4h'
>;
const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];
const DEFAULT_SETTINGS: UserSettings = {
  gptUrl: 'https://chatgpt.com/',
  makerFeeRate: null,
  takerFeeRate: null,
  entrySlippageBps: null,
  exitSlippageBps: null,
  maxLossUsdt: null,
  riskPercent: null,
  partialTakeProfitRatios: [0.3, 0.3, 0.4],
  minimumNetMarginRoiPercent: 2,
  autoStart: false,
  tradingMode: 'PAPER',
  defaultLeverage: 10,
};

interface NumericSettingsDraft {
  makerFeeRate: string;
  takerFeeRate: string;
  entrySlippageBps: string;
  exitSlippageBps: string;
  maxLossUsdt: string;
  riskPercent: string;
}

function toNumericSettingsDraft(settings: UserSettings): NumericSettingsDraft {
  return {
    makerFeeRate: settings.makerFeeRate?.toString() ?? '',
    takerFeeRate: settings.takerFeeRate?.toString() ?? '',
    entrySlippageBps: settings.entrySlippageBps?.toString() ?? '',
    exitSlippageBps: settings.exitSlippageBps?.toString() ?? '',
    maxLossUsdt: settings.maxLossUsdt?.toString() ?? '',
    riskPercent: settings.riskPercent?.toString() ?? '',
  };
}

function parseOptionalDecimal(value: string, label: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (normalized === '') return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 값이 올바르지 않습니다.`);
  return parsed;
}

function formatNumber(value: string | number | null, digits = 2): string {
  if (value === null || value === '') return '—';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function formatSnapshotText(snapshot: MarketSnapshot): string {
  return [
    '# BTC Futures Assistant · verified snapshot',
    `snapshotId: ${snapshot.snapshotId}`,
    `generatedAtKst: ${snapshot.generatedAtKst}`,
    `analysisAllowed: ${snapshot.analysisGate.analysisAllowed}`,
    `status: ${snapshot.analysisGate.overallStatus}`,
    `reasons: ${snapshot.analysisGate.reasons.join(', ') || 'none'}`,
    `last / mark / index: ${snapshot.marketState.lastPrice ?? 'null'} / ${snapshot.marketState.markPrice ?? 'null'} / ${snapshot.marketState.indexPrice ?? 'null'}`,
    `fundingRate: ${snapshot.marketState.fundingRate ?? 'null'}`,
    `openInterestBTC: ${snapshot.openInterest.current ?? 'null'}`,
    `positionSource: ${snapshot.position.source}`,
    '',
    '이 자료는 객관 데이터와 계산값이며 거래 방향을 생성하지 않습니다.',
    '실제 주문은 사용자가 Binance에서 직접 실행해야 합니다.',
  ].join('\n');
}

export function App() {
  const [status, setStatus] = useState<MarketStatus | null>(null);
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>('5m');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [manualPosition, setManualPosition] = useState<ManualPosition | null>(
    null,
  );
  const [manualSide, setManualSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [manualQuantity, setManualQuantity] = useState('');
  const [manualEntry, setManualEntry] = useState('');
  const [manualStop, setManualStop] = useState('');
  const [manualTargets, setManualTargets] = useState(['', '', '']);
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<NumericSettingsDraft>(() =>
    toNumericSettingsDraft(DEFAULT_SETTINGS),
  );
  const [calculator, setCalculator] = useState({
    side: 'LONG' as 'LONG' | 'SHORT',
    entry: '',
    stop: '',
    target: '',
    leverage: '10',
    sizeMode: 'MARGIN_USDT' as
      | 'MARGIN_USDT'
      | 'QUANTITY_BTC'
      | 'NOTIONAL_USDT'
      | 'MAX_LOSS_USDT',
    sizeValue: '',
    entryOrderType: 'TAKER' as 'MAKER' | 'TAKER',
    exitOrderType: 'TAKER' as 'MAKER' | 'TAKER',
  });
  const [calculation, setCalculation] =
    useState<PositionCalculationResult | null>(null);
  const [relayUrl, setRelayUrl] = useState('');
  const [relayUploadKey, setRelayUploadKey] = useState('');
  const [naverClientId, setNaverClientId] = useState('');
  const [naverClientSecret, setNaverClientSecret] = useState('');
  const [renderedAt, setRenderedAt] = useState(() => Date.now());

  const configureNaver = async () => {
    if (!window.desktopApi.configureNaver) return;
    setBusy(true);
    try {
      setResult(
        await window.desktopApi.configureNaver({
          clientId: naverClientId,
          clientSecret: naverClientSecret,
        }),
      );
      setNaverClientId('');
      setNaverClientSecret('');
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Naver 설정 실패',
      });
    } finally {
      setBusy(false);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const [
        nextStatus,
        nextSnapshot,
        nextAccount,
        nextManualPosition,
        nextRelay,
      ] = await Promise.all([
        window.desktopApi.getMarketStatus(),
        window.desktopApi.getLatestSnapshot(),
        window.desktopApi.getAccountStatus(),
        window.desktopApi.getManualPosition(),
        window.desktopApi.getRelayStatus(),
      ]);
      setStatus(nextStatus);
      setSnapshot(nextSnapshot);
      setAccount(nextAccount);
      setManualPosition(nextManualPosition);
      setRelay(nextRelay);
    } catch {
      const nextStatus = await window.desktopApi.getMarketStatus();
      setStatus(nextStatus);
    }
  }, []);

  useEffect(() => {
    void window.desktopApi.getUserSettings().then((saved) => {
      setSettings(saved);
      setSettingsDraft(toNumericSettingsDraft(saved));
    });
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      setRenderedAt(Date.now());
      void refresh();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const copySnapshot = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      const latest = await window.desktopApi.getLatestSnapshot();
      setSnapshot(latest);
      const payload = JSON.stringify(latest);
      if (new Blob([payload]).size > 90_000) {
        setResult({
          ok: false,
          message: '스냅샷이 90,000바이트를 초과했습니다.',
        });
        return false;
      }
      const copyResult = await window.desktopApi.copyText(payload);
      setResult(copyResult);
      return copyResult.ok;
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : '스냅샷 복사 실패',
      });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const copyAndOpen = useCallback(async () => {
    if (await copySnapshot())
      setResult(await window.desktopApi.openExternal(settings.gptUrl));
  }, [copySnapshot, settings.gptUrl]);

  const copyReadableText = useCallback(async () => {
    const latest = await window.desktopApi.getLatestSnapshot();
    setSnapshot(latest);
    setResult(await window.desktopApi.copyText(formatSnapshotText(latest)));
  }, []);

  const connectAccount = useCallback(async () => {
    setBusy(true);
    try {
      setResult(
        await window.desktopApi.configureAccount({ apiKey, apiSecret }),
      );
      setApiKey('');
      setApiSecret('');
      setAccount(await window.desktopApi.getAccountStatus());
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : '계정 연결 실패',
      });
    } finally {
      setBusy(false);
    }
  }, [apiKey, apiSecret]);

  const disconnectAccount = useCallback(async () => {
    setResult(await window.desktopApi.disconnectAccount());
    setAccount(await window.desktopApi.getAccountStatus());
  }, []);

  const saveManualPosition = useCallback(async () => {
    try {
      const saved = await window.desktopApi.saveManualPosition({
        side: manualSide,
        quantity: Number(manualQuantity),
        entryPrice: Number(manualEntry),
        leverage: settings.defaultLeverage,
        stopPrice: manualStop ? Number(manualStop) : null,
        targetPrices: manualTargets
          .filter((value) => Number(value) > 0)
          .map(Number),
      });
      setManualPosition(saved);
      setResult({ ok: true, message: '수동 포지션을 저장했습니다.' });
    } catch (error) {
      setResult({
        ok: false,
        message:
          error instanceof Error ? error.message : '수동 포지션 저장 실패',
      });
    }
  }, [
    manualEntry,
    manualQuantity,
    manualSide,
    manualStop,
    manualTargets,
    settings.defaultLeverage,
  ]);

  const saveSettings = useCallback(async () => {
    try {
      const nextSettings: UserSettings = {
        ...settings,
        makerFeeRate: parseOptionalDecimal(
          settingsDraft.makerFeeRate,
          'Maker 수수료율',
        ),
        takerFeeRate: parseOptionalDecimal(
          settingsDraft.takerFeeRate,
          'Taker 수수료율',
        ),
        entrySlippageBps: parseOptionalDecimal(
          settingsDraft.entrySlippageBps,
          '진입 슬리피지',
        ),
        exitSlippageBps: parseOptionalDecimal(
          settingsDraft.exitSlippageBps,
          '청산 슬리피지',
        ),
        maxLossUsdt: parseOptionalDecimal(
          settingsDraft.maxLossUsdt,
          '최대 손실',
        ),
        riskPercent: parseOptionalDecimal(
          settingsDraft.riskPercent,
          '계정 위험 비율',
        ),
      };
      const saved = await window.desktopApi.saveUserSettings(nextSettings);
      setSettings(saved);
      setSettingsDraft(toNumericSettingsDraft(saved));
      setResult({ ok: true, message: '계산·GPT 설정을 저장했습니다.' });
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : '설정 저장 실패',
      });
    }
  }, [settings, settingsDraft]);

  const runCalculator = useCallback(async () => {
    setCalculation(null);
    try {
      setCalculation(
        await window.desktopApi.calculatePositionPlan({
          side: calculator.side,
          entry: Number(calculator.entry),
          stop: Number(calculator.stop),
          target: Number(calculator.target),
          leverage: Number(calculator.leverage),
          sizeMode: calculator.sizeMode,
          sizeValue: Number(calculator.sizeValue),
          entryOrderType: calculator.entryOrderType,
          exitOrderType: calculator.exitOrderType,
        }),
      );
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : '계산 실패',
      });
    }
  }, [calculator]);

  const lockPlan = useCallback(async () => {
    try {
      if (!window.desktopApi.lockTradePlan) throw new Error('계획 고정 API 미지원');
      await window.desktopApi.lockTradePlan({
        side: calculator.side,
        entry: Number(calculator.entry),
        stop: Number(calculator.stop),
        target: Number(calculator.target),
        targets: [Number(calculator.target)],
        leverage: Number(calculator.leverage),
        sizeMode: calculator.sizeMode,
        sizeValue: Number(calculator.sizeValue),
        entryOrderType: calculator.entryOrderType,
        exitOrderType: calculator.exitOrderType,
      });
      setResult({ ok: true, message: '검증된 진입 전 계획을 고정했습니다.' });
      await refresh();
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : '계획 고정 실패',
      });
    }
  }, [calculator, refresh]);

  const enterPaperTrade = useCallback(async () => {
    try {
      if (!window.desktopApi.enterPaperTrade) throw new Error('PAPER API 미지원');
      await window.desktopApi.enterPaperTrade();
      setResult({ ok: true, message: 'PAPER 거래를 시작했습니다.' });
      await refresh();
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : 'PAPER 진입 실패',
      });
    }
  }, [refresh]);

  const closePaperTrade = useCallback(async () => {
    try {
      if (!window.desktopApi.closePaperTrade) throw new Error('PAPER API 미지원');
      await window.desktopApi.closePaperTrade({});
      setResult({ ok: true, message: 'PAPER 거래를 비용 차감 후 종료했습니다.' });
      await refresh();
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : 'PAPER 종료 실패',
      });
    }
  }, [refresh]);

  const connectRelay = useCallback(async () => {
    setBusy(true);
    try {
      setResult(
        await window.desktopApi.configureRelay({
          baseUrl: relayUrl,
          uploadKey: relayUploadKey,
        }),
      );
      setRelayUploadKey('');
      setRelay(await window.desktopApi.getRelayStatus());
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : '중계 연결 실패',
      });
    } finally {
      setBusy(false);
    }
  }, [relayUploadKey, relayUrl]);

  const disconnectRelay = useCallback(async () => {
    setResult(await window.desktopApi.disconnectRelay());
    setRelay(await window.desktopApi.getRelayStatus());
  }, []);

  const resetLocalData = useCallback(async () => {
    if (
      !window.confirm(
        '저장된 API 키·중계 키·캔들·설정·수동 포지션을 모두 초기화할까요?',
      )
    )
      return;
    setResult(await window.desktopApi.resetLocalData());
    setSettings(DEFAULT_SETTINGS);
    setSettingsDraft(toNumericSettingsDraft(DEFAULT_SETTINGS));
    setManualPosition(null);
    setSnapshot(null);
    setAccount(await window.desktopApi.getAccountStatus());
    setRelay(await window.desktopApi.getRelayStatus());
  }, []);

  const selectedTimeframe = snapshot?.timeframes?.[timeframe];
  const rows = selectedTimeframe?.closed ?? [];
  const gate = snapshot?.analysisGate;
  const current = rows.at(-1);
  const previous = rows.at(-2);
  const change =
    current && previous
      ? ((Number(current[4]) - Number(previous[4])) / Number(previous[4])) * 100
      : null;
  const selectedIndicators = selectedTimeframe?.indicators;
  const scalpContext = snapshot?.scalpContext;
  const orderFlow15s = snapshot?.orderFlow?.['15s'];
  const orderFlow30s = snapshot?.orderFlow?.['30s'];
  const localOiChanges = snapshot?.openInterest?.localChanges;
  const scalpReady = Boolean(
    scalpContext?.candles?.['1m'] &&
      scalpContext?.candles?.['5m'] &&
      scalpContext?.depth &&
      orderFlow15s &&
      orderFlow30s &&
      localOiChanges,
  );
  const sourceHealth = snapshot?.sourceHealth;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">₿</span>
          <div>
            <p className="eyebrow">LOCAL · READ ONLY · BTCUSDT</p>
            <h1>BTC Futures Assistant</h1>
          </div>
        </div>
        <div
          className={`phase-badge ${status?.dataStatus === 'NORMAL' ? 'ok' : ''}`}
        >
          <span className="phase-dot" />
          {status?.dataStatus ?? 'INITIALIZING'}
        </div>
      </header>

      <section className="market-summary">
        <article>
          <span>MARK</span>
          <strong>${formatNumber(status?.markPrice ?? null)}</strong>
        </article>
        <article>
          <span>INDEX</span>
          <strong>${formatNumber(status?.indexPrice ?? null)}</strong>
        </article>
        <article>
          <span>LAST CLOSE</span>
          <strong>${formatNumber(current ? String(current[4]) : null)}</strong>
        </article>
        <article>
          <span>{timeframe} CHANGE</span>
          <strong className={(change ?? 0) >= 0 ? 'positive' : 'negative'}>
            {change === null ? '—' : `${change.toFixed(2)}%`}
          </strong>
        </article>
      </section>

      <section className="connection-strip" aria-label="연결 상태">
        <span>
          REST <strong>{sourceHealth?.market?.status ?? 'INITIALIZING'}</strong>
        </span>
        <span>
          WebSocket <strong>{status?.dataStatus ?? 'INITIALIZING'}</strong>
        </span>
        <span>
          계정{' '}
          <strong>
            {account?.connected
              ? 'NORMAL'
              : account?.configured
                ? 'DISCONNECTED'
                : 'OFF'}
          </strong>
        </span>
        <span>
          중계{' '}
          <strong>
            {relay?.connected
              ? 'NORMAL'
              : relay?.configured
                ? 'DISCONNECTED'
                : 'OFF'}
          </strong>
        </span>
        <span>
          데이터 나이 <strong>{gate ? `${gate.ageMs}ms` : '—'}</strong>
        </span>
      </section>

      {gate && !gate.analysisAllowed && (
        <div className="notice error" role="alert">
          분석 차단 ·{' '}
          {gate.reasons.join(', ') || '필수 데이터가 준비되지 않았습니다.'}
        </div>
      )}
      {result && (
        <div className={`notice ${result.ok ? 'success' : 'error'}`}>
          {result.message}
        </div>
      )}

      <section className="workspace-grid">
        <article className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CLOSED CANDLES ONLY</p>
              <h3>BTCUSDT USDⓈ-M Perpetual</h3>
            </div>
            <div className="timeframes">
              {TIMEFRAMES.map((item) => (
                <button
                  className={item === timeframe ? 'active' : ''}
                  key={item}
                  onClick={() => setTimeframe(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
          {selectedTimeframe ? (
            <MarketChart timeframe={selectedTimeframe} />
          ) : (
            <div className="market-chart chart-loading">
              {snapshot
                ? '초단기 데이터 준비 중'
                : '시장 데이터를 준비하고 있습니다.'}
            </div>
          )}
          <div className="chart-meta">
            <span>마감 {rows.length}개</span>
            <span>
              진행 {selectedTimeframe?.live ? 1 : 0}개 (신규 진입
              판단 제외)
            </span>
          </div>
        </article>

        <aside className="panel detail-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">DATA HEALTH</p>
              <h3>분석 게이트</h3>
            </div>
          </div>
          <dl className="runtime-list">
            <div>
              <dt>분석 허용</dt>
              <dd>{gate?.analysisAllowed ? 'YES' : 'NO'}</dd>
            </div>
            <div>
              <dt>스냅샷</dt>
              <dd>{snapshot?.snapshotId ?? '준비 중'}</dd>
            </div>
            <div>
              <dt>생성시각 KST</dt>
              <dd>{snapshot?.generatedAtKst ?? '—'}</dd>
            </div>
            {TIMEFRAMES.map((item) => (
              <div key={item}>
                <dt>{item} 마감 캔들</dt>
                <dd>{status?.timeframeCounts[item] ?? 0}</dd>
              </div>
            ))}
            {(['1d', '1w'] as const).map((item) => (
              <div key={item}>
                <dt>{item} 마감 참고봉</dt>
                <dd>{snapshot?.timeframes[item].closed.length ?? 0}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </section>

      {snapshot && (
        <section className="market-detail-grid">
          <article className="panel metric-panel">
            <p className="eyebrow">MARKET</p>
            <dl>
              <div>
                <dt>Spread</dt>
                <dd>
                  {formatNumber(snapshot.marketState.spread, 2)} USDT ·{' '}
                  {formatNumber(snapshot.marketState.spreadBps, 2)} bps
                </dd>
              </div>
              <div>
                <dt>Funding</dt>
                <dd>
                  {formatNumber(
                    (snapshot.marketState.fundingRate ?? 0) * 100,
                    4,
                  )}
                  %
                </dd>
              </div>
              <div>
                <dt>Next funding</dt>
                <dd>
                  {snapshot.marketState.nextFundingTime
                    ? new Date(
                        snapshot.marketState.nextFundingTime,
                      ).toLocaleString('ko-KR')
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Open interest</dt>
                <dd>{formatNumber(snapshot.openInterest.current, 3)} BTC</dd>
              </div>
              <div>
                <dt>OI {timeframe}</dt>
                <dd>
                  {formatNumber(
                    timeframe === '1m'
                      ? snapshot.openInterest.localChanges['1m']
                      : snapshot.openInterest.changes[timeframe] ?? null,
                    2,
                  )}
                  %
                </dd>
              </div>
            </dl>
          </article>
          <article className="panel metric-panel">
            <p className="eyebrow">ORDER FLOW</p>
            <dl>
              <div>
                <dt>Taker buy / sell</dt>
                <dd>
                  {formatNumber(snapshot.orderFlow['5m'].takerBuyVolume, 3)} /{' '}
                  {formatNumber(snapshot.orderFlow['5m'].takerSellVolume, 3)}
                </dd>
              </div>
              <div>
                <dt>Delta 5m</dt>
                <dd>{formatNumber(snapshot.orderFlow['5m'].delta, 3)} BTC</dd>
              </div>
              <div>
                <dt>Book imbalance</dt>
                <dd>
                  {formatNumber(
                    (snapshot.orderFlow.orderBookImbalance20 ?? 0) * 100,
                    2,
                  )}
                  %
                </dd>
              </div>
              <div>
                <dt>Long / short</dt>
                <dd>
                  {formatNumber(
                    snapshot.sentiment.globalLongShortAccountRatio,
                    3,
                  )}
                </dd>
              </div>
              <div>
                <dt>Liquidations 5m</dt>
                <dd>
                  L {formatNumber(snapshot.liquidations['5m'].longNotional, 0)}{' '}
                  / S{' '}
                  {formatNumber(snapshot.liquidations['5m'].shortNotional, 0)}{' '}
                  USDT
                </dd>
              </div>
            </dl>
          </article>
          <article className="panel metric-panel">
            <p className="eyebrow">INDICATORS · {timeframe}</p>
            <dl>
              <div>
                <dt>EMA 20 / 50 / 200</dt>
                <dd>
                  {formatNumber(selectedIndicators?.ema20 ?? null)} /{' '}
                  {formatNumber(selectedIndicators?.ema50 ?? null)} /{' '}
                  {formatNumber(selectedIndicators?.ema200 ?? null)}
                </dd>
              </div>
              <div>
                <dt>RSI 14</dt>
                <dd>{formatNumber(selectedIndicators?.rsi14 ?? null, 2)}</dd>
              </div>
              <div>
                <dt>ATR 14</dt>
                <dd>
                  {formatNumber(selectedIndicators?.atr14 ?? null, 2)} ·{' '}
                  {formatNumber(selectedIndicators?.atrPercent ?? null, 2)}%
                </dd>
              </div>
              <div>
                <dt>Volume ratio</dt>
                <dd>
                  {formatNumber(selectedIndicators?.volumeRatio ?? null, 2)}x
                </dd>
              </div>
              <div>
                <dt>VWAP</dt>
                <dd>{formatNumber(selectedIndicators?.vwap ?? null, 2)}</dd>
              </div>
            </dl>
          </article>
          <article className="panel metric-panel risk-card">
            <p className="eyebrow">EXTERNAL RISK · READ ONLY</p>
            <dl>
              <div>
                <dt>외부 컨텍스트</dt>
                <dd>{snapshot.riskContext.status}</dd>
              </div>
              <div>
                <dt>고위험 사건</dt>
                <dd>{snapshot.riskContext.highRiskNews ? '있음' : '없음'}</dd>
              </div>
              <div>
                <dt>Binance 중요 공지</dt>
                <dd>
                  {snapshot.riskContext.binanceCriticalNotice ? '있음' : '없음'}
                </dd>
              </div>
              <div>
                <dt>Fear & Greed</dt>
                <dd>
                  {snapshot.riskContext.fearAndGreed
                    ? `${snapshot.riskContext.fearAndGreed.value} · ${snapshot.riskContext.fearAndGreed.classification}`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>소스 경고</dt>
                <dd>
                  {snapshot.riskContext.sourceWarnings.slice(0, 3).join(', ') ||
                    '없음'}
                </dd>
              </div>
            </dl>
          </article>
        </section>
      )}

      {snapshot && scalpReady && scalpContext && localOiChanges ? (
        <section className="panel scalp-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">SCALP CONTEXT · OBJECTIVE DATA</p>
              <h3>1m·5m 초단기 구조</h3>
            </div>
            <span className="fixed-policy">
              방향·진입 신호를 생성하지 않습니다
            </span>
          </div>
          <div className="scalp-grid">
            {(['1m', '5m'] as const).map((item) => {
              const candle = scalpContext.candles[item];
              return (
                <article key={item}>
                  <strong>{item} 캔들</strong>
                  <dl>
                    <div>
                      <dt>진행률</dt>
                      <dd>
                        {candle.progressRatio === null
                          ? '마감'
                          : `${formatNumber(candle.progressRatio * 100, 1)}%`}
                      </dd>
                    </div>
                    <div>
                      <dt>몸통 / 윗꼬리 / 아랫꼬리</dt>
                      <dd>
                        {formatNumber((candle.bodyRatio ?? 0) * 100, 1)} /{' '}
                        {formatNumber((candle.upperWickRatio ?? 0) * 100, 1)} /{' '}
                        {formatNumber((candle.lowerWickRatio ?? 0) * 100, 1)}%
                      </dd>
                    </div>
                    <div>
                      <dt>EMA20 기울기</dt>
                      <dd>{formatNumber(candle.ema20SlopePerCandle, 3)}</dd>
                    </div>
                    <div>
                      <dt>VWAP 이격</dt>
                      <dd>{formatNumber(candle.vwapDistanceBps, 2)} bps</dd>
                    </div>
                    <div>
                      <dt>5/20 범위 압축비</dt>
                      <dd>{formatNumber(candle.rangeCompression5vs20, 3)}</dd>
                    </div>
                  </dl>
                </article>
              );
            })}
            <article>
              <strong>체결·호가·OI 표본</strong>
              <dl>
                <div>
                  <dt>15s / 30s 체결</dt>
                  <dd>
                    {orderFlow15s?.sampleCount ?? 0} /{' '}
                    {orderFlow30s?.sampleCount ?? 0}
                  </dd>
                </div>
                <div>
                  <dt>15s delta 변화</dt>
                  <dd>
                    {formatNumber(
                      orderFlow15s?.deltaChangeFromPreviousWindow ?? null,
                      4,
                    )}{' '}
                    BTC
                  </dd>
                </div>
                <div>
                  <dt>Depth 5s / 30s 표본</dt>
                  <dd>
                    {scalpContext.depth.sampleCount5s} /{' '}
                    {scalpContext.depth.sampleCount30s}
                  </dd>
                </div>
                <div>
                  <dt>Imbalance Δ 5s / 30s</dt>
                  <dd>
                    {formatNumber(
                      scalpContext.depth.imbalanceChange5s,
                      4,
                    )}{' '}
                    /{' '}
                    {formatNumber(
                      scalpContext.depth.imbalanceChange30s,
                      4,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>로컬 OI Δ 1m / 5m</dt>
                  <dd>
                    {formatNumber(localOiChanges['1m'], 4)}%
                    {' / '}
                    {formatNumber(localOiChanges['5m'], 4)}%
                  </dd>
                </div>
              </dl>
            </article>
          </div>
        </section>
      ) : snapshot ? (
        <section className="panel scalp-panel scalp-loading">
          <p className="eyebrow">SCALP CONTEXT</p>
          <h3>초단기 데이터 준비 중</h3>
          <p>
            v3 체결·호가·OI 표본이 준비되면 이 영역이 자동으로 갱신됩니다.
          </p>
        </section>
      ) : null}

      <section className="panel gpt-panel">
        <div>
          <p className="eyebrow">USER-INITIATED GPT HANDOFF</p>
          <h3>검증된 최신 스냅샷</h3>
          <p>자동 전송이나 OpenAI API 호출 없이 사용자가 직접 복사합니다.</p>
        </div>
        <pre>
          {snapshot
            ? JSON.stringify(snapshot, null, 2).slice(0, 1800)
            : '시장 데이터를 준비하고 있습니다.'}
        </pre>
        {snapshot && (
          <pre className="text-preview">{formatSnapshotText(snapshot)}</pre>
        )}
        <div className="gpt-actions">
          <button disabled={busy} onClick={() => void copyReadableText()}>
            사람이 읽는 텍스트 복사
          </button>
          <button
            disabled={busy || !snapshot}
            onClick={() => void copySnapshot()}
          >
            최신 분석자료 복사
          </button>
          <button
            disabled={busy || !snapshot}
            onClick={() => void copyAndOpen()}
          >
            복사 + GPT 열기
          </button>
        </div>
      </section>

      <section className="panel account-panel">
        <div>
          <p className="eyebrow">PHASE 9·10 · {snapshot?.trading.mode ?? settings.tradingMode}</p>
          <h3>고정 계획과 포지션 관리</h3>
          <p>
            앱은 객관값과 비용 차감 결과만 기록합니다. 실제 주문·부분익절·종료와
            레버리지 설정은 Binance에서 직접 수행합니다.
          </p>
        </div>
        <div className="account-status">
          <strong>
            {snapshot?.trading.activePlan
              ? `${snapshot.trading.activePlan.status} · ${snapshot.trading.activePlan.side} ${snapshot.trading.activePlan.quantity} BTC · ${snapshot.trading.activePlan.leverage}x`
              : '고정 계획 없음'}
          </strong>
          {snapshot?.trading.activePaperTrade && (
            <span>
              PAPER {snapshot.trading.activePaperTrade.status} · 잔여{' '}
              {formatNumber(snapshot.trading.activePaperTrade.remainingQuantity, 8)} BTC ·
              순실현손익{' '}
              {formatNumber(snapshot.trading.activePaperTrade.realizedNetPnl)} USDT
            </span>
          )}
          <span>
            종료 표본 {snapshot?.trading.statistics.closedTrades ?? 0} · 승률{' '}
            {snapshot?.trading.statistics.winRate === null
              ? '검증 표본 없음'
              : `${formatNumber((snapshot?.trading.statistics.winRate ?? 0) * 100, 2)}%`}
            {' · '}누적 순손익{' '}
            {formatNumber(snapshot?.trading.statistics.netPnl ?? 0)} USDT
          </span>
          {settings.tradingMode === 'PAPER' &&
            snapshot?.trading.activePlan?.status === 'LOCKED' && (
              <button onClick={() => void enterPaperTrade()}>
                고정 계획으로 PAPER 진입
              </button>
            )}
          {snapshot?.trading.activePaperTrade && (
            <button onClick={() => void closePaperTrade()}>
              현재 mark로 PAPER 전량 종료
            </button>
          )}
          {settings.tradingMode === 'LIVE_MANUAL' && (
            <span>
              LIVE 판단{' '}
              {snapshot?.trading.liveManual.available
                ? '가능'
                : `차단: ${snapshot?.trading.liveManual.blockedReasons.join(', ') || '준비 중'}`}
              {' · '}보호주문{' '}
              {snapshot?.trading.liveManual.protectiveOrders.length ?? 0}개
            </span>
          )}
        </div>
      </section>

      <section className="panel account-panel">
        <div>
          <p className="eyebrow">CLOUDFLARE RELAY</p>
          <h3>GPT Actions 중계</h3>
          <p>
            업로드 키는 OS 암호화 저장소에 보관됩니다. Action 조회 키와 반드시
            달라야 하며 Renderer로 다시 반환되지 않습니다.
          </p>
          <span className="endpoint">
            {relay?.baseUrl
              ? `${relay.baseUrl}/v1/snapshot/latest`
              : 'Action endpoint 미설정'}
          </span>
        </div>
        {relay?.configured ? (
          <div className="account-status">
            <strong>
              {relay.connected ? '5초 heartbeat 정상' : '업로드 연결 끊김'}
            </strong>
            <span>
              마지막 성공{' '}
              {relay.lastSuccessAt
                ? new Date(relay.lastSuccessAt).toLocaleString('ko-KR')
                : '없음'}
            </span>
            <span>연속 실패 {relay.consecutiveFailures}회</span>
            <button onClick={() => void disconnectRelay()}>
              중계 연결 해제 및 키 삭제
            </button>
          </div>
        ) : (
          <div className="account-form">
            <input
              aria-label="Relay URL"
              value={relayUrl}
              onChange={(event) => setRelayUrl(event.target.value)}
              placeholder="https://name.workers.dev"
            />
            <input
              aria-label="Relay Upload Key"
              type="password"
              value={relayUploadKey}
              onChange={(event) => setRelayUploadKey(event.target.value)}
              placeholder="UPLOADER_WRITE_KEY"
              autoComplete="off"
            />
            <button
              disabled={busy || relayUploadKey.length < 32 || !relayUrl}
              onClick={() => void connectRelay()}
            >
              연결 테스트 후 암호화 저장
            </button>
          </div>
        )}
      </section>

      <section className="panel account-panel">
        <div>
          <p className="eyebrow">OPTIONAL · READ ONLY</p>
          <h3>Binance 계정</h3>
          <p>
            IP 제한과 Futures 읽기 권한만 부여한 별도 키를 사용하세요. 키는 OS
            암호화 저장소로 보호되며 화면·로그·GPT에 반환되지 않습니다.
          </p>
        </div>
        {account?.configured ? (
          <div className="account-status">
            <strong>{account.connected ? '연결됨' : '연결 끊김'}</strong>
            <span>
              {account.position
                ? `${account.position.side} ${account.position.quantity} BTC · ${account.position.leverage}x ISOLATED`
                : '현재 포지션 없음'}
            </span>
            <button onClick={() => void disconnectAccount()}>
              연결 해제 및 키 삭제
            </button>
          </div>
        ) : (
          <div className="account-form">
            <input
              aria-label="Binance API Key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Read-only API Key"
              autoComplete="off"
            />
            <input
              aria-label="Binance API Secret"
              type="password"
              value={apiSecret}
              onChange={(event) => setApiSecret(event.target.value)}
              placeholder="API Secret"
              autoComplete="off"
            />
            <button
              disabled={busy || apiKey.length < 16 || apiSecret.length < 16}
              onClick={() => void connectAccount()}
            >
              연결 테스트 후 저장
            </button>
          </div>
        )}
      </section>

      <section className="panel settings-layout">
        <div>
          <p className="eyebrow">DETERMINISTIC CALCULATOR</p>
          <h3>규모·레버리지·비용 검증과 계획 고정</h3>
          <div className="account-form">
            <select
              value={calculator.side}
              onChange={(event) =>
                setCalculator((current) => ({
                  ...current,
                  side: event.target.value as 'LONG' | 'SHORT',
                }))
              }
            >
              <option>LONG</option>
              <option>SHORT</option>
            </select>
            <input
              aria-label="계산 진입가"
              value={calculator.entry}
              onChange={(event) =>
                setCalculator((current) => ({
                  ...current,
                  entry: event.target.value,
                }))
              }
              placeholder="진입가"
            />
            <input
              aria-label="계산 손절가"
              value={calculator.stop}
              onChange={(event) =>
                setCalculator((current) => ({
                  ...current,
                  stop: event.target.value,
                }))
              }
              placeholder="손절가"
            />
            <input
              aria-label="계산 목표가"
              value={calculator.target}
              onChange={(event) =>
                setCalculator((current) => ({
                  ...current,
                  target: event.target.value,
                }))
              }
              placeholder="목표가"
            />
            <input
              aria-label="선택 레버리지"
              inputMode="numeric"
              min="1"
              max="150"
              value={calculator.leverage}
              onChange={(event) =>
                setCalculator((current) => ({
                  ...current,
                  leverage: event.target.value,
                }))
              }
              placeholder="레버리지 1~150"
            />
            <select
              aria-label="규모 지정 방식"
              value={calculator.sizeMode}
              onChange={(event) =>
                setCalculator((current) => ({
                  ...current,
                  sizeMode: event.target.value as typeof current.sizeMode,
                }))
              }
            >
              <option value="MARGIN_USDT">MARGIN_USDT</option>
              <option value="QUANTITY_BTC">QUANTITY_BTC</option>
              <option value="NOTIONAL_USDT">NOTIONAL_USDT</option>
              <option value="MAX_LOSS_USDT">MAX_LOSS_USDT</option>
            </select>
            <input
              aria-label="규모 값"
              inputMode="decimal"
              value={calculator.sizeValue}
              onChange={(event) =>
                setCalculator((current) => ({
                  ...current,
                  sizeValue: event.target.value,
                }))
              }
              placeholder="선택 방식의 값"
            />
            <select
              aria-label="진입 주문 유형"
              value={calculator.entryOrderType}
              onChange={(event) =>
                setCalculator((current) => ({
                  ...current,
                  entryOrderType: event.target.value as 'MAKER' | 'TAKER',
                }))
              }
            >
              <option>TAKER</option>
              <option>MAKER</option>
            </select>
            <select
              aria-label="청산 주문 유형"
              value={calculator.exitOrderType}
              onChange={(event) =>
                setCalculator((current) => ({
                  ...current,
                  exitOrderType: event.target.value as 'MAKER' | 'TAKER',
                }))
              }
            >
              <option>TAKER</option>
              <option>MAKER</option>
            </select>
            <button onClick={() => void runCalculator()}>수량·비용 검증</button>
            <button
              disabled={!calculation?.valid}
              onClick={() => void lockPlan()}
            >
              검증값으로 계획 고정
            </button>
          </div>
          {calculation && (
            <div
              className={`calculation-result ${calculation.valid ? 'success' : 'error'}`}
            >
              <strong>
                {calculation.valid
                  ? `${calculation.quantity} BTC`
                  : calculation.errors.join(', ')}
              </strong>
              {calculation.target && (
                <span>
                  순손익 {formatNumber(calculation.target.netPnl)} USDT · 증거금
                  ROI {formatNumber(calculation.target.netMarginRoiPercent)}%
                </span>
              )}
              {calculation.notional !== null && (
                <span>
                  명목가치 {formatNumber(calculation.notional)} USDT · 격리
                  증거금 {formatNumber(calculation.isolatedMargin)} USDT ·{' '}
                  {calculation.leverage}x
                </span>
              )}
              {calculation.estimatedLiquidationPrice && (
                <span>
                  추정 청산가{' '}
                  {formatNumber(calculation.estimatedLiquidationPrice)} · 거리{' '}
                  {formatNumber(calculation.liquidationDistancePercent)}%
                </span>
              )}
              {calculation.breakevenPrice && (
                <span>
                  비용 보정 본전가 {formatNumber(calculation.breakevenPrice)}
                </span>
              )}
              {calculation.estimatedMaxLoss && (
                <span>
                  예상 최대손실 {formatNumber(calculation.estimatedMaxLoss)}{' '}
                  USDT
                </span>
              )}
            </div>
          )}
        </div>
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h3>개인 비용·위험 설정</h3>
          {account?.connected && account.commission && (
            <p>
              계정 연결 중에는 Binance 실제 수수료율(Maker{' '}
              {account.commission.makerRate}, Taker{' '}
              {account.commission.takerRate})을 우선 사용합니다.
            </p>
          )}
          <div className="account-form">
            <input
              aria-label="전용 GPT URL"
              value={settings.gptUrl}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  gptUrl: event.target.value,
                }))
              }
            />
            <input
              aria-label="Maker 수수료율"
              inputMode="decimal"
              disabled={Boolean(account?.connected && account.commission)}
              value={settingsDraft.makerFeeRate}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  makerFeeRate: event.target.value,
                }))
              }
              placeholder="Maker 수수료율 (Binance 실제 요율)"
            />
            <input
              aria-label="Taker 수수료율"
              inputMode="decimal"
              disabled={Boolean(account?.connected && account.commission)}
              value={settingsDraft.takerFeeRate}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  takerFeeRate: event.target.value,
                }))
              }
              placeholder="Taker 수수료율 (Binance 실제 요율)"
            />
            <input
              aria-label="진입 슬리피지 bps"
              inputMode="decimal"
              placeholder="진입 슬리피지 bps (초기 참고값: 1)"
              value={settingsDraft.entrySlippageBps}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  entrySlippageBps: event.target.value,
                }))
              }
            />
            <input
              aria-label="청산 슬리피지 bps"
              inputMode="decimal"
              placeholder="청산 슬리피지 bps (초기 참고값: 1)"
              value={settingsDraft.exitSlippageBps}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  exitSlippageBps: event.target.value,
                }))
              }
            />
            <input
              aria-label="최대 손실 USDT"
              inputMode="decimal"
              value={settingsDraft.maxLossUsdt}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  maxLossUsdt: event.target.value,
                }))
              }
              placeholder="최대 손실 USDT (필수)"
            />
            <input
              aria-label="계정 위험 비율"
              inputMode="decimal"
              value={settingsDraft.riskPercent}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  riskPercent: event.target.value,
                }))
              }
              placeholder="계정 위험 비율 (예: 0.01)"
            />
            <label className="fixed-policy">
              <input
                type="checkbox"
                checked={settings.autoStart}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    autoStart: event.target.checked,
                  }))
                }
              />{' '}
              Windows 로그인 시 자동실행
            </label>
            <label className="fixed-policy">
              <select
                aria-label="거래 모드"
                value={settings.tradingMode}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    tradingMode: event.target.value as 'PAPER' | 'LIVE_MANUAL',
                  }))
                }
              >
                <option value="PAPER">PAPER</option>
                <option value="LIVE_MANUAL">LIVE_MANUAL</option>
              </select>
              운영 모드
            </label>
            <label className="fixed-policy">
              <input
                aria-label="기본 레버리지"
                type="number"
                min="1"
                max="150"
                value={settings.defaultLeverage}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    defaultLeverage: Number(event.target.value),
                  }))
                }
              />
              기본 레버리지 (1~150, 기본 10)
            </label>
            <label className="fixed-policy">
              정책: 사용자 선택 1~150x · ISOLATED · 주문/레버리지 변경 API 없음
            </label>
            <button onClick={() => void saveSettings()}>설정 저장</button>
            <input
              aria-label="Naver Client ID"
              value={naverClientId}
              onChange={(event) => setNaverClientId(event.target.value)}
              placeholder="선택: Naver 뉴스 Client ID"
            />
            <input
              aria-label="Naver Client Secret"
              type="password"
              value={naverClientSecret}
              onChange={(event) => setNaverClientSecret(event.target.value)}
              placeholder="선택: Naver 뉴스 Client Secret"
            />
            <button
              disabled={busy || !naverClientId || !naverClientSecret}
              onClick={() => void configureNaver()}
            >
              Naver 뉴스 키 암호화 저장
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void window.desktopApi
                  .disconnectNaver?.()
                  .then(setResult)
                  .catch((error: unknown) =>
                    setResult({
                      ok: false,
                      message:
                        error instanceof Error
                          ? error.message
                          : 'Naver 연결 해제 실패',
                    }),
                  )
              }
            >
              Naver 뉴스 연결 해제
            </button>
            <button className="danger" onClick={() => void resetLocalData()}>
              로컬 데이터 초기화
            </button>
          </div>
        </div>
      </section>

      <section className="panel account-panel">
        <div>
          <p className="eyebrow">MANUAL FALLBACK</p>
          <h3>수동 포지션</h3>
          <p>
            계정 조회가 꺼져 있을 때만 사용하는 보조 입력입니다. 출처와
            갱신시각이 스냅샷과 화면에 명시됩니다.
          </p>
        </div>
        {manualPosition ? (
          <div className="account-status">
            <strong>
              {manualPosition.side} {manualPosition.quantity} BTC
            </strong>
            <span>
              진입가 ${formatNumber(manualPosition.entryPrice)} · MANUAL ·{' '}
              {new Date(manualPosition.updatedAt).toLocaleString('ko-KR')}
            </span>
            {renderedAt - manualPosition.updatedAt > 15 * 60_000 && (
              <span className="negative">
                수동 입력이 15분 이상 경과했습니다.
              </span>
            )}
            <button
              onClick={() =>
                void window.desktopApi
                  .clearManualPosition()
                  .then(() => setManualPosition(null))
              }
            >
              수동 포지션 삭제
            </button>
          </div>
        ) : (
          <div className="account-form">
            <select
              value={manualSide}
              onChange={(event) =>
                setManualSide(event.target.value as 'LONG' | 'SHORT')
              }
            >
              <option>LONG</option>
              <option>SHORT</option>
            </select>
            <input
              aria-label="수량 BTC"
              inputMode="decimal"
              value={manualQuantity}
              onChange={(event) => setManualQuantity(event.target.value)}
              placeholder="수량 BTC"
            />
            <input
              aria-label="진입가 USDT"
              inputMode="decimal"
              value={manualEntry}
              onChange={(event) => setManualEntry(event.target.value)}
              placeholder="진입가 USDT"
            />
            <input
              aria-label="손절가 USDT"
              inputMode="decimal"
              value={manualStop}
              onChange={(event) => setManualStop(event.target.value)}
              placeholder="손절가 (선택)"
            />
            {manualTargets.map((target, index) => (
              <input
                key={index}
                aria-label={`목표가 ${index + 1}`}
                inputMode="decimal"
                value={target}
                onChange={(event) =>
                  setManualTargets((current) =>
                    current.map((value, itemIndex) =>
                      itemIndex === index ? event.target.value : value,
                    ),
                  )
                }
                placeholder={`TP${index + 1} (선택)`}
              />
            ))}
            <button
              disabled={Number(manualQuantity) <= 0 || Number(manualEntry) <= 0}
              onClick={() => void saveManualPosition()}
            >
              수동 포지션 저장
            </button>
          </div>
        )}
      </section>

      <footer>
        <span>안전 경계</span>
        <strong>1~150x 사용자 선택 · Isolated · 수동 주문 전용</strong>
        <p>주문 생성·수정·취소 API 없음</p>
      </footer>
    </main>
  );
}
