import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

const executablePath = path.join(
  process.cwd(),
  'node_modules',
  'electron',
  'dist',
  'electron.exe',
);

test('runs the real Electron app securely and restores settings', async () => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'btcgpt-playwright-'),
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== 'ELECTRON_RUN_AS_NODE' && typeof entry[1] === 'string',
    ),
  );
  const launch = () =>
    electron.launch({
      executablePath,
      args: [process.cwd()],
      env: {
        ...environment,
        NODE_ENV: 'test',
        BTC_E2E_USER_DATA_DIR: userDataPath,
        BTC_E2E_DISABLE_MARKET: '1',
      },
    });

  let electronApp = await launch();
  try {
    const page = await electronApp.firstWindow();
    await expect(
      page.getByRole('heading', { name: 'BTC Futures Assistant' }),
    ).toBeVisible();
    const security = await electronApp.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents as
        | (Electron.WebContents & {
            getLastWebPreferences(): {
              nodeIntegration?: boolean;
              contextIsolation?: boolean;
              sandbox?: boolean;
            };
          })
        | undefined;
      const preferences = contents?.getLastWebPreferences();
      return {
        nodeIntegration: preferences?.nodeIntegration,
        contextIsolation: preferences?.contextIsolation,
        sandbox: preferences?.sandbox,
      };
    });
    expect(security).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');

    await page.getByLabel('Maker 수수료율').fill('0.00017');
    await page.getByLabel('Taker 수수료율').fill('0.00042');
    await page.getByLabel('진입 슬리피지 bps').fill('1.25');
    await page.getByLabel('청산 슬리피지 bps').fill('1.75');
    await page.getByLabel('최대 손실 USDT').fill('50');
    await page.getByRole('button', { name: '설정 저장' }).click();
    await expect(page.getByText('계산·GPT 설정을 저장했습니다.')).toBeVisible();
  } finally {
    await electronApp.close();
  }

  electronApp = await launch();
  try {
    const page = await electronApp.firstWindow();
    await expect(page.getByLabel('Maker 수수료율')).toHaveValue('0.00017');
    await expect(page.getByLabel('Taker 수수료율')).toHaveValue('0.00042');
    await expect(page.getByLabel('진입 슬리피지 bps')).toHaveValue('1.25');
    await expect(page.getByLabel('청산 슬리피지 bps')).toHaveValue('1.75');
    await expect(page.getByLabel('최대 손실 USDT')).toHaveValue('50');
  } finally {
    await electronApp.close();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
