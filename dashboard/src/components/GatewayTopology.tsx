import { CheckCircle2, Globe, Radio, Server, Zap } from 'lucide-react';
import type { GatewaysView } from '../api/contracts';
import { GenerationTooltip, StatusBadge, Timestamp, VipTooltip } from './ui';

export interface FailoverEventInfo {
  ownerName: string;
  duration: string;
  timestamp: number;
  totalMs?: number;
  probesFailed?: number;
  fromDrill?: boolean;
}

/** Roles, health and VIP ownership are rendered strictly from API data. */
export function GatewayTopology({
  view,
  detailed = false,
  lastFailover,
}: {
  view: GatewaysView;
  detailed?: boolean;
  lastFailover?: FailoverEventInfo | null;
}) {
  const currentOwnerId = view.vip.owner_gateway_id;
  const owner = view.gateways.find((g) => g.id === currentOwnerId);

  return (
    <div className="topology-container">
      {lastFailover && (
        <div className="failover-banner" role="status" aria-live="polite">
          <span>
            Failover verified in {lastFailover.duration} — VIP transferred to {lastFailover.ownerName}
            {lastFailover.probesFailed === 0
              ? ' with 0 lost requests'
              : lastFailover.probesFailed != null
                ? ` with ${lastFailover.probesFailed} failed probes`
                : ''}
          </span>
        </div>
      )}

      <div className="topology-stage">
        <div className="vip vip-card-enhanced" aria-label="Virtual IP">
          <Globe size={20} aria-hidden />
          <div>
            <p className="muted" style={{ display: 'flex', alignItems: 'center' }}>
              Virtual IP <VipTooltip />
            </p>
            <p className="vip-address">{view.vip.address}</p>
            <p className="muted">{owner ? `Owned by ${owner.name}` : 'Owner not reported'}</p>
          </div>
        </div>

        {/* Dynamic SVG link lines between VIP and each gateway card */}
        <div className="topology-connector-strip" aria-hidden="true">
          <svg
            className="topology-connector-svg"
            viewBox="0 0 100 36"
            preserveAspectRatio="none"
          >
            {view.gateways.map((g, idx) => {
              const targetX =
                view.gateways.length === 1
                  ? 50
                  : Math.round(((idx + 0.5) / view.gateways.length) * 100);
              const isOwner = Boolean(g.owns_vip);
              return (
                <path
                  key={g.id}
                  d={`M 50 0 C 50 18, ${targetX} 18, ${targetX} 36`}
                  className={`link-line ${isOwner ? 'active' : 'standby'}`}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
        </div>

        <div className="gateway-grid">
          {view.gateways.map((g) => (
            <article
              key={g.id}
              className={`gateway card ${g.owns_vip ? 'gateway-owner' : ''}`}
              aria-label={g.name}
            >
              <header className="gateway-head">
                <Server size={18} aria-hidden />
                <h3 className="gateway-name">{g.name}</h3>
                <StatusBadge status={g.role} />
              </header>
                <dl className="kv">
                  <dt>Virtual IP</dt>
                  <dd>{g.owns_vip ? 'Owns the virtual IP' : 'Does not own the virtual IP'}</dd>
                  <dt>HAProxy</dt>
                  <dd>
                    <StatusBadge status={g.haproxy.status} />
                  </dd>
                  <dt>Keepalived</dt>
                  <dd>
                    <StatusBadge status={g.keepalived.status} />
                  </dd>
                  {detailed && g.address && (
                    <>
                      <dt>Address</dt>
                      <dd>
                        <code>{g.address}</code>
                      </dd>
                    </>
                  )}
                  <dt>Last check</dt>
                  <dd>
                    <Timestamp value={g.last_check_at} />
                  </dd>
                  {detailed && (
                    <>
                      <dt style={{ display: 'flex', alignItems: 'center' }}>
                        Config generation <GenerationTooltip />
                      </dt>
                      <dd>{g.config_generation ?? 'Not reported by API'}</dd>
                    </>
                  )}
                </dl>
              </article>
          ))}
        </div>
      </div>

      {/* Failover Timeline Evidence Strip */}
      <div className="failover-timeline-container" aria-label="Failover verification timeline">
        <div className="timeline-header">
          <span className="timeline-title">VRRP Failover Evidence & Timeline</span>
          <span className={`timeline-measured-badge ${lastFailover ? '' : 'badge-neutral'}`}>
            {lastFailover
              ? `Observed failover: ${lastFailover.duration}`
              : 'Not measured in this session'}
          </span>
        </div>

        {lastFailover ? (
          <div className="failover-steps-strip">
            <div className="failover-step">
              <div className="step-icon-wrap step-icon-down">
                <Radio size={16} aria-hidden />
              </div>
              <div className="step-content">
                <span className="step-name">1. Primary Down</span>
                <span className="step-desc">VRRP advert timeout</span>
                <span className="step-time font-mono">Not reported</span>
              </div>
            </div>
            <div className="timeline-arrow" aria-hidden>→</div>
            <div className="failover-step">
              <div className="step-icon-wrap step-icon-vrrp">
                <Zap size={16} aria-hidden />
              </div>
              <div className="step-content">
                <span className="step-name">2. VRRP Election</span>
                <span className="step-desc">Standby node to MASTER</span>
                <span className="step-time font-mono">Not reported</span>
              </div>
            </div>
            <div className="timeline-arrow" aria-hidden>→</div>
            <div className="failover-step">
              <div className="step-icon-wrap step-icon-vip">
                <Globe size={16} aria-hidden />
              </div>
              <div className="step-content">
                <span className="step-name">3. VIP Moved & GARP</span>
                <span className="step-desc">Gratuitous ARP broadcast</span>
                <span className="step-time font-mono">Not reported</span>
              </div>
            </div>
            <div className="timeline-arrow" aria-hidden>→</div>
            <div className="failover-step">
              <div className="step-icon-wrap step-icon-traffic">
                <CheckCircle2 size={16} aria-hidden />
              </div>
              <div className="step-content">
                <span className="step-name">4. Traffic Verified</span>
                <span className="step-desc">HTTP 200 via new VIP node</span>
                <span className="step-time font-mono">{lastFailover.duration}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="failover-empty-notice">
            <p className="muted" style={{ margin: 0, padding: '10px 0' }}>
              No failover executed yet — see <strong>Live Drill</strong> to trigger Keepalived VRRP transition.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
