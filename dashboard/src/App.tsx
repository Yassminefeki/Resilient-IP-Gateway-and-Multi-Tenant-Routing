import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppContextProvider } from './app-context';
import type { Api } from './api/contracts';
import { isApiError } from './api/errors';
import type { AppConfig } from './config';
import { ToastProvider } from './components/Toast';
import { AppShell } from './components/Shell';
import { EmptyState } from './components/ui';
import { OperationsProvider } from './operations/OperationsProvider';
import { Benchmarks } from './pages/Benchmarks';
import { Configuration } from './pages/Configuration';
import { Gateways } from './pages/Gateways';
import { Ipam } from './pages/Ipam';
import { LiveDrill } from './pages/LiveDrill';
import { Observability } from './pages/Observability';
import { Overview } from './pages/Overview';
import { Routes as TrafficRoutes } from './pages/Routes';
import { Sandboxes } from './pages/Sandboxes';

export function createQueryClient(retry = true): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        // Reads may retry once on transient errors; mutations never retry.
        retry: retry
          ? (count, err) =>
              count < 1 && (!isApiError(err) || ['network', 'timeout', 'server'].includes(err.kind))
          : false,
      },
      mutations: { retry: false },
    },
  });
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="drill" element={<LiveDrill />} />
        <Route path="sandboxes" element={<Sandboxes />} />
        <Route path="ipam" element={<Ipam />} />
        <Route path="gateways" element={<Gateways />} />
        <Route path="routes" element={<TrafficRoutes />} />
        <Route path="configuration" element={<Configuration />} />
        <Route path="observability" element={<Observability />} />
        <Route path="benchmarks" element={<Benchmarks />} />
        <Route
          path="*"
          element={
            <EmptyState
              title="Page not found"
              message="This page does not exist. Use the navigation to continue."
            />
          }
        />
      </Route>
    </Routes>
  );
}

export interface AppProvidersProps {
  api: Api;
  config: AppConfig;
  queryClient?: QueryClient;
  pollMs?: number;
  children: React.ReactNode;
}

export function AppProviders({ api, config, queryClient, pollMs, children }: AppProvidersProps) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <AppContextProvider api={api} config={config}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <OperationsProvider pollMs={pollMs}>{children}</OperationsProvider>
        </ToastProvider>
      </QueryClientProvider>
    </AppContextProvider>
  );
}
