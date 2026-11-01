import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { BenchmarkRun, ConfigGeneration } from '../src/api/contracts';
import { runsToCsv } from '../src/pages/Benchmarks';
import { fakeApi, renderApp } from './helpers';

const cfg = (over: Partial<ConfigGeneration>): ConfigGeneration => ({
  id: 'cfg-1',
  generation: 7,
  created_at: '2026-03-12T09:00:00Z',
  checksum: 'sha256:abcdef0123456789abcd',
  validation: { status: 'not_run' },
  deployment: { status: 'not_deployed' },
  gateways: [],
  ...over,
});

describe('configuration', () => {
  it('keeps validation separate from deployment', async () => {
    const user = userEvent.setup();
    renderApp(
      fakeApi((a) => {
        a.configurations = { ...a.configurations, list: async () => [cfg({})] };
      }),
      '/configuration',
    );
    await user.click(await screen.findByRole('button', { name: 'Details for generation 7' }));
    const panel = await screen.findByRole('dialog', { name: 'Generation 7' });
    const deploy = within(panel).getByRole('button', { name: 'Deploy' });
    expect(deploy).toHaveAttribute('aria-disabled', 'true');
    expect(deploy).toHaveAttribute('title', expect.stringMatching(/Validate this generation/));
    expect(within(panel).getByText('Not run')).toBeInTheDocument();
    expect(within(panel).getByText('Not deployed')).toBeInTheDocument();
  });

  it('represents a partial deployment accurately', async () => {
    renderApp(
      fakeApi((a) => {
        a.configurations = {
          ...a.configurations,
          list: async () => [
            cfg({
              validation: { status: 'passed' },
              deployment: { status: 'partial' },
              gateways: [
                { gateway_id: 'gw-1', generation: 7, status: 'applied' },
                { gateway_id: 'gw-2', generation: 6, status: 'pending' },
              ],
            }),
          ],
        };
      }),
      '/configuration',
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Generation 7 is only partially deployed');
    expect(alert).toHaveTextContent('gw-2: 6 (pending)');
    expect(screen.getAllByText('Partially deployed').length).toBeGreaterThan(0);
  });

  it('shows "Not reported by API" when per-gateway data is missing', async () => {
    renderApp(
      fakeApi((a) => {
        a.configurations = {
          ...a.configurations,
          list: async () => [cfg({ gateways: undefined })],
        };
      }),
      '/configuration',
    );
    expect(await screen.findByText('Not reported by API')).toBeInTheDocument();
  });

  it('requires confirmation for rollback', async () => {
    const user = userEvent.setup();
    const rollback = vi.fn(async () => ({
      kind: 'accepted' as const,
      job: { id: 'job-rb', status: 'pending' as const },
    }));
    renderApp(
      fakeApi((a) => {
        a.configurations = {
          ...a.configurations,
          list: async () => [
            cfg({ validation: { status: 'passed' }, deployment: { status: 'deployed' } }),
          ],
          rollback,
        };
      }),
      '/configuration',
    );
    await user.click(await screen.findByRole('button', { name: 'Details for generation 7' }));
    await user.click(await screen.findByRole('button', { name: 'Roll back to this generation' }));
    expect(rollback).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: 'Roll back to generation 7?' });
    await user.click(within(confirm).getByRole('button', { name: 'Roll back gateways' }));
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(1));
  });
});

describe('benchmarks', () => {
  const run = (over: Partial<BenchmarkRun>): BenchmarkRun => ({
    id: 'run-x',
    suite_id: 's',
    status: 'succeeded',
    origin: 'live',
    started_at: '2026-03-12T09:00:00Z',
    finished_at: '2026-03-12T09:01:00Z',
    parameters: { n: 10 },
    metrics: { attempted: 10, succeeded: 10, failed: 0, p50_ms: 11 },
    ...over,
  });

  it('renders exactly what the API returns, with its origin label', async () => {
    renderApp(
      fakeApi((a) => {
        a.benchmarks = {
          ...a.benchmarks,
          runs: async () => [
            run({
              id: 'run-77',
              origin: 'historical',
              metrics: { attempted: 10, succeeded: 9, failed: 1, p50_ms: 123 },
            }),
          ],
        };
      }),
      '/benchmarks',
    );
    const table = await screen.findByRole('table', { name: 'Benchmark runs' });
    expect(within(table).getByText('run-77')).toBeInTheDocument();
    expect(within(table).getByText('Historical result')).toBeInTheDocument();
    await userEvent
      .setup()
      .click(within(table).getByRole('button', { name: 'Details for run run-77' }));
    expect(await screen.findByText('10 / 9 / 1')).toBeInTheDocument();
    expect(screen.getByText('123 / — / — ms')).toBeInTheDocument();
  });

  it('shows an unavailable state when the API has no suites', async () => {
    renderApp(
      fakeApi((a) => {
        a.benchmarks = { ...a.benchmarks, suites: async () => [], runs: async () => [] };
      }),
      '/benchmarks',
    );
    expect(await screen.findByText('No benchmark suites available')).toBeInTheDocument();
    expect(await screen.findByText('No benchmark runs recorded')).toBeInTheDocument();
  });

  it('refuses to compare runs with different parameters', async () => {
    const user = userEvent.setup();
    renderApp(
      fakeApi((a) => {
        a.benchmarks = {
          ...a.benchmarks,
          runs: async () => [run({ id: 'r1' }), run({ id: 'r2', parameters: { n: 99 } })],
        };
      }),
      '/benchmarks',
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select r1 to compare' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select r2 to compare' }));
    expect(await screen.findByText(/not comparable/)).toBeInTheDocument();
  });

  it('exports CSV with quoted values', () => {
    const csv = runsToCsv([run({ id: 'r"1' })]);
    expect(csv.split('\n')[1]).toContain('"r""1"');
  });
});
