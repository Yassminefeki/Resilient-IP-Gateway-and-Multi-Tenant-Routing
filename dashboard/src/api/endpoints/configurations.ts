import { z } from 'zod';
import type { ApiClient } from '../client';
import { ConfigGenerationSchema, type Api } from '../contracts';

const listSchema = z.array(ConfigGenerationSchema);

export const configurationEndpoints = (c: ApiClient): Api['configurations'] => {
  const act = (id: string, verb: 'validate' | 'deploy' | 'rollback', key: string) =>
    c.mutate(`/configurations/${encodeURIComponent(id)}/${verb}`, {
      schema: ConfigGenerationSchema,
      idempotencyKey: key,
    });
  return {
    list: (signal) => c.request('/configurations', { schema: listSchema, signal }),
    validate: (id, key) => act(id, 'validate', key),
    deploy: (id, key) => act(id, 'deploy', key),
    rollback: (id, key) => act(id, 'rollback', key),
  };
};
