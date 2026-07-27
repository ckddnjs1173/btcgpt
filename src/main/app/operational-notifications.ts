import { Notification } from 'electron';

import type { DataStatus, RelayStatus } from '../../shared/contracts';

type AlertKey = 'market-disconnected' | 'analysis-blocked' | 'relay-failed';

export class OperationalNotificationMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly active = new Set<AlertKey>();

  constructor(
    private readonly getMarketStatus: () => DataStatus,
    private readonly getRelayStatus: () => RelayStatus,
  ) {}

  start(): void {
    if (this.timer || !Notification.isSupported()) return;
    this.timer = setInterval(() => this.check(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private check(): void {
    const marketStatus = this.getMarketStatus();
    this.toggle(
      'market-disconnected',
      marketStatus === 'DISCONNECTED',
      'Binance 연결 중단',
      '공개 시장 데이터 연결이 중단되었습니다. 앱에서 복구 상태를 확인하세요.',
    );
    this.toggle(
      'analysis-blocked',
      ['STALE', 'INSUFFICIENT_DATA'].includes(marketStatus),
      '시장 분석 차단',
      '필수 데이터가 오래되었거나 부족해 신규 분석이 차단되었습니다.',
    );
    const relay = this.getRelayStatus();
    this.toggle(
      'relay-failed',
      relay.configured && relay.consecutiveFailures >= 3,
      '중계 업로드 실패',
      '중계소 업로드가 반복 실패했습니다. 복사 방식 fallback을 사용하세요.',
    );
  }

  private toggle(
    key: AlertKey,
    shouldAlert: boolean,
    title: string,
    body: string,
  ): void {
    if (!shouldAlert) {
      this.active.delete(key);
      return;
    }
    if (this.active.has(key)) return;
    this.active.add(key);
    new Notification({
      title: `BTC Futures Assistant · ${title}`,
      body,
    }).show();
  }
}
