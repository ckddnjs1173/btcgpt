import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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
    timeframeCounts: {
      '1m': 0,
      '3m': 0,
      '5m': 0,
      '15m': 0,
      '30m': 0,
      '1h': 0,
      '4h': 0,
    },
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
    stream: {
      status: 'DISCONNECTED',
      lastEventAt: null,
      lastAccountUpdateAt: null,
      lastOrderTradeUpdateAt: null,
      reconnectCount: 0,
      error: null,
    },
    position: null,
    commission: null,
    balance: null,
    openOrders: [],
    recentTrades: [],
    leverageBrackets: [],
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
    tradingMode: 'PAPER',
    defaultLeverage: 10,
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

  it('loads the read-only market dashboard with configurable isolated leverage', async () => {
    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'BTC Futures Assistant' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('선택 레버리지')).toHaveValue('10');
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

  it('does not reset an in-progress numeric setting on status refresh', async () => {
    render(<App />);
    const makerInput = await screen.findByLabelText('Maker 수수료율');
    fireEvent.change(makerInput, { target: { value: '0.00017' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(makerInput).toHaveValue('0.00017');
  });
});
