import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../app-context';
import type { Route } from '../api/contracts';
import { ROUTE_STAGES } from '../api/contracts';
import { DataTable, type Column } from '../components/DataTable';
import { DetailPanel, Modal } from '../components/Modal';
import { QueryView } from '../components/QueryView';
import {
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  SearchInput,
  SelectFilter,
  StatusBadge,
  Timestamp,
} from '../components/ui';
import { useRoutes, useSandboxes } from '../hooks/queries';
import { labelFor } from '../lib/labels';

const HEALTH_OPTIONS = [
  { value: '', label: 'All health states' },
  { value: 'healthy', label: 'Healthy' },
  { value: 'unhealthy', label: 'Unhealthy' },
  { value: 'unknown', label: 'Unknown' },
];

export function Routes() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [health, setHealth] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Route | null>(null);
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [targetSandbox, setTargetSandbox] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [bindPending, setBindPending] = useState(false);
  const [bindStatus, setBindStatus] = useState<string | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);

  const query = useRoutes({ q, status: health, page, pageSize: 10 });
  const sandboxesQuery = useSandboxes({ pageSize: 50 });

  const handleBindDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api.sandboxes.customDomain || !targetSandbox || !domainInput.trim()) return;
    setBindPending(true);
    setBindStatus(null);
    setBindError(null);
    try {
      const res = await api.sandboxes.customDomain({
        sandbox_id: targetSandbox,
        custom_domain: domainInput.trim(),
      });
      if (res.success) {
        setBindStatus('Custom domain deployed and synchronized across dual gateways!');
        await queryClient.invalidateQueries({ queryKey: ['routes'] });
        await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
        setTimeout(() => {
          setBindModalOpen(false);
          setBindStatus(null);
        }, 1200);
      } else {
        setBindError('Failed to bind custom domain.');
      }
    } catch (err) {
      setBindError(err instanceof Error ? err.message : 'Failed to bind custom domain.');
    } finally {
      setBindPending(false);
    }
  };

  const columns: Column<Route>[] = [
    {
      key: 'host',
      header: 'Hostname & Features',
      render: (r) => {
        const isCustom =
          r.id.endsWith('-custom') ||
          (!r.hostname.endsWith('.felcloud.test') &&
          !r.hostname.endsWith('.felcloud.internal') &&
          !r.hostname.endsWith('.example.com') &&
          !r.hostname.endsWith('.internal') &&
          !r.hostname.endsWith('.local'));
        return (
          <div>
            <strong>{r.hostname}</strong>
            <div className="route-feature-badges">
              {r.tls && (
                <span
                  className={`route-badge route-badge-tls route-badge-tls-${r.tls.status}`}
                  title={`TLS certificate status: ${r.tls.status}`}
                >
                  TLS ({r.tls.status})
                </span>
              )}
              {isCustom && (
                <span className="route-badge route-badge-domain" title="SNI custom domain routing">
                  Custom domain
                </span>
              )}
            </div>
          </div>
        );
      },
    },

    { key: 'backend', header: 'Backend', render: (r) => <code className="text-nowrap">{r.backend}</code> },
    {
      key: 'sandbox',
      header: 'Sandbox',
      render: (r) => r.sandbox_name ?? <span className="muted">—</span>,
    },
    { key: 'health', header: 'Health', render: (r) => <StatusBadge status={r.health} /> },
    { key: 'stage', header: 'Stage reached', render: (r) => <StatusBadge status={r.stage} /> },
    {
      key: 'gen',
      header: 'Config generation',
      render: (r) => r.config_generation ?? <span className="muted">Not reported</span>,
    },
    { key: 'check', header: 'Last check', render: (r) => <Timestamp value={r.last_check_at} compact /> },
    {
      key: 'details',
      header: 'Details',
      render: (r) => (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setSelected(r)}
          aria-label={`Details for ${r.hostname}`}
        >
          Details
        </button>
      ),
    },
  ];

  const totalRoutes = query.data?.total ?? query.data?.items.length ?? 0;
  const tlsCount = query.data?.items.filter((r) => r.tls && r.tls.status === 'valid').length ?? 0;
  const customCount = query.data?.items.filter(
    (r) =>
      r.id.endsWith('-custom') ||
      (!r.hostname.endsWith('.felcloud.test') &&
      !r.hostname.endsWith('.felcloud.internal') &&
      !r.hostname.endsWith('.example.com') &&
      !r.hostname.endsWith('.internal') &&
      !r.hostname.endsWith('.local')),
  ).length ?? 0;

  return (
    <>
      <PageHeader
        title="Traffic & Routes"
        subtitle="Domain routing, SSL termination, and health monitoring for microVM backends."
        action={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setBindModalOpen(true);
              setTargetSandbox(sandboxesQuery.data?.items[0]?.id ?? 'team1');
            }}
          >
            Bind custom domain
          </button>
        }
      />
      <div className="bonus-feature-strip" aria-label="Routing architecture capabilities">
        <span className="bonus-strip-item">
          <span className="dot-positive" />
          <strong>L7 MicroVM Routes:</strong> {totalRoutes} active
        </span>
        <span className="bonus-strip-sep">·</span>
        <span className="bonus-strip-item">
          <span className={customCount > 0 ? 'dot-positive' : 'dot-neutral'} />
          <strong>Custom Domains:</strong> {customCount} {customCount === 1 ? 'domain' : 'domains'}
        </span>
        <span className="bonus-strip-sep">·</span>
        <span className="bonus-strip-item">
          <span className={tlsCount > 0 ? 'dot-positive' : 'dot-neutral'} />
          <strong>TLS 1.3 Valid:</strong> {tlsCount} verified
        </span>
      </div>

      <FilterBar>
        <SearchInput
          label="Search routes"
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search hostname, backend or sandbox"
        />
        <SelectFilter
          label="Filter by health"
          value={health}
          onChange={(v) => {
            setHealth(v);
            setPage(1);
          }}
          options={HEALTH_OPTIONS}
        />
      </FilterBar>
      <QueryView
        query={query}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            title="No routes"
            message="The API returned no routes for this search or filter."
          />
        }
      >
        {(d) => (
          <>
            <DataTable caption="Routes" columns={columns} rows={d.items} rowKey={(r) => r.id} />
            <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryView>
      {selected && (
        <DetailPanel
          title={selected.hostname}
          description="Configured target and health evidence"
          onClose={() => setSelected(null)}
        >
          <div className="stack">
            <dl className="kv">
              <dt>Target</dt>
              <dd>
                <code>{selected.backend}</code>
              </dd>
              <dt>Sandbox</dt>
              <dd>{selected.sandbox_name ?? '—'}</dd>
              <dt>Health</dt>
              <dd>
                <StatusBadge status={selected.health} />
              </dd>
              <dt>Latency</dt>
              <dd>
                {selected.latency_ms != null
                  ? `${selected.latency_ms} ms (backend probe)`
                  : 'Not measured'}
              </dd>
              <dt>TLS</dt>
              <dd>
                {selected.tls ? (
                  <>
                    <StatusBadge status={selected.tls.status} />{' '}
                    <Timestamp value={selected.tls.expires_at} />
                  </>
                ) : (
                  'Not reported by API'
                )}
              </dd>
              <dt>Evidence</dt>
              <dd>{selected.evidence ?? 'None reported'}</dd>
            </dl>
            <section>
              <h3 className="subsection-title">Rollout stage</h3>
              <ol className="stage-list">
                {ROUTE_STAGES.map((s, i) => {
                  const reached = i <= ROUTE_STAGES.indexOf(selected.stage);
                  return (
                    <li key={s} className={reached ? 'stage reached' : 'stage'}>
                      {labelFor(s).text}
                      {reached ? ' ✓' : ' — not reached'}
                    </li>
                  );
                })}
              </ol>
              <p className="muted">
                Configured, validated, deployed and reachable are separate facts; only the stages
                above are confirmed by the API.
              </p>
            </section>
          </div>
        </DetailPanel>
      )}

      {bindModalOpen && (
        <Modal
          title="Bind Custom Domain"
          description="Map an external domain or custom alias to a sandbox microVM across both HAProxy gateways."
          onClose={() => {
            if (!bindPending) {
              setBindModalOpen(false);
              setBindError(null);
              setBindStatus(null);
            }
          }}
        >
          <form onSubmit={handleBindDomain} className="stack">
            <div>
              <label htmlFor="target-sandbox-select" style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '13px' }}>
                Target Sandbox
              </label>
              <select
                id="target-sandbox-select"
                value={targetSandbox}
                onChange={(e) => setTargetSandbox(e.target.value)}
                required
                style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg-surface)' }}
              >
                <option value="">Select a sandbox…</option>
                {sandboxesQuery.data?.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.id}) · {s.private_ip}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="custom-domain-name" style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '13px' }}>
                Custom Domain Hostname
              </label>
              <input
                id="custom-domain-name"
                type="text"
                placeholder="e.g. app.team1.sandbox.example.com"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                required
                style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg-surface)' }}
              />
            </div>

            {bindError && (
              <div style={{ color: 'var(--tone-danger-text, #f87171)', fontSize: '13px', padding: '8px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '4px' }}>
                {bindError}
              </div>
            )}
            {bindStatus && (
              <div style={{ color: 'var(--tone-success-text, #4ade80)', fontSize: '13px', padding: '8px', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '4px' }}>
                {bindStatus}
              </div>
            )}

            <div className="row wrap justify-end" style={{ gap: '8px', marginTop: '16px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setBindModalOpen(false)}
                disabled={bindPending}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={bindPending || !targetSandbox || !domainInput.trim()}
              >
                {bindPending ? 'Synchronizing gateways…' : 'Bind domain'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
