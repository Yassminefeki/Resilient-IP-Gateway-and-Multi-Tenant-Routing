import type { ApiClient } from '../client';
import { JobSchema, type Api } from '../contracts';

export const jobEndpoints = (c: ApiClient): Api['jobs'] => ({
  get: (id, signal) => c.request(`/jobs/${encodeURIComponent(id)}`, { schema: JobSchema, signal }),
});
