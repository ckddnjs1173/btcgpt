import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/renderer/App';
import type { DesktopApi } from '../../src/shared/contracts';

const testNotificationMock = vi
  .fn()
  .mockResolvedValue({ ok: true, message: '테스트 알림을 보냈습니다.' });
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
  testNotification: testNotificationMock,
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
};

describe('Phase 0 dashboard', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      value: desktopApiMock,
    });
  });

  it('loads runtime readiness without exposing trading actions', async () => {
    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'BTC Futures Assistant' }),
    ).toBeInTheDocument();
    expect(screen.getByText('수동주문 전용')).toBeInTheDocument();
    expect(screen.queryByText('자동매매 시작')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText('READY')).toHaveLength(4);
    });
  });

  it('calls the restricted notification bridge', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 테스트' }));

    await waitFor(() => {
      expect(testNotificationMock).toHaveBeenCalledOnce();
    });
    expect(
      await screen.findByText('테스트 알림을 보냈습니다.'),
    ).toBeInTheDocument();
  });
});
