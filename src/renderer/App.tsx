import { useCallback, useEffect, useState } from 'react';

import type {
  ActionResult,
  DatabaseCheck,
  PhaseZeroStatus,
} from '../shared/contracts';

type ActionKey = 'clipboard' | 'database' | 'external' | 'notification';

interface ActionState {
  key: ActionKey | null;
  result: ActionResult | null;
}

const GPT_URL = 'https://chatgpt.com/';
const PHASE_ZERO_CLIPBOARD_TEXT = [
  '# BTC Futures Assistant',
  '',
  'Phase 0 클립보드 테스트가 정상적으로 실행되었습니다.',
  '실제 시장 분석자료 생성기는 Phase 5에서 연결됩니다.',
].join('\n');

function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) {
    return '아직 저장된 값 없음';
  }

  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(timestamp);
}

export function App() {
  const [status, setStatus] = useState<PhaseZeroStatus | null>(null);
  const [databaseCheck, setDatabaseCheck] = useState<DatabaseCheck | null>(
    null,
  );
  const [actionState, setActionState] = useState<ActionState>({
    key: null,
    result: null,
  });
  const [loadingError, setLoadingError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const [nextStatus, nextDatabaseCheck] = await Promise.all([
        window.desktopApi.getPhaseZeroStatus(),
        window.desktopApi.readDbCheck(),
      ]);

      setStatus(nextStatus);
      setDatabaseCheck(nextDatabaseCheck);
      setLoadingError(null);
    } catch (error) {
      setLoadingError(
        error instanceof Error ? error.message : '앱 상태를 읽지 못했습니다.',
      );
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const runAction = useCallback(
    async (key: ActionKey, action: () => Promise<ActionResult>) => {
      setActionState({ key, result: null });

      try {
        const result = await action();
        setActionState({ key: null, result });
      } catch (error) {
        setActionState({
          key: null,
          result: {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : '요청을 처리하지 못했습니다.',
          },
        });
      }
    },
    [],
  );

  const testDatabase = useCallback(async () => {
    setActionState({ key: 'database', result: null });

    try {
      const result = await window.desktopApi.writeDbCheck({
        value: `Phase 0 확인 · ${new Date().toISOString()}`,
      });
      setDatabaseCheck(result);
      setActionState({
        key: null,
        result: {
          ok: result.ok,
          message: result.ok
            ? 'SQLite 저장·조회가 완료됐습니다.'
            : 'SQLite 확인에 실패했습니다.',
        },
      });
      await loadStatus();
    } catch (error) {
      setActionState({
        key: null,
        result: {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : 'SQLite 확인에 실패했습니다.',
        },
      });
    }
  }, [loadStatus]);

  const readinessItems = [
    {
      label: 'Main / Preload / Renderer',
      detail: '보안 경계 적용',
      ready: status !== null,
    },
    {
      label: 'SQLite',
      detail: databaseCheck?.ok ? '로컬 DB 연결됨' : '확인 중',
      ready: databaseCheck?.ok ?? false,
    },
    {
      label: 'Windows 알림',
      detail: status?.notificationSupported ? '사용 가능' : '플랫폼 확인 필요',
      ready: status?.notificationSupported ?? false,
    },
    {
      label: '시스템 트레이',
      detail: status?.trayReady ? '트레이 실행 중' : '확인 중',
      ready: status?.trayReady ?? false,
    },
  ];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ₿
          </span>
          <div>
            <p className="eyebrow">LOCAL DESKTOP ASSISTANT</p>
            <h1>BTC Futures Assistant</h1>
          </div>
        </div>
        <div className="phase-badge">
          <span className="phase-dot" />
          Phase 0 · 기술검증
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow accent">FOUNDATION READY</p>
          <h2>시장 감시를 시작하기 전, 로컬 기반을 검증합니다.</h2>
          <p className="hero-copy">
            현재 버전에는 실시간 시세와 거래 신호가 없습니다. Windows 기능,
            SQLite 저장소, 보안 IPC가 정상인지 먼저 확인합니다.
          </p>
        </div>
        <div className="safety-card">
          <span className="safety-icon">!</span>
          <div>
            <strong>수동주문 전용</strong>
            <p>자동 진입·청산·주문 API는 구현하지 않습니다.</p>
          </div>
        </div>
      </section>

      {loadingError !== null && (
        <div className="notice error" role="alert">
          {loadingError}
        </div>
      )}

      {actionState.result !== null && (
        <div
          className={`notice ${actionState.result.ok ? 'success' : 'error'}`}
          role="status"
        >
          {actionState.result.message}
        </div>
      )}

      <section className="readiness-grid" aria-label="Phase 0 준비 상태">
        {readinessItems.map((item) => (
          <article className="status-card" key={item.label}>
            <div className="status-card-head">
              <span className={`status-light ${item.ready ? 'ready' : ''}`} />
              <span>{item.ready ? 'READY' : 'CHECK'}</span>
            </div>
            <strong>{item.label}</strong>
            <p>{item.detail}</p>
          </article>
        ))}
      </section>

      <section className="workspace-grid">
        <article className="panel action-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">DESKTOP CHECKS</p>
              <h3>로컬 기능 테스트</h3>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={() => void loadStatus()}
            >
              상태 새로고침
            </button>
          </div>

          <div className="action-list">
            <div className="action-row">
              <div>
                <strong>Windows 알림</strong>
                <p>운영체제 알림센터에 테스트 메시지를 보냅니다.</p>
              </div>
              <button
                type="button"
                disabled={actionState.key !== null}
                onClick={() =>
                  void runAction('notification', () =>
                    window.desktopApi.testNotification(),
                  )
                }
              >
                {actionState.key === 'notification' ? '확인 중' : '알림 테스트'}
              </button>
            </div>

            <div className="action-row">
              <div>
                <strong>클립보드</strong>
                <p>Phase 5 GPT 전달 기능에 사용할 복사 경로를 확인합니다.</p>
              </div>
              <button
                type="button"
                disabled={actionState.key !== null}
                onClick={() =>
                  void runAction('clipboard', () =>
                    window.desktopApi.copyText(PHASE_ZERO_CLIPBOARD_TEXT),
                  )
                }
              >
                {actionState.key === 'clipboard' ? '복사 중' : '테스트 복사'}
              </button>
            </div>

            <div className="action-row">
              <div>
                <strong>외부 URL</strong>
                <p>허용목록에 있는 ChatGPT 주소만 브라우저로 엽니다.</p>
              </div>
              <button
                type="button"
                disabled={actionState.key !== null}
                onClick={() =>
                  void runAction('external', () =>
                    window.desktopApi.openExternal(GPT_URL),
                  )
                }
              >
                {actionState.key === 'external' ? '여는 중' : 'ChatGPT 열기'}
              </button>
            </div>

            <div className="action-row">
              <div>
                <strong>SQLite 저장소</strong>
                <p>테스트값을 저장한 뒤 다시 읽어 영속성을 확인합니다.</p>
              </div>
              <button
                type="button"
                disabled={actionState.key !== null}
                onClick={() => void testDatabase()}
              >
                {actionState.key === 'database' ? '저장 중' : 'DB 저장·조회'}
              </button>
            </div>
          </div>
        </article>

        <aside className="panel detail-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">RUNTIME</p>
              <h3>실행 정보</h3>
            </div>
          </div>

          <dl className="runtime-list">
            <div>
              <dt>앱 버전</dt>
              <dd>{status?.appVersion ?? '확인 중'}</dd>
            </div>
            <div>
              <dt>플랫폼</dt>
              <dd>{status?.platform ?? '확인 중'}</dd>
            </div>
            <div>
              <dt>DB 레코드</dt>
              <dd>{databaseCheck?.recordCount ?? 0}</dd>
            </div>
            <div>
              <dt>마지막 DB 확인</dt>
              <dd>{formatTimestamp(databaseCheck?.updatedAt ?? null)}</dd>
            </div>
          </dl>

          <div className="security-box">
            <p className="eyebrow">SECURITY BOUNDARY</p>
            <ul>
              <li>Context isolation 활성</li>
              <li>Node integration 비활성</li>
              <li>Renderer sandbox 활성</li>
              <li>동적 IPC 채널 미노출</li>
            </ul>
          </div>
        </aside>
      </section>

      <footer>
        <span>다음 단계</span>
        <strong>Phase 1 · Binance 공개 시장 데이터</strong>
        <p>Phase 0 검증과 Windows 패키징이 완료된 후 진행합니다.</p>
      </footer>
    </main>
  );
}
