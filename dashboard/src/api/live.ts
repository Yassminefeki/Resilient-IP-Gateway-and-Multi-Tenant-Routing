import { ApiClient, type ClientOptions } from './client';
import { ObservabilityMetricsSchema, type Api } from './contracts';
import { benchmarkEndpoints } from './endpoints/benchmarks';
import { configurationEndpoints } from './endpoints/configurations';
import { eventEndpoints, operationEndpoints } from './endpoints/events';
import { gatewayEndpoints } from './endpoints/gateways';
import { healthEndpoints } from './endpoints/health';
import { ipamEndpoints } from './endpoints/ipam';
import { jobEndpoints } from './endpoints/jobs';
import { logEndpoints } from './endpoints/logs';
import { routeEndpoints } from './endpoints/routes';
import { sandboxEndpoints } from './endpoints/sandboxes';

/** The live API: every call goes over HTTP to the configured backend. */
export function createLiveApi(opts: ClientOptions): Api {
  const c = new ApiClient(opts);
  return {
    mode: 'live',
    health: healthEndpoints(c),
    sandboxes: sandboxEndpoints(c),
    jobs: jobEndpoints(c),
    ipam: ipamEndpoints(c),
    gateways: gatewayEndpoints(c),
    routes: routeEndpoints(c),
    configurations: configurationEndpoints(c),
    events: eventEndpoints(c),
    operations: operationEndpoints(c),
    logs: logEndpoints(c),
    observability: {
      metrics: (signal) => c.request('/metrics', { schema: ObservabilityMetricsSchema, signal }),
    },
    benchmarks: benchmarkEndpoints(c),
  };
}
