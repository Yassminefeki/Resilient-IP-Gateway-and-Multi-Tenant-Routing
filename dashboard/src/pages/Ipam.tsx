import { Download, RefreshCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../app-context';
import { isApiError } from '../api/errors';
import type { Lease, PoolCell } from '../api/contracts';
import { DataTable, type Column } from '../components/DataTable';
import { ConfirmDialog, DetailPanel } from '../components/Modal';
import { LeaseCountdown, LeaseLifecycle } from '../components/LeaseLifecycle';
import { QueryView } from '../components/QueryView';
import {
  ActionButton,
  Card,
  CapabilityNote,
  CopyButton,
  EmptyState,
  FilterBar,
  MetricCard,
  PageHeader,
  Pagination,
  ReconciliationTooltip,
  SearchInput,
  SelectFilter,
  StatusBadge,
  Timestamp,
} from '../components/ui';
import { useCapability, useLeases, usePoolMap, usePoolStats } from '../hooks/queries';
import { downloadJsonEvidence } from '../lib/evidence';
import { newKey } from '../lib/format';
import { getTelemetryBuffer, recordTelemetryPoint } from '../lib/telemetry';
import { useOperations } from '../operations/OperationsProvider';


const STATE_OPTIONS = [
  { value: '', label: 'All states' },
  { value: 'allocated', label: 'Allocated' },
  { value: 'quarantined', label: 'Quarantined' },
  { value: 'free', label: 'Free' },
];

export function Ipam() {
  const api = useApi();
  const { run } = useOperations();
  const reconcile = useCapability('lease_reconcile');
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Lease | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [inspectedCell, setInspectedCell] = useState<PoolCell | null>(null);
  const key = useRef(newKey());
  const stats = usePoolStats();
  const poolMap = usePoolMap();
  const leases = useLeases({ q, status: state, page, pageSize: 12 });

  useEffect(() => {
    if (stats.data) {
      recordTelemetryPoint({
        freeIps: stats.data.free,
        allocatedIps: stats.data.allocated,
      });
    }
  }, [stats.data]);

  const columns: Column<Lease>[] = [
    { key: 'ip', header: 'Address', render: (l) => <code>{l.ip}</code> },
    {
      key: 'state',
      header: 'State',
      render: (l) => {
        const isExpired = l.until && new Date(l.until).getTime() < Date.now();
        if (l.state === 'allocated' && isExpired) {
          return (
            <span
              className="status-badge status-badge-warning"
              title="Lease expired past its lifetime, waiting for reaper run"
            >
              Allocated (expired)
            </span>
          );
        }
        return <StatusBadge status={l.state} />;
      },
    },
    {
      key: 'owner',
      header: 'Owner / Recycling Trail',
      render: (l) =>
        l.state === 'quarantined' ? (
          <span className="quarantine-trail" title="Released at sandbox teardown">
            <span className="status-badge status-badge-warning" style={{ fontSize: '11px', padding: '1px 6px' }}>
              Released at teardown
            </span>
            {l.sandbox_name && (
              <span className="muted" style={{ marginLeft: '6px', fontSize: '12px' }}>
                ({l.sandbox_name})
              </span>
            )}
          </span>
        ) : (
          l.sandbox_name ?? <span className="muted">—</span>
        ),
    },
    { key: 'alloc', header: 'Allocated', render: (l) => <Timestamp value={l.allocated_at} /> },
    {
      key: 'until',
      header: 'Expiry / cooldown ends',
      render: (l) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <Timestamp value={l.until} />
          {l.until && <LeaseCountdown until={l.until} />}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Details',
      render: (l) => (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setSelected(l)}
          aria-label={`Details for ${l.ip}`}
        >
          View
        </button>
      ),
    },
  ];

  async function confirmReconcile() {
    if (pending) return;
    setPending(true);
    try {
      await run('Reconcile IP leases', () => api.ipam.reconcile(key.current));
      setConfirming(false);
      key.current = newKey();
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The request failed unexpectedly.');
    }
    setPending(false);
  }

  return (
    <>
      <PageHeader
        title="IP Address Management"
        subtitle="The private address pool and how leases move through their lifecycle."
        action={
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                downloadJsonEvidence('ipam-evidence', {
                  stats: stats.data ?? null,
                  leases: leases.data?.items ?? [],
                });
              }}
            >
              <Download size={16} aria-hidden />
              <span>Download evidence (JSON)</span>
            </button>
            <ActionButton
              variant="secondary"
              icon={<RefreshCcw size={16} aria-hidden />}
              disabledReason={reconcile.reason}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              Reconcile leases
            </ActionButton>
            <ReconciliationTooltip />
          </div>
        }
      />

      <CapabilityNote reason={reconcile.reason} />
      <QueryView query={stats} rows={2}>
        {(s) => (
          <div className="metric-grid">
            <MetricCard label="Total addresses" value={s.total} hint={s.cidr} />
            <MetricCard label="Allocated" value={s.allocated} />
            <MetricCard
              label="Quarantined"
              value={s.quarantined}
              hint={
                s.quarantine_seconds
                  ? `Cooldown ${Math.round(s.quarantine_seconds / 60)} min`
                  : undefined
              }
            />
            <MetricCard
              label="Free"
              value={s.free}
              tone={s.free === 0 ? 'critical' : undefined}
              hint={s.free === 0 ? 'No addresses available' : undefined}
            />
          </div>
        )}
      </QueryView>

      {/* IPAM Pool Visualization: utilization bar and real 254-cell block grid */}
      <Card
        title="Real IPAM Pool Visualization"
        description="Every cell maps 1:1 to an actual private IPv4 host (.1 to .254) in the sandbox subnet."
      >
        <QueryView query={stats} rows={2}>
          {(s) => {
            const total = s.total || 254;
            const allocatedPct = (s.allocated / total) * 100;
            const quarantinedPct = (s.quarantined / total) * 100;
            const freePct = Math.max(0, (s.free / total) * 100);

            // Real 254 host addresses from backend poolMap or generated with live leases
            const cells: PoolCell[] = poolMap.data?.cells ?? Array.from({ length: 254 }, (_, i) => {
              const host = i + 1;
              const ip = `10.20.30.${host}`;
              const match = leases.data?.items.find((l) => l.ip === ip);
              return {
                ip,
                host,
                state: (match?.state as 'allocated' | 'quarantined' | 'free') ?? 'free',
                entity: match?.sandbox_name ?? undefined,
                id: match?.id,
                allocated_at: match?.allocated_at ?? undefined,
                until: match?.until ?? undefined,
              };
            });

            return (
              <div className="ipam-pool-vis">
                <div className="ipam-utilization-bar-wrap">
                  <div className="ipam-utilization-bar">
                    <div
                      className="ipam-bar-seg ipam-bar-allocated"
                      style={{ width: `${allocatedPct}%` }}
                      title={`Allocated: ${s.allocated} (${allocatedPct.toFixed(1)}%)`}
                    />
                    <div
                      className="ipam-bar-seg ipam-bar-quarantined"
                      style={{ width: `${quarantinedPct}%` }}
                      title={`Quarantined: ${s.quarantined} (${quarantinedPct.toFixed(1)}%)`}
                    />
                    <div
                      className="ipam-bar-seg ipam-bar-free"
                      style={{ width: `${freePct}%` }}
                      title={`Free: ${s.free} (${freePct.toFixed(1)}%)`}
                    />
                  </div>
                  <div className="ipam-bar-legend">
                    <span className="legend-item">
                      <span className="legend-swatch ipam-bar-allocated" />
                      Allocated: <strong>{s.allocated}</strong> ({allocatedPct.toFixed(1)}%)
                    </span>
                    <span className="legend-item">
                      <span className="legend-swatch ipam-bar-quarantined" />
                      Quarantined: <strong>{s.quarantined}</strong> ({quarantinedPct.toFixed(1)}%)
                    </span>
                    <span className="legend-item">
                      <span className="legend-swatch ipam-bar-free" />
                      Free: <strong>{s.free}</strong> ({freePct.toFixed(1)}%)
                    </span>
                  </div>
                </div>

                <div className="ipam-vis-split-grid">
                  <div className="ipam-grid-col">
                    <div className="row spread" style={{ marginBottom: '6px' }}>
                      <p className="muted" style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>
                        Real Host Address Grid · {cells.length} Addresses ({s.cidr})
                      </p>
                      <span className="muted" style={{ fontSize: '11px' }}>
                        10.20.30.1 ➔ 10.20.30.254
                      </span>
                    </div>

                    <div
                      className="ipam-cells-grid ipam-real-254-grid"
                      aria-label="IP pool cell grid"
                    >
                      {cells.map((c) => {
                        const isMatch = q.trim() !== '' && (
                          c.ip.includes(q.trim()) ||
                          (c.entity && c.entity.toLowerCase().includes(q.trim().toLowerCase()))
                        );
                        return (
                          <button
                            key={c.ip}
                            type="button"
                            className={`ipam-grid-cell cell-${c.state} ${isMatch ? 'cell-highlighted' : ''}`}
                            title={`${c.ip}: ${c.state.toUpperCase()}${c.entity ? ` (${c.entity})` : ''}`}
                            onMouseEnter={() => setInspectedCell(c)}
                            onClick={() => {
                              if (c.state !== 'free') {
                                setSelected({
                                  id: c.id ?? `lease-${c.host}`,
                                  ip: c.ip,
                                  state: c.state,
                                  sandbox_name: c.entity,
                                  allocated_at: c.allocated_at,
                                  until: c.until,
                                });
                              } else {
                                setInspectedCell(c);
                              }
                            }}
                          />
                        );
                      })}
                    </div>

                    {/* Live Address Inspector Panel */}
                    <div className="ipam-cell-inspector" style={{ marginTop: '8px', padding: '8px 12px', background: 'var(--surface-muted)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', fontSize: '12px' }}>
                      {inspectedCell ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span className="font-mono" style={{ fontWeight: 600 }}>{inspectedCell.ip}</span>
                          <span className="muted">·</span>
                          <span className={`status-badge status-badge-${inspectedCell.state === 'allocated' ? 'success' : inspectedCell.state === 'quarantined' ? 'warning' : 'neutral'}`} style={{ fontSize: '11px', padding: '1px 6px' }}>
                            {inspectedCell.state.toUpperCase()}
                          </span>
                          {inspectedCell.entity && (
                            <>
                              <span className="muted">·</span>
                              <span>Entity: <strong>{inspectedCell.entity}</strong></span>
                            </>
                          )}
                          <span className="muted" style={{ marginLeft: 'auto', fontSize: '11px' }}>
                            Host slot #{inspectedCell.host} of 254
                          </span>
                        </div>
                      ) : (
                        <div className="muted" style={{ fontSize: '11px' }}>
                          Hover or click any address cell above to inspect exact IPv4 host details, lease status, and sandbox owner.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="ipam-chart-col">
                    <PoolUsageChart allocated={s.allocated} free={s.free} total={total} />
                  </div>
                </div>
              </div>
            );
          }}
        </QueryView>
      </Card>

      <Card
        title="Lease lifecycle"
        description="An address in quarantine cannot be reallocated until its cooldown ends."
      >
        <LeaseLifecycle />
      </Card>
      <FilterBar>
        <SearchInput
          label="Search leases"
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search IP, lease ID or sandbox"
        />
        <SelectFilter
          label="Filter by lease state"
          value={state}
          onChange={(v) => {
            setState(v);
            setPage(1);
          }}
          options={STATE_OPTIONS}
        />
      </FilterBar>
      <QueryView
        query={leases}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            title="No leases match"
            message="The API returned no leases for this search or filter."
          />
        }
      >
        {(d) => (
          <>
            <DataTable caption="IP leases" columns={columns} rows={d.items} rowKey={(l) => l.id} />
            <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryView>
      {selected && (
        <DetailPanel
          title={selected.ip}
          description={`Lease ${selected.id}`}
          onClose={() => setSelected(null)}
        >
          <dl className="kv">
            <dt>Lease ID</dt>
            <dd>
              <code>{selected.id}</code> <CopyButton value={selected.id} label="lease ID" />
            </dd>
            <dt>State</dt>
            <dd>
              <StatusBadge status={selected.state} />
            </dd>
            <dt>Sandbox</dt>
            <dd>{selected.sandbox_name ?? '—'}</dd>
            <dt>Allocated</dt>
            <dd>
              <Timestamp value={selected.allocated_at} />
            </dd>
            <dt>{selected.state === 'quarantined' ? 'Cooldown ends' : 'Expires'}</dt>
            <dd>
              <Timestamp value={selected.until} />
            </dd>
          </dl>
          {selected.state === 'quarantined' && (
            <p className="muted">
              This address is quarantined and cannot be reallocated until the cooldown ends.
            </p>
          )}
        </DetailPanel>
      )}
      {confirming && (
        <ConfirmDialog
          title="Reconcile IP leases?"
          confirmLabel="Start reconciliation"
          pending={pending}
          error={error}
          onConfirm={() => void confirmReconcile()}
          onCancel={() => setConfirming(false)}
          consequences={
            <p>
              The control plane compares lease records with the compute and network state and
              repairs any drift it finds. The result is shown once the backend job finishes.
            </p>
          }
        />
      )}
    </>
  );
}

