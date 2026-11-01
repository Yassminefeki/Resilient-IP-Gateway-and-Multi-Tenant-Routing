import type { ApiClient } from '../client';
import { CustomDomainResponseSchema, SandboxSchema, pagedOf, type Api } from '../contracts';

const listSchema = pagedOf(SandboxSchema);

export const sandboxEndpoints = (c: ApiClient): Api['sandboxes'] => ({
  list: (p, signal) =>
    c.request('/sandboxes', {
      schema: listSchema,
      signal,
      query: { q: p.q, status: p.status, sort: p.sort, page: p.page, page_size: p.pageSize },
    }),
  get: (id, signal) =>
    c.request(`/sandboxes/${encodeURIComponent(id)}`, { schema: SandboxSchema, signal }),
  provision: (req, idempotencyKey) =>
    c.mutate('/sandboxes', { schema: SandboxSchema, body: req, idempotencyKey }),
  teardown: (id, idempotencyKey) =>
    c.mutate(`/sandboxes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      schema: SandboxSchema,
      idempotencyKey,
    }),
  customDomain: (req) =>
    c.request('/sandboxes/custom-domain', {
      method: 'POST',
      body: req,
      schema: CustomDomainResponseSchema,
    }),
});
