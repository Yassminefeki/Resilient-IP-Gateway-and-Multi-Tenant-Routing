import type { ApiClient } from '../client';
import { EventSchema, OperationRecordSchema, pagedOf, type Api } from '../contracts';

const eventList = pagedOf(EventSchema);
const opList = pagedOf(OperationRecordSchema);

export const eventEndpoints = (c: ApiClient): Api['events'] => ({
  list: (p, signal) =>
    c.request('/events', {
      schema: eventList,
      signal,
      query: { q: p.q, severity: p.severity, page: p.page, page_size: p.pageSize },
    }),
});

export const operationEndpoints = (c: ApiClient): Api['operations'] => ({
  list: (p, signal) =>
    c.request('/operations', {
      schema: opList,
      signal,
      query: { q: p.q, status: p.status, page: p.page, page_size: p.pageSize },
    }),
});
