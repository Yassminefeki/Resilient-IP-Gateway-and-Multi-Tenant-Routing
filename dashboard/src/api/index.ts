import type { AppConfig } from '../config';
import type { Api } from './contracts';
import { createLiveApi } from './live';

/**
 * Chooses the API implementation from explicit configuration only.
 * Demo mode is never selected as a fallback after a failed request, and the
 * simulator is loaded lazily so live builds never execute it.
 */
export async function createApi(config: AppConfig): Promise<Api> {
  if (config.demoMode) {
    const { createDemoApi } = await import('../demo/simulator');
    return createDemoApi();
  }
  return createLiveApi({ baseUrl: config.apiBaseUrl, timeoutMs: config.timeoutMs });
}

export * from './contracts';
export { ApiError, isApiError } from './errors';
