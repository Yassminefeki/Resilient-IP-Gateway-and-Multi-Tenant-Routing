import type { ApiClient } from '../client';
import { HealthSchema, type Api } from '../contracts';

export const healthEndpoints =
  (c: ApiClient): Api['health'] =>
  (signal) =>
    c.request('/health', { schema: HealthSchema, signal });
