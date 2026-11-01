import { z } from 'zod';
import type { ApiClient } from '../client';
import { DrillPlanSchema, GatewaysSchema, type Api } from '../contracts';

const messageSchema = z.object({ message: z.string() });

export const gatewayEndpoints = (c: ApiClient): Api['gateways'] => ({
  get: (signal) => c.request('/gateways', { schema: GatewaysSchema, signal }),
  failover: (req, idempotencyKey) =>
    c.mutate('/gateways/failover', { schema: messageSchema, body: req, idempotencyKey }),
  drill: (signal) => c.request('/gateways/drill-plan', { schema: DrillPlanSchema, signal }),
});
