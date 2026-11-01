export type ApiErrorKind =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'invalid_response'
  | 'unknown';

export interface ApiErrorInit {
  kind: ApiErrorKind;
  message: string;
  status?: number;
  code?: string;
  traceId?: string;
  fieldErrors?: Record<string, string>;
  retryAfterSeconds?: number;
}

/** Normalised error. `message` is always safe to show to an operator. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly traceId?: string;
  readonly fieldErrors: Record<string, string>;
  readonly retryAfterSeconds?: number;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.traceId = init.traceId;
    this.fieldErrors = init.fieldErrors ?? {};
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

const SECRET_PATTERNS: RegExp[] = [
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /(authorization|token|api[_-]?key|secret|password)\s*[:=]\s*\S+/gi,
  /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{5,}/gi,
];

/** Remove anything that looks like a credential or a stack trace from server text. */
export function sanitizeMessage(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  if (/traceback \(most recent call last\)/i.test(raw) || /\n\s+at\s+\S+/.test(raw)) {
    return fallback;
  }
  let text = raw;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

export function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422 || status === 400) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

const DEFAULT_MESSAGES: Record<ApiErrorKind, string> = {
  network: 'Could not reach the FelCloud API. Check the API address and your network.',
  timeout: 'The API did not respond in time.',
  auth: 'Authentication is required or the token is no longer valid.',
  forbidden: 'You do not have permission to perform this operation.',
  not_found: 'The requested resource was not found.',
  conflict: 'The request conflicts with the current state of the resource.',
  validation: 'The API rejected the request as invalid.',
  rate_limited: 'Too many requests. Please wait before trying again.',
  server: 'The API reported an internal error.',
  invalid_response: 'The API returned data in an unexpected format.',
  unknown: 'The request failed.',
};

export function defaultMessage(kind: ApiErrorKind): string {
  return DEFAULT_MESSAGES[kind];
}
