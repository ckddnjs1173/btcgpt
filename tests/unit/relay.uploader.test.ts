// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketCache } from '../../src/main/market/cache';
import { RelayUploader } from '../../src/main/relay/uploader';

describe('RelayUploader snapshot settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the current fee and slippage settings from its provider', async () => {
    let uploadedBody: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init?: RequestInit) => {
        uploadedBody = typeof init?.body === 'string' ? init.body : null;
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    const uploader = new RelayUploader(
      new MarketCache(),
      {
        baseUrl: 'https://relay.example.workers.dev',
        uploadKey: 'x'.repeat(32),
      },
      () => ({
        makerFeeRate: 0.00017,
        takerFeeRate: 0.00042,
        entrySlippageBps: 1.25,
        exitSlippageBps: 1.75,
      }),
    );

    uploader.start();
    try {
      await vi.waitFor(() => expect(uploadedBody).not.toBeNull());
      const uploaded = JSON.parse(uploadedBody!) as {
        costSettings: Record<string, number>;
      };
      expect(uploaded.costSettings).toEqual({
        makerFeeRate: 0.00017,
        takerFeeRate: 0.00042,
        entrySlippageBps: 1.25,
        exitSlippageBps: 1.75,
      });
    } finally {
      uploader.stop();
    }
  });
});
