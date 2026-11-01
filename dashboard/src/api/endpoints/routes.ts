import type { ApiClient } from '../client';
import { RouteSchema, pagedOf, type Api } from '../contracts';

const listSchema = pagedOf(RouteSchema);

export const routeEndpoints = (c: ApiClient): Api['routes'] => ({
  list: (p, signal) =>
    c.request('/routes', {
      schema: listSchema,
      signal,
      query: { q: p.q, health: p.status, page: p.page, page_size: p.pageSize },
    }),
});
