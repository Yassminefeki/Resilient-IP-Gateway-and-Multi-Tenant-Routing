import { Download, Flame } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../app-context';
import { isApiError } from '../api/errors';
import type { Gateway } from '../api/contracts';
import { ConfirmDialog } from '../components/Modal';
import { GatewayTopology, type FailoverEventInfo } from '../components/GatewayTopology';
import { QueryView } from '../components/QueryView';
import {
  ActionButton,
  Card,
  CapabilityNote,
  EmptyState,
  PageHeader,
  StatusBadge,
  Timestamp,
} from '../components/ui';
import { useCapability, useGateways, useOperationHistory } from '../hooks/queries';
import { downloadJsonEvidence } from '../lib/evidence';
import { formatDuration, newKey } from '../lib/format';
import { useOperations } from '../operations/OperationsProvider';

export function Gateways() {
  const api = useApi();
  const { run } = useOperations();
  const failover = useCapability('gateway_failover');
  const gateways = useGateways();
  const history = useOperationHistory({ q: 'failover', pageSize: 10 });
  const [target, setTarget] = useState<Gateway | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFailover, setLastFailover] = useState<FailoverEventInfo | null>(null);
  const key = useRef(newKey());

  async function confirm(t: Gateway) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const start = Date.now();
      await run(
        `Fail over virtual IP to ${t.name}`,
        () => api.gateways.failover({ target_gateway_id: t.id }, key.current),
        {
          // Success is only claimed if the API now reports the target as VIP owner.
          verify: async () => {
            const view = await api.gateways.get();
            return view.vip.owner_gateway_id === t.id
              ? { ok: true, detail: `The API reports ${t.name} as the virtual IP owner.` }
              : { ok: false, detail: `The API does not report ${t.name} as the virtual IP owner.` };
          },
        },
      );
      const elapsed = Date.now() - start;
      setLastFailover({
        ownerName: t.name,
        duration: `${elapsed} ms (observed by console, ±1 s)`,
        timestamp: Date.now(),
        totalMs: elapsed,
      });
      key.current = newKey();
      setTarget(null);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The request failed unexpectedly.');
    }
    setPending(false);
  }

  return (
    <>
      <PageHeader
        title="Gateways"
        subtitle="Redundant HAProxy and Keepalived gateways sharing one virtual IP."
        action={
          gateways.data ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                downloadJsonEvidence('gateways-cluster-evidence', {
                  vip: gateways.data?.vip ?? null,
                  gateways: gateways.data?.gateways ?? [],
                  lastFailover: lastFailover ?? null,
                });
              }}
            >
              <Download size={16} aria-hidden />
              <span>Download evidence (JSON)</span>
            </button>
          ) : undefined
        }
      />
      <QueryView
        query={gateways}
        rows={4}
        isEmpty={(v) => v.gateways.length === 0}
        empty={<EmptyState title="No gateways reported" message="The API returned no gateways." />}
      >
        {(view) => (
          <Card
            title="Topology"
            description="Roles and ownership are exactly what the API reports; nothing is assumed."
            action={
              <div className="row wrap">
                {view.gateways.map((g) => (
                  <ActionButton
                    key={g.id}
                    variant="secondary"
                    disabledReason={
                      !failover.enabled
                        ? failover.reason
                        : g.owns_vip
                          ? `${g.name} already owns the virtual IP.`
                          : g.keepalived.status !== 'up'
                            ? `${g.name} Keepalived is not reported up.`
                            : undefined
                    }
                    onClick={() => {
                      setError(null);
                      setTarget(g);
                    }}
                  >
                    Fail over to {g.name}
                  </ActionButton>
                ))}
                <Link
                  to="/drill"
                  className="btn btn-secondary"
                  title="Live Drill console with 100ms probing and downtime measurement"
                >
                  <Flame size={16} aria-hidden />
                  <span>Live Drill</span>
                </Link>
              </div>
            }
          >
            <CapabilityNote reason={failover.reason} />
            <GatewayTopology view={view} detailed lastFailover={lastFailover} />
          </Card>
        )}
      </QueryView>

      {/* Failover history as a structured table (Requirement 5) */}
      <Card title="Failover history" description="From the backend operation history.">
        <QueryView
          query={history}
          rows={2}
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState
              title="No failovers recorded"
              message="The API reports no failover operations."
            />
          }
        >
          {(d) => (
            <div className="table-wrap">
              <table className="data-table" aria-label="Failover history">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Trigger</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <Timestamp value={o.started_at} />
                      </td>
                      <td>
                        <strong>
                          {o.requested_by ? `Manual (${o.requested_by})` : 'Automatic (VRRP election)'}
                        </strong>
                        {o.message && (
                          <div className="muted" style={{ fontSize: '12px' }}>
                            {o.message}
                          </div>
                        )}
                      </td>
                      <td className="font-mono">{formatDuration(o.started_at, o.finished_at)}</td>
                      <td>
                        <StatusBadge status={o.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      </Card>

      {target && (
        <ConfirmDialog
          title={`Fail over to ${target.name}?`}
          confirmLabel="Request failover"
          pending={pending}
          error={error}
          onConfirm={() => void confirm(target)}
          onCancel={() => setTarget(null)}
          consequences={
            <p>
              This asks the control plane to move the virtual IP to {target.name}. Connections held
              by the current owner may be interrupted. Success is only reported after the API
              confirms the new owner; downtime is not claimed or measured here.
            </p>
          }
        />
      )}
    </>
  );
}
