import { Notification } from 'electron';

import type {
  ApprovedPlanMonitoring,
  LockedTradePlan,
  MarketSnapshot,
  TradingMode,
} from '../../shared/contracts';
import type { AppDatabase } from '../db/database';
import { logger } from '../logging/logger';

const MONITOR_INTERVAL_MS = 1_000;

function conditionMet(
  condition: ApprovedPlanMonitoring['triggerCondition'],
  price: number,
  threshold: number,
): boolean {
  return condition === 'AT_OR_ABOVE' ? price >= threshold : price <= threshold;
}

function currentMode(database: AppDatabase): TradingMode {
  return database.readUserSettings().tradingMode;
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: `BTC Futures Assistant · ${title}`,
    body,
  }).show();
}

export class ApprovedPlanMonitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly getSnapshot: () => MarketSnapshot,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), MONITOR_INTERVAL_MS);
    this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private saveMonitoring(
    plan: LockedTradePlan,
    monitoring: ApprovedPlanMonitoring,
  ): void {
    this.database.saveLockedTradePlan({ ...plan, monitoring });
  }

  private check(): void {
    const plan = this.database.readActiveLockedTradePlan(
      currentMode(this.database),
    );
    if (!plan || plan.status !== 'LOCKED') return;

    const monitoring = plan.monitoring;
    if (!monitoring) return;

    const now = Date.now();
    if (monitoring.authoredBy !== 'GPT') {
      this.transition(plan, {
        ...monitoring,
        state: 'CANCELLED',
        cancelledAt: now,
      });
      showNotification(
        '기존 감시 계획 취소',
        '프로그램이 자동 생성했던 구형 트리거는 더 이상 사용하지 않습니다. GPT에서 최신 조건을 다시 받아 승인하세요.',
      );
      return;
    }

    if (now >= monitoring.expiresAt) {
      this.transition(plan, {
        ...monitoring,
        state: 'EXPIRED',
        expiredAt: now,
      });
      showNotification(
        '승인 계획 만료',
        `${plan.side} 계획이 만료되었습니다. 최신 Decision Context로 다시 분석한 뒤 새 계획을 승인하세요.`,
      );
      return;
    }

    let snapshot: MarketSnapshot;
    try {
      snapshot = this.getSnapshot();
    } catch (error) {
      logger.warn(
        {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 200)
              : 'Unknown plan-monitor snapshot error',
        },
        'Approved plan monitor could not read a snapshot',
      );
      return;
    }

    const markPrice = snapshot.marketState.markPrice;
    const marketHealth = snapshot.sourceHealth.market;
    if (
      markPrice === null ||
      !marketHealth ||
      ['STALE', 'DISCONNECTED', 'INSUFFICIENT_DATA'].includes(
        marketHealth.status,
      )
    )
      return;

    if (
      conditionMet(
        monitoring.invalidationCondition,
        markPrice,
        monitoring.invalidationPrice,
      )
    ) {
      this.transition(plan, {
        ...monitoring,
        state: 'INVALIDATED',
        invalidatedAt: now,
      });
      showNotification(
        '승인 계획 무효화',
        `${plan.side} 계획 무효화 가격 ${monitoring.invalidationPrice} 도달 · 현재 Mark ${markPrice}. 주문을 누르지 말고 새 GPT 분석을 확인하세요.`,
      );
      return;
    }

    if (monitoring.state !== 'ARMED' && monitoring.state !== 'WATCHING') return;

    const matched = conditionMet(
      monitoring.triggerCondition,
      markPrice,
      monitoring.triggerPrice,
    );
    if (!matched) {
      if (monitoring.conditionMatchedAt !== null)
        this.saveMonitoring(plan, {
          ...monitoring,
          conditionMatchedAt: null,
        });
      return;
    }

    const conditionMatchedAt = monitoring.conditionMatchedAt ?? now;
    if (monitoring.conditionMatchedAt === null && monitoring.confirmWindowSec > 0)
      this.saveMonitoring(plan, {
        ...monitoring,
        conditionMatchedAt,
      });

    if (now - conditionMatchedAt < monitoring.confirmWindowSec * 1_000) return;

    const updated: ApprovedPlanMonitoring = {
      ...monitoring,
      state: 'TRIGGERED',
      conditionMatchedAt,
      triggeredAt: now,
    };
    this.saveMonitoring(plan, updated);
    showNotification(
      'GPT 재분석 필요',
      `${plan.side} 승인 트리거가 충족되었습니다. 자동 진입은 하지 않습니다. 최신 Decision Context로 GPT 재분석 후 새 계획을 검증·고정하세요.`,
    );
    logger.info(
      {
        planId: plan.id,
        triggerId: monitoring.triggerId,
        decisionId: monitoring.decisionId,
        triggerPrice: monitoring.triggerPrice,
        maxChaseBps: monitoring.maxChaseBps,
      },
      'Approved GPT trigger satisfied; reanalysis required',
    );
  }

  private transition(
    plan: LockedTradePlan,
    monitoring: ApprovedPlanMonitoring,
  ): void {
    this.database.saveLockedTradePlan({
      ...plan,
      status: 'CANCELLED',
      monitoring,
    });
    logger.info(
      { planId: plan.id, monitoringState: monitoring.state },
      'Approved plan monitoring ended',
    );
  }
}
