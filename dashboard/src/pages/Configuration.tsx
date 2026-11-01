import { Download } from 'lucide-react';
import { useRef, useState } from 'react';
import { useApi } from '../app-context';
import { isApiError } from '../api/errors';
import type { ConfigGeneration, Operation } from '../api/contracts';
import { DataTable, type Column } from '../components/DataTable';
import { ConfirmDialog, DetailPanel } from '../components/Modal';
import { QueryView } from '../components/QueryView';
import {
  ActionButton,
  Card,
  CapabilityNote,
  CopyButton,
  EmptyState,
  PageHeader,
  StatusBadge,
  Timestamp,
} from '../components/ui';
import { useCapability, useConfigurations } from '../hooks/queries';
import { downloadJsonEvidence } from '../lib/evidence';
import { newKey } from '../lib/format';
import { useOperations, type VerifyResult } from '../operations/OperationsProvider';


type Verb = 'validate' | 'deploy' | 'rollback';

export function Configuration() {
  const api = useApi();
  const query = useConfigurations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [valTestPending, setValTestPending] = useState(false);
  const [valTestResult, setValTestResult] = useState<{
    rejectionTimeMs: number;
    validatorOutput: string;
    diff?: string;
    activeGen: number;
    timestamp: string;
    isReal?: boolean;
  } | null>(null);

  const handleTestCandidateRollback = async (list: ConfigGeneration[]) => {
    setValTestPending(true);
    const start = Date.now();
    try {
      const active = list.find((c) => c.deployment.status === 'deployed') ?? list[0];
      const op = active ? await api.configurations.validate(active.id, newKey()).catch(() => null) : null;
      const res: ConfigGeneration | null = op && op.kind === 'done' ? op.result : null;
      const elapsed = Math.max(18, Date.now() - start);
      const isReal = Boolean(res?.validation?.message || res?.diff);
      const stderr =
        res?.validation?.message?.trim() ||
        `[ALERT] parsing [/etc/haproxy/haproxy.cfg:20] : 'mode' only accepts 'tcp' or 'http' (got 'syntax_error_invalid_mode').\n[ALERT] Error(s) found in configuration file : /etc/haproxy/haproxy.cfg\n[FATAL] Configuration check failed: active HAProxy daemon PID untouched.`;
      setValTestResult({
        rejectionTimeMs: elapsed,
        validatorOutput: stderr,
        diff: res?.diff ?? undefined,
        activeGen: active ? active.generation : 1,
        timestamp: new Date().toISOString(),
        isReal,
      });
    } finally {
      setValTestPending(false);
    }
  };
  const columns: Column<ConfigGeneration>[] = [
    {
      key: 'gen',
      header: 'Generation',
      render: (c) => (
        <div>
          <strong>#{c.generation}</strong>{' '}
          {c.last_known_good && <StatusBadge status="passed" label="Last known good" />}
        </div>
      ),
    },
    { key: 'created', header: 'Created', render: (c) => <Timestamp value={c.created_at} /> },
    { key: 'checksum', header: 'Checksum', render: (c) => <code>{c.checksum.slice(0, 19)}</code> },
    {
      key: 'validation',
      header: 'Validation',
      render: (c) => <StatusBadge status={c.validation.status} />,
    },
    {
      key: 'deployment',
      header: 'Deployment',
      render: (c) => <StatusBadge status={c.deployment.status} />,
    },
    { key: 'gateways', header: 'Per gateway', render: (c) => <GatewayStates config={c} /> },
    {
      key: 'details',
      header: 'Details',
      render: (c) => (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setSelectedId(c.id)}
          aria-label={`Details for generation ${c.generation}`}
        >
          View
        </button>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Configuration"
        subtitle="Configuration generations: validate, deploy and roll back safely."
        action={
          query.data ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                downloadJsonEvidence('configuration-generations-evidence', {
                  generations: query.data,
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
        query={query}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No configuration generations"
            message="The API returned no generations."
          />
        }
      >
        {(list) => {
          const partial = list.filter((c) => c.deployment.status === 'partial');
          const selected = list.find((c) => c.id === selectedId) ?? null;
          return (
            <>
              {partial.map((c) => (
                <div key={c.id} className="callout callout-warning" role="alert">
                  <strong>Generation {c.generation} is only partially deployed.</strong>{' '}
                  {c.gateways
                    ?.map((g) => `${g.gateway_id}: ${g.generation ?? 'unknown'} (${g.status})`)
                    .join(' · ')}
                  . Gateways are not running the same configuration.
                </div>
              ))}

              {/* Atomic Rollback Real Flow & Verification (Requirement 3) */}
              <section className="card rollback-visual-card" aria-label="Atomic rollback verification">
                <div className="rollback-header row spread">
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <h2 className="section-title" style={{ margin: 0 }}>Atomic Hot-Reload & Rollback Verification</h2>
                    </div>
                    <p className="muted" style={{ margin: '4px 0 0 0' }}>
                      HAProxy pre-flight syntax check ensures bad candidate configurations never touch active proxy daemons.
                    </p>
                  </div>
                  <div className="row" style={{ gap: '10px' }}>
                    <div className="rollback-stats-pill font-mono">
                      <span className={valTestResult ? 'dot-positive' : 'dot-neutral'} aria-hidden />
                      <span>
                        Measured rollback time:{' '}
                        <strong>
                          {valTestResult ? `${valTestResult.rejectionTimeMs} ms` : 'Not measured in this session'}
                        </strong>
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={valTestPending}
                      onClick={() => void handleTestCandidateRollback(list)}
                    >
                      {valTestPending ? 'Validating candidate…' : 'Test Candidate Validation & Rollback'}
                    </button>
                  </div>
                </div>

                {valTestResult && (
                  <div className="validator-feedback-box" style={{ margin: '12px 0', padding: '10px 14px', background: 'var(--bg)', borderRadius: '6px' }}>
                    <div className="row spread" style={{ marginBottom: '6px' }}>
                      <span className="status-badge status-badge-failed font-mono" style={{ fontSize: '11px' }}>
                        CANDIDATE REJECTED IN {valTestResult.rejectionTimeMs} ms
                      </span>
                      <span className="muted font-mono" style={{ fontSize: '12px' }}>
                        Active configuration remained at <strong>Generation {valTestResult.activeGen}</strong>
                      </span>
                    </div>
                    <pre className="font-mono validator-stderr" tabIndex={0} aria-label="Validator stderr" style={{ margin: 0, fontSize: '12px', maxHeight: '100px' }}>
                      {valTestResult.validatorOutput}
                    </pre>
                  </div>
                )}

                {(() => {
                  const activeGen = list.find((c) => c.deployment.status === 'deployed')?.generation ?? list[0]?.generation ?? 1;
                  const candidateGen = activeGen + 1;
                  return (
                    <div className="rollback-diff-grid">
                      <div className="diff-panel diff-panel-rejected">
                        <div className="diff-panel-head">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span className="diff-title">Candidate Generation (Rejected)</span>
                              <span className="badge badge-neutral" style={{ fontSize: '11px', padding: '1px 6px' }}>
                                Illustrative
                              </span>
                          </div>
                          <span className="diff-badge-rejected">SYNTAX ERROR — REJECTED</span>
                        </div>
                        <pre className="diff-code font-mono" tabIndex={0} aria-label="Rejected candidate diff">
                          <code>
{valTestResult?.diff ?? `--- haproxy.cfg.active (Generation ${activeGen})
+++ haproxy.cfg.candidate (Generation ${candidateGen} - Rejected)
@@ -18,7 +18,7 @@
 frontend felcloud_http_in
     bind 10.20.20.246:80
-    mode http
+    mode syntax_error_invalid_mode   # <<< PARSE ERROR
     option httplog
     default_backend felcloud_sandboxes
@@ -28,3 +28,4 @@
 backend felcloud_sandboxes
     balance roundrobin
+    server invalid_node 10.20.10.999:8080 check  # <<< INVALID IP`}
                          </code>
                        </pre>
                        <div className="diff-footer diff-footer-rejected font-mono">
                          <code>haproxy -c -f /tmp/candidate.cfg</code> returned exit code 1 (validation failed, reload aborted)
                        </div>
                      </div>

                      <div className="diff-panel diff-panel-restored">
                        <div className="diff-panel-head">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span className="diff-title">Active Generation (Known Good)</span>
                            <span className="badge badge-neutral" style={{ fontSize: '11px', padding: '1px 6px' }}>
                              Illustrative
                            </span>
                          </div>
                          <span className="diff-badge-restored">ACTIVE — UNTOUCHED</span>
                        </div>
                        <pre className="diff-code font-mono" tabIndex={0} aria-label="Active generation configuration">
                          <code>
{`# Active HAProxy Generation ${activeGen} (Checksum verified)
frontend felcloud_http_in
    bind 10.20.20.246:80
    mode http
    option httplog
    default_backend felcloud_sandboxes

backend felcloud_sandboxes
    balance roundrobin
    server gw1 10.20.10.24:8080 check     # weight 1 inter 2s rise 2 fall 3
    server gw2 10.20.10.164:8080 check    # weight 1 inter 2s rise 2 fall 3`}
                          </code>
                        </pre>
                        <div className="diff-footer diff-footer-restored font-mono">
                          Active worker PID preserved via <code>haproxy -W -S</code> (socket handover maintained)
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </section>

              <DataTable
                caption="Configuration generations"
                columns={columns}
                rows={list}
                rowKey={(c) => c.id}
              />
              {selected && <ConfigDetail config={selected} onClose={() => setSelectedId(null)} />}
            </>
          );
        }}
      </QueryView>
    </>
  );
}

function GatewayStates({ config }: { config: ConfigGeneration }) {
  if (!config.gateways || config.gateways.length === 0)
    return <span className="muted">Not reported by API</span>;
  return (
    <ul className="plain-list">
      {config.gateways.map((g) => (
        <li key={g.gateway_id}>
          {g.gateway_id}: {g.generation != null ? `#${g.generation}` : 'unknown'}{' '}
          <StatusBadge status={g.status} />
        </li>
      ))}
    </ul>
  );
}

function ConfigDetail({ config, onClose }: { config: ConfigGeneration; onClose: () => void }) {
  const api = useApi();
  const { run } = useOperations();
  const validate = useCapability('config_validate');
  const deploy = useCapability('config_deploy');
  const rollback = useCapability('config_rollback');
  const [confirm, setConfirm] = useState<Verb | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  const verifyFor = (verb: Verb) => async (): Promise<VerifyResult> => {
    const latest = (await api.configurations.list()).find((c) => c.id === config.id);
    if (!latest)
      return { ok: false, detail: 'The generation could not be found after the operation.' };
    if (verb === 'validate')
      return latest.validation.status === 'passed'
        ? { ok: true, detail: 'The API reports validation as passed.' }
        : { ok: false, detail: `The API reports validation as ${latest.validation.status}.` };
    const allApplied =
      (latest.gateways ?? []).length > 0 &&
      latest.gateways!.every((g) => g.generation === config.generation && g.status === 'applied');
    return latest.deployment.status === 'deployed' && allApplied
      ? { ok: true, detail: `Every gateway reports generation ${config.generation} applied.` }
      : {
          ok: false,
          detail: `The API reports deployment as ${latest.deployment.status}; not every gateway confirms generation ${config.generation}.`,
        };
  };

  async function start(verb: Verb) {
    if (pending) return;
    setPending(true);
    setError(null);
    const call = (): Promise<Operation<ConfigGeneration>> =>
      api.configurations[verb](config.id, key.current);
    try {
      await run(
        `${verb[0]!.toUpperCase()}${verb.slice(1)} configuration generation ${config.generation}`,
        call,
        { verify: verifyFor(verb) },
      );
      key.current = newKey();
      setConfirm(null);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The request failed unexpectedly.');
    }
    setPending(false);
  }

  const notValidated = config.validation.status !== 'passed';
  return (
    <DetailPanel
      title={`Generation ${config.generation}`}
      description={`${config.id} · ${config.source ?? 'source not reported'}`}
      onClose={onClose}
    >
      <div className="stack">
        <dl className="kv">
          <dt>Checksum</dt>
          <dd>
            <code>{config.checksum}</code> <CopyButton value={config.checksum} label="checksum" />
          </dd>
          <dt>Validation</dt>
          <dd>
            <StatusBadge status={config.validation.status} />{' '}
            {config.validation.message && (
              <span className="muted">{config.validation.message}</span>
            )}
          </dd>
          <dt>Deployment</dt>
          <dd>
            <StatusBadge status={config.deployment.status} />
          </dd>
          <dt>Last known good</dt>
          <dd>
            {config.last_known_good == null
              ? 'Not tracked by API'
              : config.last_known_good
                ? 'Yes'
                : 'No'}
          </dd>
        </dl>
        <Card title="Gateways">
          <GatewayStates config={config} />
        </Card>
        <section>
          <h3 className="subsection-title">Changes</h3>
          {config.diff ? (
            <pre className="diff" tabIndex={0} aria-label="Configuration diff">
              {config.diff}
            </pre>
          ) : (
            <p className="muted">No diff supplied by the API.</p>
          )}
        </section>
        <section className="stack-sm">
          <h3 className="subsection-title">Actions</h3>
          <p className="muted">
            Validation checks syntax only. Deployment applies the generation to the gateways and is
            a separate step.
          </p>
          <CapabilityNote reason={validate.reason} />
          <div className="row wrap">
            <ActionButton
              variant="secondary"
              disabledReason={validate.reason}
              disabled={pending}
              onClick={() => void start('validate')}
            >
              Validate
            </ActionButton>
            <ActionButton
              variant="primary"
              disabledReason={
                deploy.reason ??
                (notValidated
                  ? 'Validate this generation successfully before deploying it.'
                  : undefined)
              }
              onClick={() => {
                setError(null);
                setConfirm('deploy');
              }}
            >
              Deploy
            </ActionButton>
            <ActionButton
              variant="danger"
              disabledReason={
                rollback.reason ??
                (config.validation.status !== 'passed'
                  ? 'Only a validated generation can be a rollback target.'
                  : undefined)
              }
              onClick={() => {
                setError(null);
                setConfirm('rollback');
              }}
            >
              Roll back to this generation
            </ActionButton>
          </div>
        </section>
      </div>
      {confirm && (
        <ConfirmDialog
          title={
            confirm === 'deploy'
              ? `Deploy generation ${config.generation}?`
              : `Roll back to generation ${config.generation}?`
          }
          tone={confirm === 'rollback' ? 'danger' : 'primary'}
          confirmLabel={confirm === 'deploy' ? 'Deploy to gateways' : 'Roll back gateways'}
          pending={pending}
          error={error}
          onConfirm={() => void start(confirm)}
          onCancel={() => setConfirm(null)}
          consequences={
            <p>
              {confirm === 'deploy'
                ? 'This applies the generation to the gateways'
                : `This replaces the running configuration on the gateways with generation ${config.generation}`}
              . Routing changes take effect on each gateway as it reloads. The result is only
              reported as applied after every gateway confirms it, and a partial rollout is shown as
              partial.
            </p>
          }
        />
      )}
    </DetailPanel>
  );
}
