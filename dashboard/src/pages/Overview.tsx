import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../app-context';
import { GatewayTopology } from '../components/GatewayTopology';
import { QueryView } from '../components/QueryView';
import {
  ActionButton,
  Card,
  CapabilityNote,
  EmptyState,
  LoadingSkeleton,
  PageHeader,
  StatusBadge,
  Timestamp,
} from '../components/ui';
import {
  useCapability,
  useConfigurations,
  useEvents,
  useGateways,
  useHealth,
  useOperationHistory,
  usePoolStats,
  useRoutes,
  useSandboxes,
} from '../hooks/queries';
import { percent } from '../lib/format';
import { getTelemetryBuffer, recordTelemetryPoint, type TelemetryPoint } from '../lib/telemetry';

export function Sparkline({
  data,
  color = 'var(--primary)',
  height = 36,
  emptyLabel = 'Collecting telemetry since console opened…',
}: {
  data: number[];
  color?: string;
  height?: number;
  emptyLabel?: string;
}) {
  if (!data || data.length < 2) {
    return (
      <div
        className="sparkline-container sparkline-empty"
        style={{
          height: `${height}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span className="muted" style={{ fontSize: '11px' }}>
          {emptyLabel}
        </span>
      </div>
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * 100;
    const y = height - ((d - min) / range) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const pathD = `M ${points.join(' L ')}`;
  const areaD = `M 0,${height} L ${points.join(' L ')} L 100,${height} Z`;

  return (
    <div className="sparkline-container" style={{ height: `${height}px` }}>
      <svg
        className="sparkline-svg"
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={areaD} className="sparkline-fill" />
        <path d={pathD} className="sparkline-line" style={{ stroke: color }} />
      </svg>
    </div>
  );
}

export function Overview() {
  const navigate = useNavigate();
  const { config } = useApp();
  const health = useHealth();
  const provision = useCapability('sandbox_provision');
  const active = useSandboxes({ status: 'active', pageSize: 1 });
  const failedSandboxes = useSandboxes({ status: 'failed', pageSize: 5 });
  const pool = usePoolStats();
  const gateways = useGateways();
  const failedOps = useOperationHistory({ status: 'failed', pageSize: 1 });
  const configs = useConfigurations();
  const unhealthyRoutes = useRoutes({ status: 'unhealthy', pageSize: 5 });
  const events = useEvents({ pageSize: 6 });

  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>(() => getTelemetryBuffer());
  const [attentionMinimized, setAttentionMinimized] = useState(true);
  const [activityMinimized, setActivityMinimized] = useState(true);

  useEffect(() => {
    if (pool.data) {
      recordTelemetryPoint({
        freeIps: pool.data.free,
        allocatedIps: pool.data.allocated,
      });
      setTelemetry(getTelemetryBuffer());
    }
  }, [pool.data]);

  if (health.isPending && !health.data) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Is the platform healthy, and what needs attention?" />
        <LoadingSkeleton rows={5} label="Loading platform overview" />
      </>
    );
  }


  if (health.isError && !health.data) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Platform health and what needs attention." />
        <EmptyState
          title="No infrastructure data received yet"
          message={`The console has not been able to reach the API at ${config.apiBaseUrl}. Nothing is shown as live state until a connection is made.`}
          action={
            <button type="button" className="btn btn-primary" onClick={() => void health.refetch()}>
              Retry connection
            </button>
          }
        />
      </>
    );
  }

  const gw = gateways.data?.gateways;
  const healthyGw = gw?.filter(
    (g) => g.haproxy.status === 'up' && g.keepalived.status === 'up',
  ).length;
  const owner = gw?.find((g) => g.id === gateways.data?.vip.owner_gateway_id);

  const attention: Array<{ key: string; text: string; to: string }> = [];
  for (const s of failedSandboxes.data?.items ?? [])
    attention.push({ key: s.id, text: `Sandbox ${s.name} failed to provision.`, to: '/sandboxes' });
  for (const g of gw ?? [])
    if (g.haproxy.status !== 'up' || g.keepalived.status !== 'up')
      attention.push({
        key: g.id,
        text: `${g.name} reports a service that is not up.`,
        to: '/gateways',
      });
  for (const c of configs.data ?? [])
    if (c.deployment.status === 'partial')
      attention.push({
        key: c.id,
        text: `Configuration generation ${c.generation} is only partially deployed.`,
        to: '/configuration',
      });
  for (const r of unhealthyRoutes.data?.items ?? [])
    attention.push({ key: r.id, text: `Route ${r.hostname} is unhealthy.`, to: '/routes' });
  if (pool.data && pool.data.free === 0)
    attention.push({ key: 'pool', text: 'The IP pool has no free addresses.', to: '/ipam' });
  for (const op of failedOps.data?.items ?? [])
    attention.push({
      key: op.id,
      text: `Operation ${op.kind} failed: ${op.message ?? 'unknown failure'}`,
      to: '/sandboxes',
    });

  const freeIpsSeries = telemetry
    .map((p) => p.freeIps)
    .filter((v): v is number => typeof v === 'number');

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Is the platform healthy, and what needs attention?"
        action={
          <ActionButton
            variant="primary"
            icon={<Plus size={18} aria-hidden />}
            disabledReason={provision.reason}
            onClick={() => navigate('/sandboxes', { state: { provision: true } })}
          >
            Provision sandbox
          </ActionButton>
        }
      />
      <CapabilityNote reason={provision.reason} />

      {/* Top row of four cards, all backed by data (Requirement 4) */}
      <div className="overview-hero-clean" aria-label="Platform Health Status Cards">
        {/* Card 1: VIP Owner */}
        <div className="hero-metric-card">
          <div className="hero-metric-top">
            <span className="hero-metric-label">VIP Owner</span>
            {owner?.role && <StatusBadge status={owner.role} />}
          </div>
          <div className="hero-metric-number">
            {owner ? (
              <span>{owner.name}</span>
            ) : (
              <span className="muted">Not reported</span>
            )}
          </div>
          <div className="hero-metric-sub">
            VIP: <code className="font-mono">{gateways.data?.vip.address ?? '—'}</code>
            {owner ? ` · ${owner.role.toUpperCase()}` : ''}
          </div>
        </div>

        {/* Card 2: Gateways */}
        <div className="hero-metric-card">
          <div className="hero-metric-top">
            <span className="hero-metric-label">Gateways</span>
            <span className={`status-dot ${healthyGw === gw?.length ? 'dot-positive' : 'dot-warning'}`} aria-hidden />
          </div>
          <div className="hero-metric-number font-mono">
            {healthyGw !== undefined && gw ? (
              <>
                {healthyGw} <span style={{ fontSize: '20px', fontWeight: 500, color: 'var(--text-muted)' }}>/ {gw.length} up</span>
              </>
            ) : (
              '—'
            )}
          </div>
          <div className="hero-metric-sub">
            {healthyGw === gw?.length ? 'HAProxy & Keepalived healthy' : 'Node degraded or offline'}
          </div>
        </div>

        {/* Card 3: Sandboxes */}
        <div className="hero-metric-card">
          <div className="hero-metric-top">
            <span className="hero-metric-label">Sandboxes</span>
            {failedSandboxes.data && failedSandboxes.data.total > 0 && (
              <span className="status-badge status-badge-failed" style={{ fontSize: '11px', padding: '1px 6px' }}>
                {failedSandboxes.data.total} Failed
              </span>
            )}
          </div>
          <div className="hero-metric-number font-mono">
            {active.data ? (
              <>
                {active.data.total} <span style={{ fontSize: '20px', fontWeight: 500, color: 'var(--text-muted)' }}>active</span>
              </>
            ) : (
              '—'
            )}
          </div>
          <div className="hero-metric-sub">
            {failedSandboxes.data && failedSandboxes.data.total > 0 ? (
              <span className="text-critical font-bold">{failedSandboxes.data.total} failed provisioning</span>
            ) : (
              '0 provisioning failures'
            )}
          </div>
        </div>

        {/* Card 4: IP Pool */}
        <div className="hero-metric-card">
          <div className="hero-metric-top">
            <span className="hero-metric-label">IP Pool</span>
            <span className="hero-metric-badge">
              {pool.data ? `${percent(pool.data.free, pool.data.total)}% free` : '—'}
            </span>
          </div>
          <div className="hero-metric-number font-mono">
            {pool.data ? (
              <>
                {pool.data.free} <span style={{ fontSize: '20px', fontWeight: 500, color: 'var(--text-muted)' }}>free</span>
              </>
            ) : (
              '—'
            )}
          </div>
          {freeIpsSeries.length > 1 && (
            <Sparkline
              data={freeIpsSeries}
              color="var(--primary)"
              height={28}
              emptyLabel="Telemetry active"
            />
          )}
          <div className="hero-metric-sub">
            {pool.data ? `${pool.data.allocated} leased · ${pool.data.quarantined} quarantined` : '—'}
          </div>
        </div>
      </div>

      {/* Platform health with compact status pills (below the fold) */}
      <Card title="Platform health">
        <QueryView query={health} rows={2}>
          {(h) => (
            <div className="stack-sm">
              <p>
                <StatusBadge status={h.status} />{' '}
                <span className="muted">
                  Checked <Timestamp value={h.checked_at} />
                  {h.version ? ` · API ${h.version}` : ''}
                </span>
              </p>
              <div className="health-pills-row" role="list" aria-label="Component health status">
                {h.components.map((c) => {
                  const isOk = c.status === 'ok';
                  const isDegraded = c.status === 'degraded';
                  const pillClass = isOk
                    ? 'health-pill-ok'
                    : isDegraded
                      ? 'health-pill-degraded'
                      : 'health-pill-down';
                  const dotClass = isOk
                    ? 'dot-positive'
                    : isDegraded
                      ? 'dot-warning'
                      : 'dot-critical';
                  return (
                    <span key={c.name} className={`health-pill ${pillClass}`} role="listitem">
                      <span className={`status-dot ${dotClass}`} aria-hidden />
                      <strong>{c.name}</strong>
                      <span className="muted">
                        {c.detail ? `· ${c.detail}` : `· ${c.status}`}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </QueryView>
      </Card>

      {attention.length > 0 && (
        <section
          className={`overview-attention-card card ${attentionMinimized ? 'minimized' : ''}`}
          aria-label="Items needing attention"
        >
          <div className="overview-attention-head">
            <div className="overview-attention-title">
              <span className="overview-attention-icon" aria-hidden="true">
                <AlertTriangle size={16} />
              </span>
              <strong>Needs attention</strong>
              <span className="badge badge-warning" style={{ fontSize: '11px', padding: '1px 7px' }}>
                {attention.length}
              </span>
            </div>
            {attentionMinimized && (
              <span className="overview-attention-summary truncate">
                {attention[0]?.text}
                {attention.length > 1 && ` (+${attention.length - 1} more)`}
              </span>
            )}
            <div className="overview-attention-actions">
              {attentionMinimized ? (
                <>
                  <Link to={attention[0]?.to ?? '#'} className="btn btn-secondary btn-sm">
                    Review
                  </Link>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setAttentionMinimized(false)}
                    aria-label="Expand needs attention list"
                  >
                    <ChevronDown size={14} aria-hidden />
                    <span>Expand ({attention.length})</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setAttentionMinimized(true)}
                  aria-label="Minimize needs attention list"
                >
                  <ChevronUp size={14} aria-hidden />
                  <span>Minimize</span>
                </button>
              )}
            </div>
          </div>

          {!attentionMinimized && (
            <ul className="overview-attention-list plain-list">
              {attention.map((a) => (
                <li key={a.key} className="overview-attention-item">
                  <div className="overview-attention-item-content">
                    <span className="status-dot dot-warning" aria-hidden="true" />
                    <span>{a.text}</span>
                  </div>
                  <Link to={a.to} className="btn btn-secondary btn-sm">
                    Review
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Card
        title="Gateway topology"
        description="Roles and virtual IP ownership as reported by the API."
        action={<Link to="/gateways">Open gateways</Link>}
      >
        <QueryView query={gateways} rows={3}>
          {(view) => <GatewayTopology view={view} />}
        </QueryView>
      </Card>

      <Card
        title="Recent activity"
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Link to="/observability" className="btn btn-secondary btn-sm">
              All events
            </Link>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setActivityMinimized(!activityMinimized)}
              aria-label={activityMinimized ? 'Expand recent activity' : 'Minimize recent activity'}
            >
              {activityMinimized ? (
                <>
                  <ChevronDown size={14} aria-hidden />
                  <span>Expand</span>
                </>
              ) : (
                <>
                  <ChevronUp size={14} aria-hidden />
                  <span>Minimize</span>
                </>
              )}
            </button>
          </div>
        }
      >
        <QueryView
          query={events}
          rows={activityMinimized ? 1 : 4}
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState title="No events yet" message="The API returned no events." />}
        >
          {(d) => {
            if (activityMinimized) {
              const latest = d.items[0];
              if (!latest) return null;
              return (
                <div className="overview-activity-minimized">
                  <span className="activity-label-muted">Latest:</span>
                  <StatusBadge status={latest.severity} />
                  <span className="activity-minimized-msg truncate">{latest.message}</span>
                  <span className="muted activity-minimized-time font-mono">
                    <Timestamp value={latest.at} compact />
                  </span>
                </div>
              );
            }
            return (
              <ul className="plain-list overview-activity-expanded">
                {d.items.slice(0, 5).map((e) => (
                  <li key={e.id} className="activity overview-activity-item">
                    <StatusBadge status={e.severity} />
                    <span className="activity-msg">{e.message}</span>
                    <span className="muted activity-time font-mono">
                      <Timestamp value={e.at} compact />
                    </span>
                  </li>
                ))}
              </ul>
            );
          }}
        </QueryView>
      </Card>
    </>
  );
}
