import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { Job, Sandbox } from '../src/api/contracts';
import { ApiError } from '../src/api/errors';
import { createDemoApi } from '../src/demo/simulator';
import { fakeApi, renderApp } from './helpers';

const base = createDemoApi();
const sandbox = (over: Partial<Sandbox>): Sandbox => ({
  id: 'sbx-900',
  name: 'new-box',
  team: 'team-x',
  status: 'requested',
  created_at: '2026-03-12T09:00:00Z',
  ...over,
});

async function fillForm(user: ReturnType<typeof userEvent.setup>, name = 'new-box') {
  await user.click(await screen.findByRole('button', { name: 'Provision sandbox' }));
  const dialog = await screen.findByRole('dialog', { name: 'Provision sandbox' });
  await user.type(within(dialog).getByLabelText('Sandbox name'), name);
  await user.type(within(dialog).getByLabelText('Team'), 'team-x');
  return dialog;
}

describe('sandboxes', () => {
  it('validates the provisioning form inline and sends nothing', async () => {
    const user = userEvent.setup();
    const provision = vi.fn();
    renderApp(
      fakeApi((api) => {
        api.sandboxes = { ...api.sandboxes, provision };
      }),
      '/sandboxes',
    );
    await user.click(await screen.findByRole('button', { name: 'Provision sandbox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Provision sandbox' });
    await user.type(within(dialog).getByLabelText('Sandbox name'), 'Bad Name');
    await user.click(within(dialog).getByRole('button', { name: 'Provision sandbox' }));
    expect(
      await within(dialog).findByText(/lowercase letters, digits or hyphens, starting/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Enter the owning team.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Sandbox name')).toHaveAttribute('aria-invalid', 'true');
    expect(provision).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions while a request is pending', async () => {
    const user = userEvent.setup();
    let release: (v: { kind: 'accepted'; job: Job }) => void = () => undefined;
    const provision = vi.fn(
      () =>
        new Promise<{ kind: 'accepted'; job: Job }>((resolve) => {
          release = resolve;
        }),
    );
    renderApp(
      fakeApi((api) => {
        api.sandboxes = { ...api.sandboxes, provision };
      }),
      '/sandboxes',
    );
    const dialog = await fillForm(user);
    const submit = within(dialog).getByRole('button', { name: 'Provision sandbox' });
    await user.dblClick(submit);
    await user.click(submit);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Sending request…' })).toBeDisabled();
    release({ kind: 'accepted', job: { id: 'job-1', status: 'pending' } });
  });

  it('shows the 202 Accepted lifecycle, then a verified result', async () => {
    const user = userEvent.setup();
    let current = sandbox({ status: 'provisioning' });
    const states: Job['status'][] = ['pending', 'running', 'succeeded'];
    let polls = 0;
    const api = fakeApi((a) => {
      a.sandboxes = {
        ...a.sandboxes,
        provision: async () => ({
          kind: 'accepted',
          job: { id: 'job-1', status: 'pending', resource: { type: 'sandbox', id: 'sbx-900' } },
        }),
        list: async () => ({ items: [current], total: 1, page: 1, page_size: 8 }),
      };
      a.jobs = {
        get: async () => {
          const status = states[Math.min(polls++, 2)]!;
          if (status === 'succeeded') current = sandbox({ status: 'active' });
          return { id: 'job-1', status };
        },
      };
    });
    renderApp(api, '/sandboxes');
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Provision sandbox', hidden: false }));
    const ops = await screen.findByRole('region', { name: 'Operations' });
    expect(await within(ops).findByText('Request accepted')).toBeInTheDocument();
    expect(await within(ops).findByText('Completed and verified')).toBeInTheDocument();
  });

  it('does not show a sandbox as active when provisioning failed', async () => {
    const user = userEvent.setup();
    const failed = sandbox({ status: 'failed', status_reason: 'Instance did not reach ACTIVE' });
    renderApp(
      fakeApi((a) => {
        a.sandboxes = {
          ...a.sandboxes,
          provision: async () => ({ kind: 'accepted', job: { id: 'job-f', status: 'pending' } }),
          list: async () => ({ items: [failed], total: 1, page: 1, page_size: 8 }),
        };
        a.jobs = {
          get: async () => ({
            id: 'job-f',
            status: 'failed',
            error: { message: 'Instance did not reach ACTIVE' },
          }),
        };
      }),
      '/sandboxes',
    );
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Provision sandbox' }));
    const ops = await screen.findByRole('region', { name: 'Operations' });
    expect(await within(ops).findByText('Failed')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Sandboxes' });
    await waitFor(() => expect(within(table).getByText('Failed')).toBeInTheDocument());
    expect(within(table).queryByText('Active')).not.toBeInTheDocument();
  });

  it('requires confirmation before tearing a sandbox down', async () => {
    const user = userEvent.setup();
    const teardown = vi.fn(async () => ({
      kind: 'accepted' as const,
      job: { id: 'job-t', status: 'pending' as const },
    }));
    renderApp(
      fakeApi((a) => {
        a.sandboxes = { ...a.sandboxes, teardown };
      }),
      '/sandboxes',
    );
    await user.click(await screen.findByRole('button', { name: 'Tear down alpha-api' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tear down alpha-api?' });
    expect(teardown).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent('cannot be undone');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(teardown).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Tear down alpha-api' }));
    await user.click(await screen.findByRole('button', { name: 'Tear down sandbox' }));
    await waitFor(() => expect(teardown).toHaveBeenCalledTimes(1));
  });

  it('applies the search and status filters', async () => {
    const user = userEvent.setup();
    renderApp(createDemoApi(), '/sandboxes');
    const table = await screen.findByRole('table', { name: 'Sandboxes' });
    expect(within(table).getByText('alpha-api')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search sandboxes' }), 'bravo');
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Sandboxes' })).queryByText('alpha-api'),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('table', { name: 'Sandboxes' })).getByText('bravo-web'),
    ).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search sandboxes' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'failed');
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Sandboxes' })).getByText('echo-etl'),
      ).toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('table', { name: 'Sandboxes' })).queryByText('bravo-web'),
    ).not.toBeInTheDocument();
  });

  it('shows API field errors without a fake success', async () => {
    const user = userEvent.setup();
    renderApp(
      fakeApi((a) => {
        a.sandboxes = {
          ...a.sandboxes,
          provision: async () => {
            throw new ApiError({
              kind: 'validation',
              status: 422,
              message: 'Rejected',
              fieldErrors: { name: 'A sandbox with this name already exists.' },
            });
          },
        };
      }),
      '/sandboxes',
    );
    const dialog = await fillForm(user, 'alpha-api');
    await user.click(within(dialog).getByRole('button', { name: 'Provision sandbox' }));
    expect(
      await within(dialog).findByText('A sandbox with this name already exists.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Operations' })).not.toBeInTheDocument();
    void base;
  });

  it('keeps an operation understandable after a page reload', async () => {
    window.sessionStorage.setItem(
      'felcloud.operations',
      JSON.stringify([
        {
          id: 'op-r',
          label: 'Provision sandbox restored',
          jobId: 'job-r',
          startedAt: '2026-03-12T09:00:00Z',
          state: 'running',
          simulated: false,
        },
      ]),
    );
    const get = vi.fn(async () => ({ id: 'job-r', status: 'succeeded' as const }));
    renderApp(
      fakeApi((a) => {
        a.jobs = { get };
      }),
      '/sandboxes',
    );
    const ops = await screen.findByRole('region', { name: 'Operations' });
    expect(within(ops).getByText('Provision sandbox restored')).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith('job-r', expect.anything()));
    expect(await within(ops).findByText('Completed')).toBeInTheDocument();
  });
});
