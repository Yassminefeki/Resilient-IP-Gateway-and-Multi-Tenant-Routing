import { Download, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApi } from '../app-context';
import { isApiError } from '../api/errors';
import type { Sandbox } from '../api/contracts';
import { DataTable, type Column } from '../components/DataTable';
import { ConfirmDialog, DetailPanel, Modal } from '../components/Modal';
import { QueryView } from '../components/QueryView';
import { downloadJsonEvidence } from '../lib/evidence';

import {
  ActionButton,
  CapabilityNote,
  CopyButton,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  SearchInput,
  SelectFilter,
  StatusBadge,
  Timestamp,
} from '../components/ui';
import { useCapability, useEvents, useSandboxes } from '../hooks/queries';
import { newKey } from '../lib/format';
import { validateProvision, type ProvisionInput } from '../lib/validation';
import { useOperations } from '../operations/OperationsProvider';

const PAGE_SIZE = 8;
const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  ...['requested', 'provisioning', 'active', 'failed', 'terminating', 'terminated', 'expired'].map(
    (s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }),
  ),
];

export function Sandboxes() {
  const location = useLocation();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('created_at:desc');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(
    Boolean((location.state as { provision?: boolean } | null)?.provision),
  );
  const [selected, setSelected] = useState<Sandbox | null>(null);
  const [tearing, setTearing] = useState<Sandbox | null>(null);
  const provision = useCapability('sandbox_provision');
  const teardown = useCapability('sandbox_teardown');
  const query = useSandboxes({ q, status, sort, page, pageSize: PAGE_SIZE });

  const columns: Column<Sandbox>[] = [
    {
      key: 'name',
      header: 'Sandbox',
      sortKey: 'name',
      render: (s) => (
        <div>
          <strong>{s.name}</strong>
          <div className="muted">
            {s.team} · <code>{s.id}</code>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      render: (s) => <StatusBadge status={s.status} />,
    },
    {
      key: 'ip',
      header: 'Private IP',
      render: (s) =>
        s.private_ip ? <code className="text-nowrap">{s.private_ip}</code> : <span className="muted">—</span>,
    },
    {
      key: 'host',
      header: 'Hostname',
      render: (s) => (s.hostname ? <span className="text-nowrap">{s.hostname}</span> : <span className="muted">—</span>),
    },
    {
      key: 'created',
      header: 'Created',
      sortKey: 'created_at',
      render: (s) => <Timestamp value={s.created_at} compact />,
    },
    { key: 'expires', header: 'Expires', render: (s) => <Timestamp value={s.expires_at} compact /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (s) => (
        <div className="row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setSelected(s)}
            aria-label={`Details for ${s.name}`}
          >
            Details
          </button>
          <ActionButton
            variant="danger"
            icon={<Trash2 size={14} aria-hidden />}
            aria-label={`Tear down ${s.name}`}
            disabledReason={
              !teardown.enabled
                ? teardown.reason
                : ['terminated', 'terminating'].includes(s.status)
                  ? `Sandbox is already ${s.status}.`
                  : undefined
            }
            onClick={() => setTearing(s)}
          >
            Tear down
          </ActionButton>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Sandboxes"
        subtitle="Create and operate isolated team environments."
        action={
          <div className="row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                downloadJsonEvidence('sandboxes-evidence', {
                  sandboxes: query.data?.items ?? [],
                  total: query.data?.total ?? 0,
                  exportedAt: new Date().toISOString(),
                });
              }}
            >
              <Download size={16} aria-hidden />
              <span>Download evidence (JSON)</span>
            </button>
            <ActionButton
              variant="primary"
              icon={<Plus size={18} aria-hidden />}
              aria-label="Provision sandbox"
              disabledReason={provision.reason}
              onClick={() => setCreating(true)}
            >
              Spin-up sandbox
            </ActionButton>
          </div>
        }
      />
      <CapabilityNote reason={provision.reason} />


      <FilterBar>
        <SearchInput
          label="Search sandboxes"
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search name, team, IP or hostname"
        />
        <SelectFilter
          label="Filter by status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={STATUS_OPTIONS}
        />
      </FilterBar>
      <QueryView
        query={query}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            title={q || status ? 'No sandboxes match your filters' : 'No sandboxes yet'}
            message={
              q || status
                ? 'Try a different search or clear the filters.'
                : 'The API returned no sandboxes. Provision one to get started.'
            }
          />
        }
      >
        {(d) => (
          <>
            <DataTable
              caption="Sandboxes"
              columns={columns}
              rows={d.items}
              rowKey={(s) => s.id}
              sort={sort}
              onSort={setSort}
            />
            <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
          </>
        )}
      </QueryView>
      {creating && <ProvisionDialog onClose={() => setCreating(false)} />}
      {selected && <SandboxDetail sandbox={selected} onClose={() => setSelected(null)} />}
      {tearing && <TeardownDialog sandbox={tearing} onClose={() => setTearing(null)} />}
    </>
  );
}

function ProvisionDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const { run } = useOperations();
  const [input, setInput] = useState<ProvisionInput>({ name: '', team: '', ttlHours: '8' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const guard = useRef(false);
  const key = useRef(newKey());

  const set = (field: keyof ProvisionInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInput((cur) => ({ ...cur, [field]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (guard.current) return; // duplicate submission guard
    const { errors: found, request } = validateProvision(input);
    setErrors(found);
    setFormError(null);
    if (!request) return;
    guard.current = true;
    setPending(true);
    try {
      await run(
        `Provision sandbox ${request.name}`,
        () => api.sandboxes.provision(request, key.current),
        {
          verify: async () => {
            const res = await api.sandboxes.list({ q: request.name, pageSize: 5 });
            const found = res.items.find((s) => s.name === request.name);
            return found?.status === 'active'
              ? { ok: true, detail: `The API reports ${request.name} as active.` }
              : {
                  ok: false,
                  detail: `The API reports ${request.name} as ${found?.status ?? 'missing'}, not active.`,
                };
          },
        },
      );
      onClose();
    } catch (err) {
      if (isApiError(err)) {
        const fields: Record<string, string> = {};
        if (err.fieldErrors.name) fields.name = err.fieldErrors.name;
        if (err.fieldErrors.team) fields.team = err.fieldErrors.team;
        if (err.fieldErrors.ttl_hours) fields.ttlHours = err.fieldErrors.ttl_hours;
        setErrors(fields);
        setFormError(
          Object.keys(fields).length
            ? null
            : `${err.message}${err.traceId ? ` (trace ${err.traceId})` : ''}`,
        );
      } else {
        setFormError('The request failed unexpectedly.');
      }
      guard.current = false;
      setPending(false);
    }
  }

  return (
    <Modal
      title="Provision sandbox"
      description="Requests an isolated environment with a private IP lease."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="provision-form"
            className="btn btn-primary"
            aria-disabled={pending}
            disabled={pending}
          >
            {pending ? 'Sending request…' : 'Provision sandbox'}
          </button>
        </>
      }
    >
      <form id="provision-form" className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <Field
          id="sbx-name"
          label="Sandbox name"
          hint="3–32 lowercase letters, digits or hyphens."
          error={errors.name}
        >
          <input
            id="sbx-name"
            value={input.name}
            onChange={set('name')}
            autoComplete="off"
            aria-invalid={Boolean(errors.name)}
            aria-describedby="sbx-name-msg"
            data-autofocus
          />
        </Field>
        <Field id="sbx-team" label="Team" error={errors.team}>
          <input
            id="sbx-team"
            value={input.team}
            onChange={set('team')}
            autoComplete="off"
            aria-invalid={Boolean(errors.team)}
            aria-describedby="sbx-team-msg"
          />
        </Field>
        <Field
          id="sbx-ttl"
          label="Lifetime (hours)"
          hint="Whole hours, 1–72. The lease expires automatically."
          error={errors.ttlHours}
        >
          <input
            id="sbx-ttl"
            inputMode="numeric"
            value={input.ttlHours}
            onChange={set('ttlHours')}
            aria-invalid={Boolean(errors.ttlHours)}
            aria-describedby="sbx-ttl-msg"
          />
        </Field>
        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      <p
        id={`${id}-msg`}
        className={error ? 'form-error' : 'muted'}
        role={error ? 'alert' : undefined}
      >
        {error ?? hint ?? ''}
      </p>
    </div>
  );
}

function TeardownDialog({ sandbox, onClose }: { sandbox: Sandbox; onClose: () => void }) {
  const api = useApi();
  const { run } = useOperations();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  async function confirm() {
    if (pending) return;
    setPending(true);
    try {
      await run(
        `Tear down ${sandbox.name}`,
        () => api.sandboxes.teardown(sandbox.id, key.current),
        {
          verify: async () => {
            const s = await api.sandboxes.get(sandbox.id);
            return s.status === 'terminated'
              ? { ok: true, detail: 'The API reports the sandbox as terminated.' }
              : { ok: false, detail: `The API reports the sandbox as ${s.status}.` };
          },
        },
      );
      onClose();
    } catch (err) {
      setError(isApiError(err) ? err.message : 'The request failed unexpectedly.');
      setPending(false);
    }
  }
  return (
    <ConfirmDialog
      title={`Tear down ${sandbox.name}?`}
      tone="danger"
      confirmLabel="Tear down sandbox"
      pending={pending}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onClose}
      consequences={
        <p>
          This deletes the sandbox and everything running in it, removes its route, and moves its IP
          {sandbox.private_ip ? ` (${sandbox.private_ip})` : ''} into quarantine. It cannot be
          undone. The sandbox is only shown as terminated once the API confirms it.
        </p>
      }
    />
  );
}

function SandboxDetail({ sandbox, onClose }: { sandbox: Sandbox; onClose: () => void }) {
  const api = useApi();
  const events = useEvents({ q: sandbox.id, pageSize: 5 });
  const [domainInput, setDomainInput] = useState(sandbox.custom_domain ?? '');
  const [domainPending, setDomainPending] = useState(false);
  const [domainStatus, setDomainStatus] = useState<string | null>(null);

  const handleSaveDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api.sandboxes.customDomain) return;
    setDomainPending(true);
    setDomainStatus(null);
    try {
      const res = await api.sandboxes.customDomain({
        sandbox_id: sandbox.id,
        custom_domain: domainInput.trim(),
      });
      if (res.success) {
        setDomainStatus(domainInput.trim() ? 'Domain mapped!' : 'Domain cleared');
      }
    } catch {
      setDomainStatus('Failed to map domain');
    } finally {
      setDomainPending(false);
    }
  };

  return (
    <DetailPanel
      title={sandbox.name}
      description={`${sandbox.team} · ${sandbox.id}`}
      onClose={onClose}
    >
      <div className="stack">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <StatusBadge status={sandbox.status} />
          </dd>
          {sandbox.status_reason && (
            <>
              <dt>Reason</dt>
              <dd>{sandbox.status_reason}</dd>
            </>
          )}
          <dt>Lease</dt>
          <dd>
            {sandbox.lease_id ? (
              <>
                <code>{sandbox.lease_id}</code>{' '}
                <CopyButton value={sandbox.lease_id} label="lease ID" />
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt>Private IP</dt>
          <dd>{sandbox.private_ip ?? '—'}</dd>
          <dt>Route</dt>
          <dd>{sandbox.hostname ?? 'No route reported'}</dd>
          <dt>Custom Domain</dt>
          <dd>
            <form onSubmit={handleSaveDomain} className="row wrap" style={{ gap: '6px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="e.g. app.team1.example.com"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                style={{ width: '210px', padding: '3px 8px', fontSize: '12px' }}
              />
              <button type="submit" className="btn btn-secondary btn-sm" disabled={domainPending}>
                {domainPending ? 'Saving…' : domainStatus ? domainStatus : 'Map domain'}
              </button>
            </form>
          </dd>
          <dt>Created</dt>
          <dd>
            <Timestamp value={sandbox.created_at} />
          </dd>
          <dt>Expires</dt>
          <dd>
            <Timestamp value={sandbox.expires_at} />
          </dd>
        </dl>
        <section>
          <h3 className="subsection-title">Lifecycle history</h3>
          {sandbox.history?.length ? (
            <ol className="plain-list">
              {sandbox.history.map((h, i) => (
                <li key={i}>
                  <StatusBadge status={h.status} /> <Timestamp value={h.at} />{' '}
                  {h.message && <span className="muted">— {h.message}</span>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Not reported by API.</p>
          )}
        </section>
        <section>
          <h3 className="subsection-title">Related events</h3>
          <QueryView
            query={events}
            rows={2}
            isEmpty={(d) => d.items.length === 0}
            empty={<p className="muted">No related events.</p>}
          >
            {(d) => (
              <ul className="plain-list">
                {d.items.map((e) => (
                  <li key={e.id}>
                    <StatusBadge status={e.severity} /> {e.message}{' '}
                    <span className="muted">
                      <Timestamp value={e.at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </QueryView>
        </section>
      </div>
    </DetailPanel>
  );
}
