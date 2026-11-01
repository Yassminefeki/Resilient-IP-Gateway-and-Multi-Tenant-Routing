import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GatewaysView } from '../src/api/contracts';
import { fakeApi, renderApp } from './helpers';

describe('empty state regression tests (stops fake numbers from creeping back)', () => {
  it('Overview: renders "—" for unmeasured metrics and does not show hardcoded fake numbers', async () => {
    const api = fakeApi((a) => {
      a.ipam = {
        ...a.ipam,
        stats: async () => ({
          total: 254,
          allocated: 0,
          quarantined: 0,
          free: 254,
          cidr: '10.20.10.0/24',
        }),
      };
      a.sandboxes = {
        ...a.sandboxes,
        list: async () => ({ items: [], total: 0, page: 1, page_size: 10 }),
      };
    });

    renderApp(api, '/');
    await screen.findByText('VIP Owner');

    // Check that fake numbers do not appear as metric text
    expect(screen.queryByText('780')).not.toBeInTheDocument();
    expect(screen.queryByText('38 ms')).not.toBeInTheDocument();
    expect(screen.queryByText('1,840 ms')).not.toBeInTheDocument();

    // Verify 4 data-backed status cards exist
    expect(screen.getByText('VIP Owner')).toBeInTheDocument();
    expect(screen.getAllByText('Gateways').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sandboxes').length).toBeGreaterThan(0);
    expect(screen.getAllByText('IP Pool').length).toBeGreaterThan(0);
  });

  it('Gateways: does not show hardcoded 780ms or 0.78s when no failover executed; shows "Trigger failover"', async () => {
    const emptyGwView: GatewaysView = {
      vip: { address: '10.20.20.246', owner_gateway_id: 'gw-1' },
      gateways: [
        {
          id: 'gw-1',
          name: 'gw1',
          role: 'master',
          owns_vip: true,
          haproxy: { status: 'up' },
          keepalived: { status: 'up' },
          last_check_at: '2026-10-19T12:00:00Z',
        },
        {
          id: 'gw-2',
          name: 'gw2',
          role: 'backup',
          owns_vip: false,
          haproxy: { status: 'up' },
          keepalived: { status: 'up' },
          last_check_at: '2026-10-19T12:00:00Z',
        },
      ],
    };

    const api = fakeApi((a) => {
      a.gateways = {
        ...a.gateways,
        get: async () => emptyGwView,
      };
    });

    renderApp(api, '/gateways');
    await screen.findByText('VRRP Failover Evidence & Timeline');

    // No hardcoded 780 or 0.78 s in timeline before any failover
    expect(screen.queryByText('0.78 s')).not.toBeInTheDocument();
    expect(screen.queryByText('780 ms')).not.toBeInTheDocument();
    expect(screen.queryByText('T+280 ms')).not.toBeInTheDocument();

    // Failover control must be present
    expect(screen.getByRole('button', { name: 'Fail over to gw2' })).toBeInTheDocument();
    expect(screen.queryByText('Crash Primary Gateway')).not.toBeInTheDocument();
  });

  it('Live Drill: displays centerpiece scenarios with zero hardcoded fake metrics', async () => {
    const api = fakeApi();
    renderApp(api, '/drill');
    await screen.findByRole('heading', { name: /Live Drill/i });

    expect(screen.getByRole('button', { name: 'Execute Trigger VIP failover scenario' })).toBeInTheDocument();
    expect(screen.getAllByText('Trigger VIP Failover').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Restore Primary').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Inject Bad Config').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Provision 10 Sandboxes').length).toBeGreaterThan(0);
    expect(screen.getByText('High-Frequency VIP Health Probe')).toBeInTheDocument();
  });

  it('Configuration: does not display hardcoded 38 ms recovery time; verifies real rollback flow', async () => {
    const api = fakeApi((a) => {
      a.configurations = {
        ...a.configurations,
        list: async () => [
          {
            id: 'cfg-1',
            generation: 1,
            created_at: '2026-10-19T10:00:00Z',
            checksum: 'sha256:12345678901234567890',
            validation: { status: 'passed' },
            deployment: { status: 'deployed' },
            gateways: [],
          },
        ],
      };
    });

    renderApp(api, '/configuration');
    await screen.findByText('Atomic Hot-Reload & Rollback Verification');

    // Assert real validation and rollback action button is present
    expect(screen.getByRole('button', { name: /Test Candidate Validation & Rollback/i })).toBeInTheDocument();

    // Assert hardcoded 38 ms, < 50ms, and 0 dropped requests are removed
    expect(screen.queryByText('38 ms')).not.toBeInTheDocument();
    expect(screen.queryByText('< 50ms')).not.toBeInTheDocument();
    expect(screen.queryByText('0 dropped requests')).not.toBeInTheDocument();
    expect(screen.queryByText('ROLLED BACK IN 38ms — ACTIVE')).not.toBeInTheDocument();
    expect(screen.getByText(/Not measured/)).toBeInTheDocument();
  });

  it('Benchmarks: drops Grafana iframe by default and displays NOT EXECUTED for hard stop scenario', async () => {
    const api = fakeApi((a) => {
      a.benchmarks = {
        ...a.benchmarks,
        runs: async () => [],
      };
    });

    renderApp(api, '/benchmarks');
    await screen.findByText('Committed Benchmark Results (Datasets A & B)');

    // No fake fallback pills or localhost:3000 iframe
    expect(screen.queryByText('1,840 ms')).not.toBeInTheDocument();
    expect(screen.queryByTitle('FelCloud Load Test Telemetry')).not.toBeInTheDocument();

    // Assert that the committed hard stop scenario shows NOT EXECUTED
    expect(screen.getByText(/NOT EXECUTED/)).toBeInTheDocument();
  });

  it('Sandboxes: renders "—" for missing private IPs when API returns empty IPs', async () => {
    const api = fakeApi((a) => {
      a.sandboxes = {
        ...a.sandboxes,
        list: async () => ({
          items: [
            {
              id: 'sb-empty',
              name: 'unassigned-vm',
              team: 'team-test',
              status: 'requested',
              private_ip: null,
              hostname: null,
              created_at: '2026-10-19T10:00:00Z',
              expires_at: '2026-10-19T12:00:00Z',
            },
          ],
          total: 1,
          page: 1,
          page_size: 10,
        }),
      };
    });

    renderApp(api, '/sandboxes');
    await screen.findByText('unassigned-vm');

    // Private IP column must show "—" instead of an assumed IP
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
