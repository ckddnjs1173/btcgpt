import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/renderer/App';
import type { DesktopApi } from '../../src/shared/contracts';

const desktopApiMock: DesktopApi = {
  getPhaseZeroStatus: vi.fn().mockResolvedValue({
    appVersion: '0.1.0',
    platform: 'win32',
    databaseReady: true,
    notificationSupported: true,
    trayReady: true,
    security: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }),
  testNotification: vi.fn(),
  copyText: vi
    .fn()
    .mockResolvedValue({ ok: true, message: '클립보드에 복사했습니다.' }),
  openExternal: vi
    .fn()
    .mockResolvedValue({ ok: true, message: 'ChatGPT를 열었습니다.' }),
  writeDbCheck: vi.fn().mockResolvedValue({
    ok: true,
    value: 'test',
    updatedAt: 1_700_000_000_000,
    recordCount: 1,
  }),
  readDbCheck: vi.fn().mockResolvedValue({
    ok: true,
    value: null,
    updatedAt: null,
    recordCount: 0,
  }),
  getMarketStatus: vi.fn().mockResolvedValue({
    symbol: 'BTCUSDT',
    lastSnapshotAt: null,
    markPrice: null,
    indexPrice: null,
    timeframeCounts: { '5m': 0, '15m': 0, '1h': 0, '4h': 0 },
    dataStatus: 'INITIALIZING',
  }),
  getLatestSnapshot: vi.fn().mockRejectedValue(new Error('not ready')),
  configureAccount: vi.fn(),
  disconnectAccount: vi.fn(),
  getAccountStatus: vi.fn().mockResolvedValue({
    configured: false,
    connected: false,
    lastUpdatedAt: null,
    error: null,
    position: null,
    commission: null,
    balance: null,
    openOrders: [],
  }),
  saveManualPosition: vi.fn(),
  clearManualPosition: vi.fn(),
  getManualPosition: vi.fn().mockResolvedValue(null),
  getRelayStatus: vi.fn().mockResolvedValue({
    configured: false,
    baseUrl: null,
    connected: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    error: null,
  }),
  getUserSettings: vi.fn().mockResolvedValue({
    gptUrl: 'https://chatgpt.com/',
    makerFeeRate: null,
    takerFeeRate: null,
    entrySlippageBps: 1,
    exitSlippageBps: 1,
    maxLossUsdt: null,
    riskPercent: null,
    partialTakeProfitRatios: [0.3, 0.3, 0.4],
    minimumNetMarginRoiPercent: 2,
    autoStart: false,
  }),
  saveUserSettings: vi.fn(),
  calculatePositionPlan: vi.fn(),
  configureRelay: vi.fn(),
  disconnectRelay: vi.fn(),
  resetLocalData: vi.fn(),
};

describe('Phase 0 dashboard', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      value: desktopApiMock,
    });
  });

  it('loads the read-only market dashboard without trading actions', async () => {
    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'BTC Futures Assistant' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/10x · Isolated/)).toBeInTheDocument();
    expect(screen.queryByText('자동매매 시작')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText('INITIALIZING').length).toBeGreaterThan(0);
    });
  });

  it('keeps snapshot actions disabled before data is available', async () => {
    render(<App />);
    expect(
      await screen.findByRole('button', { name: '최신 분석자료 복사' }),
    ).toBeDisabled();
  });
});
