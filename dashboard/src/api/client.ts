import type { z } from 'zod';
import { tokenStore } from './auth';
import {
  ApiError,
  defaultMessage,
  kindFromStatus,
  sanitizeMessage,
  type ApiErrorKind,
} from './errors';
import { JobSchema, type Operation } from './contracts';

export interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  idempotencyKey?: string;
}

interface RawResponse {
  status: number;
  body: unknown;
}

export class ApiClient {
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = { getToken: () => tokenStore.get(), ...opts };
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private buildUrl(path: string, query?: RequestOptions<unknown>['query']): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return `${base}${path}${qs ? `?${qs}` : ''}`;
  }

  /** Low-level request: timeout, cancellation, auth, error normalisation. No retries. */
  private async raw(
    path: string,
    o: Omit<RequestOptions<unknown>, 'schema'>,
  ): Promise<RawResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.timeoutMs);
    const onAbort = () => controller.abort();
    o.signal?.addEventListener('abort', onAbort);

    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.opts.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;

    let response: Response;
    try {
      response = await (this.opts.fetchImpl ?? fetch)(this.buildUrl(path, o.query), {
        method: o.method ?? 'GET',
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: controller.signal,
        credentials: 'same-origin',
      });
    } catch (err) {
      if (o.signal?.aborted) throw err; // caller cancelled: let it propagate untouched
      const kind: ApiErrorKind = timedOut ? 'timeout' : 'network';
      throw new ApiError({ kind, message: defaultMessage(kind) });
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }

    let body: unknown = null;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) throw this.toError(response, body);
    return { status: response.status, body };
  }

  private toError(response: Response, body: unknown): ApiError {
    const kind = kindFromStatus(response.status);
    const envelope = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const inner = (
      typeof envelope.error === 'object' && envelope.error !== null ? envelope.error : {}
    ) as Record<string, unknown>;
    const fieldErrors: Record<string, string> = {};
    if (Array.isArray(inner.details)) {
      for (const d of inner.details as Array<Record<string, unknown>>) {
        if (typeof d.field === 'string')
          fieldErrors[d.field] = sanitizeMessage(d.message, 'Invalid value');
      }
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    return new ApiError({
      kind,
      status: response.status,
      message: sanitizeMessage(
        inner.message ?? (typeof envelope.error === 'string' ? envelope.error : undefined),
        defaultMessage(kind),
      ),
      code: typeof inner.code === 'string' ? inner.code : undefined,
      traceId:
        (typeof envelope.trace_id === 'string' ? envelope.trace_id : undefined) ??
        response.headers.get('x-request-id') ??
        undefined,
      fieldErrors,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    });
  }

  private parse<T>(schema: z.ZodType<T>, body: unknown, status: number): T {
    const result = schema.safeParse(body);
    if (!result.success) {
      console.error('[API schema validation error]', JSON.stringify(result.error.issues), body);
      throw new ApiError({
        kind: 'invalid_response',
        status,
        message: defaultMessage('invalid_response'),
      });
    }
    return result.data;
  }

  async request<T>(path: string, o: RequestOptions<T>): Promise<T> {
    const { status, body } = await this.raw(path, o);
    return this.parse(o.schema, body, status);
  }

  /**
   * Mutation helper. HTTP 202 means "accepted": the body must be a job and the
   * caller must poll it. 200/201 returns the finished resource.
   */
  async mutate<T>(path: string, o: RequestOptions<T>): Promise<Operation<T>> {
    const { status, body } = await this.raw(path, { ...o, method: o.method ?? 'POST' });
    if (status === 202) return { kind: 'accepted', job: this.parse(JobSchema, body, status) };
    return { kind: 'done', result: this.parse(o.schema, body, status) };
  }
}
