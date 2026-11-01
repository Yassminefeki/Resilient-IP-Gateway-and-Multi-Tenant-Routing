import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GatewaysView, PoolStats } from '../src/api/contracts';
import { createDemoApi } from '../src/demo/simulator';
import { fakeApi, renderApp } from './helpers';

describe('IP address management', () => {
  it('shows lease state labels and the pool counts reported by the API', async () => {
    const stats: PoolStats = {
      cidr: '10.0.0.0/28',
      total: 14,
      allocated: 5,
      quarantined: 2,
      free: 7,
    };
    renderApp(
      fakeApi((a) => {
        a.ipam = { ...a.ipam, stats: async () => stats };
      }),
      '/ipam',
    );
    const metric = async (label: string) =>
      (await screen.findAllByText(label))
        .map((el) => el.closest('.metric'))
        .find(Boolean) as HTMLElement;
    expect(within(await metric('Total addresses')).getByText('14')).toBeInTheDocument();
    expect(within(await metric('Allocated')).getByText('5')).toBeInTheDocument();
    expect(within(await metric('Quarantined')).getByText('2')).toBeInTheDocument();
    expect(within(await metric('Free')).getByText('7')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'IP leases' });
    expect(within(table).getAllByText('Allocated').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Quarantined').length).toBeGreaterThan(0);
    expect(screen.getByRole('list', { name: /Lease lifecycle/ })).toHaveTextContent('QUARANTINED');
    expect(screen.getAllByText(/cannot be reallocated/).length).toBeGreaterThan(0);
  });

  it('filters leases by state', async () => {
    const user = userEvent.setup();
    renderApp(createDemoApi(), '/ipam');
    await screen.findByRole('table', { name: 'IP leases' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by lease state' }),
      'quarantined',
    );
    await waitFor(() => {
      const rows = within(screen.getByRole('table', { name: 'IP leases' }))
        .getAllByRole('row')
        .slice(1);
      expect(rows).toHaveLength(3);
      rows.forEach((r) => expect(within(r).getByText('Quarantined')).toBeInTheDocument());
    });
  });
});

describe('gateways', () => {
  const view = (owner: string): GatewaysView => ({
    vip: { address: '192.0.2.50', owner_gateway_id: owner },
    gateways: [
      {
        id: 'a',
        name: 'edge-a',
        role: owner === 'a' ? 'master' : 'backup',
        owns_vip: owner === 'a',
        haproxy: { status: 'up' },
        keepalived: { status: 'up' },
        last_check_at: null,
      },
      {
        id: 'b',
        name: 'edge-b',
        role: owner === 'b' ? 'master' : 'backup',
        owns_vip: owner === 'b',
        haproxy: { status: 'up' },
        keepalived: { status: 'up' },
        last_check_at: null,
      },
    ],
  });

  it('takes roles from API data rather than constants', async () => {
    renderApp(
      fakeApi((a) => {
        a.gateways = { ...a.gateways, get: async () => view('b') };
      }),
      '/gateways',
    );
    const b = await screen.findByRole('article', { name: 'edge-b' });
    const aa = await screen.findByRole('article', { name: 'edge-a' });
    expect(within(b).getByText('Master')).toBeInTheDocument();
    expect(within(aa).getByText('Backup')).toBeInTheDocument();
    expect(within(b).getByText('Owns the virtual IP')).toBeInTheDocument();
  });

  async function runFailover(owner: { current: string }, movesVip: boolean) {
    const user = userEvent.setup();
    renderApp(
      fakeApi((a) => {
        a.gateways = {
          ...a.gateways,
          get: async () => view(owner.current),
          failover: async () => ({ kind: 'accepted', job: { id: 'job-fo', status: 'pending' } }),
        };
        a.jobs = {
          get: async () => {
            if (movesVip) owner.current = 'b';
            return { id: 'job-fo', status: 'succeeded' };
          },
        };
      }),
      '/gateways',
    );
    await user.click(await screen.findByRole('button', { name: 'Fail over to edge-b' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Connections held by the current owner may be interrupted');
    await user.click(within(dialog).getByRole('button', { name: 'Request failover' }));
    return screen.findByRole('region', { name: 'Operations' });
  }

  it('reports failover as verified only after the API shows the new VIP owner', async () => {
    const ops = await runFailover({ current: 'a' }, true);
    expect(await within(ops).findByText('Completed and verified')).toBeInTheDocument();
  });

  it('does not claim success when the job finished but the VIP did not move', async () => {
    const ops = await runFailover({ current: 'a' }, false);
    expect(await within(ops).findByText('Job finished — not verified')).toBeInTheDocument();
    expect(within(ops).queryByText('Completed and verified')).not.toBeInTheDocument();
  });

  it('disables unsupported actions and says why', async () => {
    renderApp(
      fakeApi((a) => {
        const original = a.health;
        a.health = async (s) => ({
          ...(await original(s)),
          capabilities: { gateway_failover: false },
        });
      }),
      '/gateways',
    );
    const button = await screen.findByRole('button', { name: 'Fail over to gateway-2' });
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
    expect(
      screen.getAllByText(/does not report support for gateway failover/).length,
    ).toBeGreaterThan(0);
  });
});
