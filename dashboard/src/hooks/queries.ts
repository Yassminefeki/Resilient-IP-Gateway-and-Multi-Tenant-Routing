import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useApi } from '../app-context';
import type { CapabilityKey, ListParams, LogParams } from '../api/contracts';

export const REFRESH_MS = 15_000;

export function useHealth() {
  const api = useApi();
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: REFRESH_MS,
  });
}

const CAP_NAMES: Record<CapabilityKey, string> = {
  sandbox_provision: 'sandbox provisioning',
  sandbox_teardown: 'sandbox teardown',
  lease_reconcile: 'lease reconciliation',
  gateway_failover: 'gateway failover',
  failover_drill: 'failure drills',
  config_validate: 'configuration validation',
  config_deploy: 'configuration deployment',
  config_rollback: 'configuration rollback',
  logs_haproxy: 'HAProxy access logs',
  logs_system: 'system logs',
  benchmark_run: 'benchmark execution',
};

/** Whether the connected API advertises an operation. Disabled actions get an honest reason. */
export function useCapability(key: CapabilityKey): { enabled: boolean; reason?: string } {
  const { data, isError } = useHealth();
  if (data?.capabilities[key] === true) return { enabled: true };
  if (!data && isError)
    return { enabled: false, reason: 'The API is unreachable, so this action is unavailable.' };
  if (!data) return { enabled: false, reason: 'Checking what the API supports…' };
  return {
    enabled: false,
    reason: `The connected API does not report support for ${CAP_NAMES[key]}.`,
  };
}

export function useSandboxes(params: ListParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['sandboxes', params],
    queryFn: ({ signal }) => api.sandboxes.list(params, signal),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
  });
}
export function usePoolStats() {
  const api = useApi();
  return useQuery({
    queryKey: ['ipam', 'stats'],
    queryFn: ({ signal }) => api.ipam.stats(signal),
    refetchInterval: REFRESH_MS,
  });
}
export function useLeases(params: ListParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['ipam', 'leases', params],
    queryFn: ({ signal }) => api.ipam.leases(params, signal),
    placeholderData: keepPreviousData,
  });
}
export function useGateways() {
  const api = useApi();
  return useQuery({
    queryKey: ['gateways'],
    queryFn: ({ signal }) => api.gateways.get(signal),
    refetchInterval: REFRESH_MS,
  });
}
export function useRoutes(params: ListParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['routes', params],
    queryFn: ({ signal }) => api.routes.list(params, signal),
    placeholderData: keepPreviousData,
  });
}
export function useConfigurations() {
  const api = useApi();
  return useQuery({
    queryKey: ['configurations'],
    queryFn: ({ signal }) => api.configurations.list(signal),
    refetchInterval: REFRESH_MS,
  });
}
export function useEvents(params: ListParams & { severity?: string }) {
  const api = useApi();
  return useQuery({
    queryKey: ['events', params],
    queryFn: ({ signal }) => api.events.list(params, signal),
    placeholderData: keepPreviousData,
  });
}
export function useOperationHistory(params: ListParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['operations', params],
    queryFn: ({ signal }) => api.operations.list(params, signal),
    placeholderData: keepPreviousData,
  });
}
export function useHaproxyLogs(params: LogParams, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['logs', 'haproxy', params],
    queryFn: ({ signal }) => api.logs.haproxy(params, signal),
    enabled,
    placeholderData: keepPreviousData,
  });
}
export function useSystemLogs(params: LogParams, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['logs', 'system', params],
    queryFn: ({ signal }) => api.logs.system(params, signal),
    enabled,
    placeholderData: keepPreviousData,
  });
}
export function useBenchmarkSuites() {
  const api = useApi();
  return useQuery({
    queryKey: ['benchmarks', 'suites'],
    queryFn: ({ signal }) => api.benchmarks.suites(signal),
  });
}
export function useBenchmarkRuns() {
  const api = useApi();
  return useQuery({
    queryKey: ['benchmarks', 'runs'],
    queryFn: ({ signal }) => api.benchmarks.runs(signal),
  });
}

export function usePoolMap() {
  const api = useApi();
  return useQuery({
    queryKey: ['ipam', 'map'],
    queryFn: ({ signal }) => api.ipam.map(signal),
    refetchInterval: REFRESH_MS,
  });
}

export function useObservabilityMetrics(refetchInterval: number = REFRESH_MS) {
  const api = useApi();
  return useQuery({
    queryKey: ['observability', 'metrics'],
    queryFn: ({ signal }) => api.observability.metrics(signal),
    refetchInterval,
  });
}
