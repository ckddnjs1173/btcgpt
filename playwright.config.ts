import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  timeout: 30_000,
  workers: 1,
  reporter: 'line',
  use: {
    trace: 'retain-on-failure',
  },
});
