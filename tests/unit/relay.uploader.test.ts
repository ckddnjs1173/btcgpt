// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketCache } from '../../src/main/market/cache';
import { RelayUploader } from '../../src/main/relay/uploader';

describe('RelayUploader snapshot settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the Worker health endpoint for connection checks', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const uploader = new RelayUploader(new MarketCache(), {
      baseUrl: 'https://relay.example.workers.dev',
      uploadKey: 'x'.repeat(32),
    });

    await uploader.testConnection();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [input, init] = call!;
    expect(input).toBe('https://relay.example.workers.dev/health');
    expect(init?.method).toBe('GET');
  });

  it('publishes the current fee and slippage settings from its provider', async () => {
    let uploadedBody: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
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

  it('uploads snapshots with the Worker Bearer write contract', async () => {
    const uploadKey = 'u'.repeat(32);
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const uploader = new RelayUploader(new MarketCache(), {
      baseUrl: 'https://relay.example.workers.dev/',
      uploadKey,
    });

    await uploader.uploadOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [input, init] = call!;
    const headers = new Headers(init?.headers);
    expect(input).toBe('https://relay.example.workers.dev/v1/snapshot/latest');
    expect(init?.method).toBe('PUT');
    expect(headers.get('authorization')).toBe(`Bearer ${uploadKey}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('x-upload-key')).toBe(false);
  });

  it('captures relay round-trip and server receive timing', async () => {
    const relayReceivedAt = Date.now() + 25;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, receivedAt: relayReceivedAt }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        ),
      ),
    );
    const uploader = new RelayUploader(new MarketCache(), {
      baseUrl: 'https://relay.example.workers.dev',
      uploadKey: 'x'.repeat(32),
    });

    await uploader.uploadOnce();
    const status = uploader.getStatus();
    expect(status.connected).toBe(true);
    expect(status.lastServerReceivedAt).toBe(relayReceivedAt);
    expect(status.lastSnapshotGeneratedAt).toEqual(expect.any(Number));
    expect(status.lastRoundTripMs).toEqual(expect.any(Number));
    expect(status.lastMarketToRelayReceiveMs).toEqual(expect.any(Number));
    expect(status.lastRoundTripMs).toBeGreaterThanOrEqual(0);
    expect(status.lastMarketToRelayReceiveMs).toBeGreaterThanOrEqual(0);
  });

  it('serializes uploads so an older request cannot finish last', async () => {
    const resolvers: Array<() => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(() => resolve(new Response(null, { status: 204 })));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const uploader = new RelayUploader(new MarketCache(), {
      baseUrl: 'https://relay.example.workers.dev',
      uploadKey: 'x'.repeat(32),
    });

    const firstUpload = uploader.uploadOnce();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await uploader.uploadOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolvers.shift()?.();
    await firstUpload;

    const secondUpload = uploader.uploadOnce();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolvers.shift()?.();
    await secondUpload;
  });
});
