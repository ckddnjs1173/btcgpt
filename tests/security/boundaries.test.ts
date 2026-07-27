import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppLogger } from '../../src/main/logging/logger';

function read(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
}

describe('security boundaries', () => {
  it('keeps the hardened BrowserWindow settings', () => {
    const source = read('src/main/app/create-window.ts');
    expect(source).toContain('nodeIntegration: false');
    expect(source).toContain('contextIsolation: true');
    expect(source).toContain('sandbox: true');
    expect(source).toContain("return { action: 'deny' }");
  });

  it('does not expose raw ipcRenderer or order mutation channels', () => {
    const preload = read('src/preload/index.ts');
    expect(preload).not.toContain("exposeInMainWorld('ipcRenderer'");
    const contracts = read('src/shared/contracts.ts').toLowerCase();
    expect(contracts).not.toMatch(
      /createorder|cancelorder|modifyorder|withdraw|transfer/,
    );
  });

  it('contains no OpenAI API client or Binance mutation endpoint', () => {
    const files = [
      'src/main/binance/account/rest.ts',
      'src/main/binance/public/rest.ts',
      'worker/src/index.ts',
    ]
      .map(read)
      .join('\n')
      .toLowerCase();
    expect(files).not.toContain('api.openai.com');
    expect(files).not.toContain('/fapi/v1/order');
  });

  it('redacts all mandated secret field names', () => {
    const logger = read('src/main/logging/logger.ts');
    for (const field of [
      'apiKey',
      'apiSecret',
      'signature',
      'authorization',
      'UPLOADER_WRITE_KEY',
      'ACTION_READ_KEY',
      'relayUploadKey',
      'actionReadKey',
    ])
      expect(logger).toContain(field);
    let output = '';
    const testLogger = createAppLogger({
      write(message: string) {
        output += message;
      },
    });
    testLogger.info({
      apiKey: 'visible-api-key',
      apiSecret: 'visible-api-secret',
      authorization: 'Bearer visible-token',
      nested: { signature: 'visible-signature' },
    });
    expect(output).not.toContain('visible-api-key');
    expect(output).not.toContain('visible-api-secret');
    expect(output).not.toContain('visible-token');
    expect(output).not.toContain('visible-signature');
    expect(output).toContain('[REDACTED]');
  });
});
