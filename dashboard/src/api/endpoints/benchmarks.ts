import { z } from 'zod';
import type { ApiClient } from '../client';
import { BenchmarkRunSchema, BenchmarkSuiteSchema, type Api } from '../contracts';

export const benchmarkEndpoints = (c: ApiClient): Api['benchmarks'] => ({
  suites: (signal) =>
    c.request('/benchmarks/suites', { schema: z.array(BenchmarkSuiteSchema), signal }),
  runs: (signal) => c.request('/benchmarks/runs', { schema: z.array(BenchmarkRunSchema), signal }),
  run: (req, idempotencyKey) =>
    c.mutate('/benchmarks/runs', { schema: BenchmarkRunSchema, body: req, idempotencyKey }),
});
