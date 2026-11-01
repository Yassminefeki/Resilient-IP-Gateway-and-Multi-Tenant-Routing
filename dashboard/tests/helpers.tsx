import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes, createQueryClient } from '../src/App';
import type { Api } from '../src/api/contracts';
import type { AppConfig } from '../src/config';
import { createDemoApi } from '../src/demo/simulator';

/**
 * A test double at the API boundary. It starts from the simulator purely as a
 * convenient set of well-formed responses, is labelled "live", and is then
 * overridden per test. Production code never imports the simulator in live mode.
 */
export function fakeApi(mutate?: (api: Api) => void): Api {
  const api: Api = { ...createDemoApi(), mode: 'live' };
  mutate?.(api);
  return api;
}

export function renderApp(api: Api, route = '/', pollMs = 10) {
  const config: AppConfig = {
    apiBaseUrl: '/api',
    demoMode: api.mode === 'demo',
    timeoutMs: 1000,
    environmentLabel: 'Test',
  };
  const container = document.body.appendChild(document.createElement('div'));
  container.id = 'root';
  return render(
    <AppProviders api={api} config={config} queryClient={createQueryClient(false)} pollMs={pollMs}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
    { container },
  );
}
