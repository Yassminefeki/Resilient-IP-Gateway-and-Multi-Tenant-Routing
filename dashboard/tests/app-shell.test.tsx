import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createApi } from '../src/api';
import { createLiveApi } from '../src/api/live';
import { loadConfig } from '../src/config';
import { createDemoApi } from '../src/demo/simulator';
import { fakeApi, renderApp } from './helpers';

describe('navigation and modes', () => {
  it('navigates between pages from the sidebar', async () => {
    const user = userEvent.setup();
    renderApp(fakeApi());
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const name of [
      'Sandboxes',
      'IP Address Management',
      'Gateways',
      'Traffic & Routes',
      'Configuration',
      'Observability',
      'Benchmarks',
    ]) {
      await user.click(within(nav).getByRole('link', { name }));
      expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument();
    }
  });

  it('shows the demo banner only in demo mode', async () => {
    const { unmount } = renderApp(createDemoApi());
    expect(await screen.findByTestId('demo-banner')).toHaveTextContent(
      'DEMO DATA — NOT CONNECTED TO INFRASTRUCTURE',
    );
    unmount();
    renderApp(fakeApi());
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(screen.queryByTestId('demo-banner')).not.toBeInTheDocument();
  });

  it('parses demo mode only from an explicit variable', () => {
    expect(loadConfig({}).demoMode).toBe(false);
    expect(loadConfig({ VITE_DEMO_MODE: 'true' }).demoMode).toBe(true);
    expect(loadConfig({ VITE_DEMO_MODE: 'yes' }).demoMode).toBe(false);
  });

  it('live mode never falls back to demo data when the API is unavailable', async () => {
    const config = loadConfig({ VITE_DEMO_MODE: 'false' });
    const api = await createApi(config);
    expect(api.mode).toBe('live');
    const failing = createLiveApi({
      baseUrl: '/api',
      timeoutMs: 500,
      fetchImpl: () => Promise.reject(new TypeError('offline')),
    });
    renderApp(failing);
    expect(await screen.findByTestId('connection-warning')).toHaveTextContent(
      'The FelCloud API is unavailable',
    );
    expect(screen.getByText('No infrastructure data received yet')).toBeInTheDocument();
    expect(screen.queryByTestId('demo-banner')).not.toBeInTheDocument();
    expect(screen.queryByText(/alpha-api/)).not.toBeInTheDocument();
  });

  it('distinguishes an empty result from a failed request', async () => {
    const empty = fakeApi((api) => {
      api.sandboxes = {
        ...api.sandboxes,
        list: async () => ({ items: [], total: 0, page: 1, page_size: 8 }),
      };
    });
    const { unmount } = renderApp(empty, '/sandboxes');
    expect(await screen.findByTestId('empty-state')).toHaveTextContent('No sandboxes yet');
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
    unmount();

    const broken = fakeApi((api) => {
      api.sandboxes = {
        ...api.sandboxes,
        list: async () => {
          throw new Error('boom');
        },
      };
    });
    renderApp(broken, '/sandboxes');
    expect(await screen.findByTestId('error-state')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('opens and closes the mobile navigation accessibly', async () => {
    const user = userEvent.setup();
    renderApp(fakeApi());
    const toggle = await screen.findByRole('button', { name: 'Open navigation' });
    await user.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(toggle).toHaveFocus();
  });
});
