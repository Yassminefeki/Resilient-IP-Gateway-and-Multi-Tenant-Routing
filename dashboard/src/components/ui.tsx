import { Check, Copy, HelpCircle, Search } from 'lucide-react';
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { labelFor, TONE_SYMBOL, type Tone } from '../lib/labels';
import { formatCompactDateTime, formatDateTime } from '../lib/format';
import type { TrackedOp } from '../operations/OperationsProvider';

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const l = labelFor(status);
  return (
    <span className={`badge badge-${l.tone}`}>
      <span aria-hidden className="badge-symbol">
        {TONE_SYMBOL[l.tone]}
      </span>
      {label ?? l.text}
    </span>
  );
}

export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span aria-hidden className="badge-symbol">
        {TONE_SYMBOL[tone]}
      </span>
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {action && <div className="page-action">{action}</div>}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="metric card">
      <p className="metric-label">{label}</p>
      <p className="metric-value">{value}</p>
      {hint && <p className={`metric-hint ${tone ? `tone-${tone}` : ''}`}>{hint}</p>}
    </div>
  );
}

export function Card({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card section-card">
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <h2 className="section-title">{title}</h2>}
            {description && <p className="muted">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="state" data-testid="empty-state">
      <h3 className="state-title">{title}</h3>
      <p className="muted">{message}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  title = 'Could not load this data',
  message,
  traceId,
  onRetry,
}: {
  title?: string;
  message: string;
  traceId?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state state-error" role="alert" data-testid="error-state">
      <h3 className="state-title">{title}</h3>
      <p>{message}</p>
      {traceId && (
        <p className="muted">
          Trace ID: <code>{traceId}</code>
        </p>
      )}
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function LoadingSkeleton({
  rows = 4,
  label = 'Loading',
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <div className="skeleton-wrap" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn icon-btn-small"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

export function Timestamp({
  value,
  compact = false,
}: {
  value: string | null | undefined;
  compact?: boolean;
}) {
  if (!value) return <span className="muted">—</span>;
  return (
    <time dateTime={value} title={value} className="timestamp-nowrap">
      {compact ? formatCompactDateTime(value) : formatDateTime(value)}
    </time>
  );
}

export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
}) {
  return (
    <label className="search">
      <Search size={16} aria-hidden />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={value}
        placeholder={placeholder ?? label}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="filter-bar" role="search">
      {children}
    </div>
  );
}

export function SelectFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="select-field">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize)
    return (
      <p className="muted pagination-note">
        {total} {total === 1 ? 'result' : 'results'}
      </p>
    );
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted">
        Page {page} of {pages} · {total} results
      </span>
      <div className="row">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  /** When set the action is unavailable; the reason is exposed to all users. */
  disabledReason?: string;
  icon?: ReactNode;
}

export function ActionButton({
  variant = 'secondary',
  disabledReason,
  icon,
  children,
  className = '',
  onClick,
  ...rest
}: ActionButtonProps) {
  const blocked = Boolean(disabledReason);
  return (
    <button
      type="button"
      {...rest}
      className={`btn btn-${variant} ${blocked ? 'is-unavailable' : ''} ${className}`}
      aria-disabled={blocked || rest.disabled ? true : undefined}
      title={disabledReason}
      onClick={blocked || rest.disabled ? undefined : onClick}
    >
      {icon}
      {children}
    </button>
  );
}

export function CapabilityNote({ reason }: { reason?: string }) {
  if (!reason) return null;
  return (
    <p className="capability-note" role="note">
      {reason}
    </p>
  );
}

export function OriginBadge({ origin }: { origin: string }) {
  return <StatusBadge status={origin} />;
}

export function OperationStatus({ op, onDismiss }: { op: TrackedOp; onDismiss?: () => void }) {
  const running = op.state === 'accepted' || op.state === 'running';
  const headline =
    op.state === 'accepted'
      ? 'Request accepted'
      : op.state === 'running'
        ? 'In progress'
        : op.state === 'succeeded'
          ? op.verification?.status === 'verified'
            ? 'Completed and verified'
            : op.verification?.status === 'pending'
              ? 'Job finished — verifying'
              : op.verification?.status === 'unverified'
                ? 'Job finished — not verified'
                : 'Completed'
          : op.state === 'failed'
            ? 'Failed'
            : 'Outcome unknown';
  const tone: Tone =
    op.state === 'failed'
      ? 'critical'
      : op.state === 'unknown' || op.verification?.status === 'unverified'
        ? 'warning'
        : op.state === 'succeeded' && op.verification?.status !== 'pending'
          ? 'positive'
          : 'info';
  return (
    <div className="op" role="status" aria-live="polite" data-state={op.state}>
      <div className="op-head">
        <div>
          <p className="op-label">{op.label}</p>
          <ToneBadge tone={tone}>{headline}</ToneBadge>{' '}
          {op.simulated && <ToneBadge tone="warning">Simulated</ToneBadge>}
        </div>
        {!running && onDismiss && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onDismiss}
            aria-label={`Dismiss ${op.label}`}
          >
            Dismiss
          </button>
        )}
      </div>
      {op.message && <p className="muted">{op.message}</p>}
      {op.verification && <p className="muted">Verification: {op.verification.detail}</p>}
      {op.steps && op.steps.length > 0 && (
        <ol className="op-steps">
          {op.steps.map((s) => (
            <li key={s.name}>
              <StatusBadge
                status={s.status}
                label={`${s.name} — ${labelFor(s.status).text.toLowerCase()}`}
              />
            </li>
          ))}
        </ol>
      )}
      <p className="muted">
        Started <Timestamp value={op.startedAt} />
        {op.jobId && (
          <>
            {' '}
            · Job <code>{op.jobId}</code>
          </>
        )}
      </p>
    </div>
  );
}

export function Tooltip({
  text,
  children,
  position = 'top',
}: {
  text: string;
  children: ReactNode;
  position?: 'top' | 'bottom';
}) {
  const [visible, setVisible] = useState(false);
  return (
    <span
      className="tooltip-wrapper"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span role="tooltip" className={`tooltip-bubble tooltip-${position}`}>
          {text}
        </span>
      )}
    </span>
  );
}

export function InfoTooltip({
  text,
  label = 'Learn more',
}: {
  text: string;
  label?: string;
}) {
  return (
    <Tooltip text={text}>
      <button
        type="button"
        className="tooltip-trigger-btn"
        aria-label={label}
        onClick={(e) => e.preventDefault()}
      >
        <HelpCircle size={14} aria-hidden />
      </button>
    </Tooltip>
  );
}

export function VipTooltip() {
  return (
    <InfoTooltip
      label="About Virtual IP (VIP)"
      text="Virtual IP (VIP) is a single floating IP address shared between primary and standby gateways. Keepalived instantly routes incoming traffic to the active gateway without downtime."
    />
  );
}

export function GenerationTooltip() {
  return (
    <InfoTooltip
      label="About Configuration Generation"
      text="A monotonic generation counter tracking routing updates. Both gateways must reach the same generation to ensure routing consistency."
    />
  );
}

export function ReconciliationTooltip() {
  return (
    <InfoTooltip
      label="About Lease Reconciliation"
      text="Reconciliation compares the IPAM lease database against real Linux network namespaces and HAProxy rules, recovering expired leases and resolving orphaned IPs."
    />
  );
}
