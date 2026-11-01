import { vi } from 'vitest';
import { tokenStore } from '../src/api/auth';
import { ApiClient } from '../src/api/client';
import { ApiError, sanitizeMessage } from '../src/api/errors';
import { createLiveApi } from '../src/api/live';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const sandboxBody = {
  id: 's1',
  name: 'a',
  team: 't',
  status: 'active',
  created_at: '2026-03-12T09:00:00Z',
};

describe('API client', () => {
  it('does not expose secrets or stack traces in error messages', async () => {
    const fetchImpl = vi.fn(async () =>
      json(500, {
        error: { code: 'x', message: 'failed with Bearer abc.def.ghi and token=supersecret' },
        trace_id: 'trc-1',
      }),
    );
    const api = createLiveApi({
      baseUrl: '/api',
      timeoutMs: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await api.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.message).not.toMatch(/abc\.def|supersecret/);
    expect(e.traceId).toBe('trc-1');
    expect(
      sanitizeMessage('Traceback (most recent call last):\n  File "x.py"', 'safe fallback'),
    ).toBe('safe fallback');
  });

  it('turns malformed responses into an error instead of a fake success', async () => {
    const fetchImpl = vi.fn(async () => json(200, { unexpected: true }));
    const api = createLiveApi({
      baseUrl: '/api',
      timeoutMs: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(api.sandboxes.get('s1')).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('treats 202 as an accepted job and 201 as a finished resource', async () => {
    const accepted = createLiveApi({
      baseUrl: '/api',
      timeoutMs: 500,
      fetchImpl: (async () =>
        json(202, { id: 'job-1', status: 'pending' })) as unknown as typeof fetch,
    });
    expect(
      await accepted.sandboxes.provision({ name: 'abc', team: 't', ttl_hours: 1 }, 'k'),
    ).toMatchObject({ kind: 'accepted', job: { id: 'job-1' } });
    const done = createLiveApi({
      baseUrl: '/api',
      timeoutMs: 500,
      fetchImpl: (async () => json(201, sandboxBody)) as unknown as typeof fetch,
    });
    expect(
      await done.sandboxes.provision({ name: 'abc', team: 't', ttl_hours: 1 }, 'k'),
    ).toMatchObject({ kind: 'done', result: { id: 's1' } });
  });

  it('never retries a mutation and sends an idempotency key', async () => {
    const fetchImpl = vi.fn(async () => json(503, { error: { message: 'unavailable' } }));
    const api = createLiveApi({
      baseUrl: '/api',
      timeoutMs: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      api.sandboxes.provision({ name: 'abc', team: 't', ttl_hours: 1 }, 'key-123'),
    ).rejects.toMatchObject({ kind: 'server' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-123');
  });

  it('sends a bearer token only when one is configured', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { status: 'ok', checked_at: 'x', components: [], capabilities: {} }),
    );
    const client = new ApiClient({
      baseUrl: '/api',
      timeoutMs: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const api = createLiveApi({
      baseUrl: '/api',
      timeoutMs: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    void client;
    await api.health();
    expect(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
    ).not.toHaveProperty('Authorization');
    tokenStore.set('abc123');
    await api.health();
    expect((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toHaveProperty(
      'Authorization',
      'Bearer abc123',
    );
    tokenStore.clear();
  });

  it('normalises status codes and network failures', async () => {
    const make = (status: number) =>
      createLiveApi({
        baseUrl: '/api',
        timeoutMs: 500,
        fetchImpl: (async () => json(status, {})) as unknown as typeof fetch,
      });
    const expected: Array<[number, string]> = [
      [401, 'auth'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [422, 'validation'],
      [429, 'rate_limited'],
      [500, 'server'],
    ];
    for (const [status, kind] of expected)
      await expect(make(status).health()).rejects.toMatchObject({ kind, status });
    const offline = createLiveApi({
      baseUrl: '/api',
      timeoutMs: 500,
      fetchImpl: (() => Promise.reject(new TypeError('x'))) as unknown as typeof fetch,
    });
    await expect(offline.health()).rejects.toMatchObject({ kind: 'network' });
  });
});
