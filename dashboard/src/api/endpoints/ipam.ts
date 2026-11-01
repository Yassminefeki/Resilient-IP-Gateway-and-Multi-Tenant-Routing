import { z } from 'zod';
import type { ApiClient } from '../client';
import { LeaseSchema, PoolMapSchema, PoolStatsSchema, pagedOf, type Api } from '../contracts';

const leaseList = pagedOf(LeaseSchema);
const messageSchema = z.object({ message: z.string() });

export const ipamEndpoints = (c: ApiClient): Api['ipam'] => ({
  stats: (signal) => c.request('/ipam/stats', { schema: PoolStatsSchema, signal }),
  map: (signal) => c.request('/ipam/map', { schema: PoolMapSchema, signal }),
  leases: (p, signal) =>
    c.request('/ipam/leases', {
      schema: leaseList,
      signal,
      query: { q: p.q, state: p.status, sort: p.sort, page: p.page, page_size: p.pageSize },
    }),
  reconcile: (idempotencyKey) =>
    c.mutate('/ipam/reconcile', { schema: messageSchema, idempotencyKey }),
});
