import type { ApiClient } from '../client';
import { HaproxyLogSchema, SystemLogSchema, logsOf, type Api, type LogParams } from '../contracts';

const haproxyList = logsOf(HaproxyLogSchema);
const systemList = logsOf(SystemLogSchema);
const query = (p: LogParams) => ({
  gateway: p.gatewayId,
  since: p.since,
  page: p.page,
  page_size: p.pageSize,
});

export const logEndpoints = (c: ApiClient): Api['logs'] => ({
  haproxy: (p, signal) =>
    c.request('/logs/haproxy', { schema: haproxyList, signal, query: query(p) }),
  system: (p, signal) => c.request('/logs/system', { schema: systemList, signal, query: query(p) }),
});