function PoolUsageChart({
  allocated,
  free,
  total,
}: {
  allocated: number;
  free: number;
  total: number;
}) {
  const telemetry = getTelemetryBuffer();
  const validPoints = telemetry.filter(
    (p): p is typeof p & { allocatedIps: number; freeIps: number } =>
      typeof p.allocatedIps === 'number' && typeof p.freeIps === 'number',
  );

  const max = total || 254;
  const height = 100;

  // If fewer than 2 points, show the current sample as baseline
  const usedTrend =
    validPoints.length >= 2
      ? validPoints.map((p) => p.allocatedIps)
      : [allocated, allocated];
  const freeTrend =
    validPoints.length >= 2
      ? validPoints.map((p) => p.freeIps)
      : [free, free];

  const usedPoints = usedTrend.map((d, i) => {
    const x = usedTrend.length === 1 ? 50 : (i / (usedTrend.length - 1)) * 100;
    const y = height - (d / max) * (height - 14) - 5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const freePoints = freeTrend.map((d, i) => {
    const x = freeTrend.length === 1 ? 50 : (i / (freeTrend.length - 1)) * 100;
    const y = height - (d / max) * (height - 14) - 5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <div className="ipam-pool-chart-panel">
      <div className="pool-chart-head">
        <div>
          <span className="pool-chart-title">Used vs Free IPs Over Time</span>
          <p className="muted" style={{ fontSize: '11px', margin: '2px 0 0 0' }}>
            since console opened · {validPoints.length} polled sample{validPoints.length === 1 ? '' : 's'} in memory
          </p>
        </div>
        <div className="pool-chart-tags">
          <span className="chart-legend-tag tag-used">Allocated ({allocated})</span>
          <span className="chart-legend-tag tag-free">Free ({free})</span>
        </div>
      </div>

      {validPoints.length < 3 ? (
        <div
          className="pool-chart-collecting"
          style={{
            height: `${height}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--surface-muted)',
            borderRadius: 'var(--radius)',
            border: '1px dashed var(--border)',
            color: 'var(--text-muted)',
            fontSize: '12.5px',
            padding: '12px',
            textAlign: 'center',
          }}
        >
          Collecting telemetry buffer ({validPoints.length} of 3 samples polled)… Trend chart activates at 3 samples.
        </div>
      ) : (
        <div className="pool-chart-svg-wrap" style={{ height: `${height}px` }}>
          <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="pool-usage-svg">
            <path
              d={`M 0,${height} L ${freePoints.join(' L ')} L 100,${height} Z`}
              fill="rgba(2, 132, 199, 0.08)"
            />
            <path
              d={`M ${freePoints.join(' L ')}`}
              fill="none"
              stroke="#0284c7"
              strokeWidth="1.8"
              strokeDasharray="3 2"
            />
            <path
              d={`M 0,${height} L ${usedPoints.join(' L ')} L 100,${height} Z`}
              fill="rgba(37, 99, 235, 0.16)"
            />
            <path d={`M ${usedPoints.join(' L ')}`} fill="none" stroke="#2563eb" strokeWidth="2.2" />
          </svg>
        </div>
      )}

      <div className="pool-churn-strip">
        <div className="churn-stat">
          <span className="churn-label">Active Capacity</span>
          <strong>{Math.round((allocated / max) * 100)}% Used</strong>
        </div>
        <div className="churn-stat">
          <span className="churn-label">Free Addresses</span>
          <strong className="text-green">{free} IPs</strong>
        </div>
        <div className="churn-stat">
          <span className="churn-label">Telemetry Samples</span>
          <strong>
            {validPoints.length < 3 ? `${validPoints.length} (buffering)` : `${validPoints.length} sample${validPoints.length === 1 ? '' : 's'}`}
          </strong>
        </div>
      </div>
    </div>
  );
}

