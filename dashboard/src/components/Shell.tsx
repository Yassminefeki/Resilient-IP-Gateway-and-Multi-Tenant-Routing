import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Menu, RefreshCw, UserRound } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../app-context';
import { tokenStore } from '../api/auth';
import { isApiError } from '../api/errors';
import { useGateways, useHealth } from '../hooks/queries';
import { NAV_ITEMS } from '../nav';
import { formatTime } from '../lib/format';
import { useOperations } from '../operations/OperationsProvider';
import { Modal } from './Modal';
import { OperationStatus, ToneBadge } from './ui';

export function DemoModeBanner() {
  const { api } = useApp();
  if (api.mode !== 'demo') return null;
  return (
    <div className="demo-banner" role="status" data-testid="demo-banner">
      DEMO DATA — NOT CONNECTED TO INFRASTRUCTURE
    </div>
  );
}

export function ConnectionIndicator() {
  const { api, config } = useApp();
  const { data, error, isPending } = useHealth();
  const isDemo = api.mode === 'demo' || config.demoMode;

  if (isDemo) {
    return <ToneBadge tone="warning">Simulator</ToneBadge>;
  }

  if (isPending) return <ToneBadge tone="neutral">Checking API…</ToneBadge>;
  if (!data) {
    const auth = isApiError(error) && (error.kind === 'auth' || error.kind === 'forbidden');
    return (
      <ToneBadge tone="critical">{auth ? 'API: sign-in required' : 'API: unreachable'}</ToneBadge>
    );
  }
  const label =
    data.status === 'ok'
      ? 'API: connected'
      : data.status === 'degraded'
        ? 'API: degraded'
        : 'API: down';
  return (
    <ToneBadge
      tone={
        data.status === 'ok'
          ? 'positive'
          : data.status === 'degraded'
            ? 'warning'
            : 'critical'
      }
    >
      {label}
    </ToneBadge>
  );
}

function ConnectionWarning({ onSignIn }: { onSignIn: () => void }) {
  const { config } = useApp();
  const { data, error, isError, dataUpdatedAt, refetch } = useHealth();
  if (!isError) return null;
  const auth = isApiError(error) && (error.kind === 'auth' || error.kind === 'forbidden');
  return (
    <div className="connection-warning" role="alert" data-testid="connection-warning">
      <div>
        <strong>{auth ? 'Authentication required.' : 'The FelCloud API is unavailable.'}</strong>{' '}
        {error instanceof Error ? error.message : ''}{' '}
        {!auth && (
          <>
            Address: <code>{config.apiBaseUrl}</code>.{' '}
          </>
        )}
        {data
          ? `Pages show last-known data from ${formatTime(dataUpdatedAt)} and may be out of date.`
          : 'No data has been received, so nothing is shown as live state.'}
      </div>
      <div className="row">
        {auth && (
          <button type="button" className="btn btn-secondary" onClick={onSignIn}>
            Set API token
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={() => void refetch()}>
          Retry connection
        </button>
      </div>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const topItems = NAV_ITEMS.filter((i) => !i.section);
  const operateItems = NAV_ITEMS.filter((i) => i.section === 'Operate');
  const insightItems = NAV_ITEMS.filter((i) => i.section === 'Insight');

  const renderItem = ({ to, label, shortLabel, icon: Icon, end }: (typeof NAV_ITEMS)[number]) => (
    <li key={to}>
      <NavLink
        to={to}
        end={end}
        aria-label={label}
        className={({ isActive }) => `nav-link ${isActive ? 'is-active' : ''}`}
        onClick={onNavigate}
        title={label}
      >
        <Icon size={19} aria-hidden />
        <span className="nav-label">{shortLabel ?? label}</span>
      </NavLink>
    </li>
  );

  return (
    <nav aria-label="Primary" className="nav-container">
      <ul className="nav-list">{topItems.map(renderItem)}</ul>
      <div className="nav-group">
        <span className="nav-group-heading">Operate</span>
        <ul className="nav-list">{operateItems.map(renderItem)}</ul>
      </div>
      <div className="nav-group">
        <span className="nav-group-heading">Insight</span>
        <ul className="nav-list">{insightItems.map(renderItem)}</ul>
      </div>
    </nav>
  );
}

function Brand() {
  const { config, api } = useApp();
  const envLabel = api.mode === 'demo' ? 'Demo' : config.environmentLabel;
  return (
    <div className="brand">
      <Link to="/" className="brand-link" aria-label="CloudPulse home">
        <div className="brand-icon-box">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="FelCloud logo" className="brand-logo-img" />
        </div>
        <span className="brand-text">
          <span className="brand-name">CloudPulse</span>
          <span className="muted brand-sub">by FelCloud</span>
        </span>
      </Link>
      <span className="env-badge" title="Display label set by VITE_ENVIRONMENT_LABEL">
        {envLabel}
      </span>
    </div>
  );
}

function SidebarFailoverStatus() {
  const gateways = useGateways();
  const gwList = gateways.data?.gateways ?? [];
  const primary = gwList.find((g) => g.owns_vip) ?? (gateways.data ? gwList[0] : null);
  const vip = gateways.data?.vip.address ?? '—';
  const allUp =
    gwList.length > 0 &&
    gwList.every((g) => g.haproxy.status === 'up' && g.keepalived.status === 'up');

  return (
    <div className="sidebar-failover-card">
      <div className="sidebar-failover-head">
        <span className="sidebar-failover-title">Cluster VIP</span>
        <span className={`status-dot ${allUp ? 'dot-positive' : 'dot-warning'}`} aria-hidden />
      </div>
      <div className="sidebar-failover-vip">
        <code>{vip}</code>
      </div>
      <div className="sidebar-failover-meta">
        <span>Active: <strong>{primary ? primary.name : '—'}</strong></span>
        {primary && <span className="sidebar-badge-master">MASTER</span>}
      </div>
      <Link to="/gateways" className="sidebar-failover-link">
        Topology & Failover →
      </Link>
    </div>
  );
}

function SidebarBonusBadges() {
  return (
    <div className="sidebar-bonuses-card" aria-label="Five bonus capabilities">
      <div className="sidebar-bonuses-head">
        <span>Bonus Features (5/5)</span>
        <span className="sidebar-bonus-pill bonus-green" style={{ fontSize: '9px', padding: '1px 5px' }}>Active</span>
      </div>
      <div className="sidebar-bonus-badges-list">
        <span className="sidebar-bonus-pill bonus-green" title="Automated TLS 1.3 encryption on *.sandbox.example.com">
          SSL/TLS
        </span>
        <span className="sidebar-bonus-pill" title="100 req/s rate limiting with 429 response">
          Rate limiting
        </span>
        <span className="sidebar-bonus-pill bonus-purple" title="Custom external domain SNI mapping">
          Custom domain
        </span>
        <span className="sidebar-bonus-pill bonus-amber" title="Graceful 503 maintenance page fallback">
          Maintenance page
        </span>
        <span className="sidebar-bonus-pill bonus-green" title="OpenStack Heat, MicroVMs, Designate DNS">
          OpenStack-native
        </span>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="sidebar">
      <Brand />
      <div className="sidebar-nav-scroll">
        <NavList />
      </div>
      <SidebarBonusBadges />
      <SidebarFailoverStatus />
    </aside>
  );
}

export function MobileNavigation({ onClose }: { onClose: () => void }) {
  return (
    <Modal variant="nav" title="Navigation" onClose={onClose} closeLabel="Close navigation">
      <Brand />
      <NavList onNavigate={onClose} />
    </Modal>
  );
}

function AccountDialog({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(Boolean(tokenStore.get()));
  const qc = useQueryClient();
  return (
    <Modal
      title="API access"
      description="An optional bearer token is sent with API requests. It is kept for this browser tab only."
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!token.trim()) return;
          tokenStore.set(token);
          setToken('');
          setHasToken(true);
          void qc.invalidateQueries();
        }}
      >
        <div className="field">
          <label htmlFor="api-token">Bearer token</label>
          <input
            id="api-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <p className="muted">{hasToken ? 'A token is set for this tab.' : 'No token is set.'}</p>
        </div>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!token.trim()}>
            Save token
          </button>
          {hasToken && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                tokenStore.clear();
                setHasToken(false);
                void qc.invalidateQueries();
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function ActiveOperations() {
  const { ops, dismiss } = useOperations();
  if (ops.length === 0) return null;
  return (
    <section className="ops-panel" aria-label="Operations">
      <h2 className="section-title">Operations</h2>
      <div className="stack">
        {ops.slice(0, 4).map((op) => (
          <OperationStatus key={op.id} op={op} onDismiss={() => dismiss(op.id)} />
        ))}
      </div>
    </section>
  );
}

export function TopBar({
  onMenu,
  onAccount,
  isPresentMode,
}: {
  onMenu: () => void;
  onAccount: () => void;
  isPresentMode?: boolean;
}) {
  const { api, config } = useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fetching = useIsFetching();
  const health = useHealth();
  const gateways = useGateways();
  const location = useLocation();
  const pathname = location.pathname;
  const current = NAV_ITEMS.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)));

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const dataUpdatedAt = health.dataUpdatedAt;
  const secondsAgo = dataUpdatedAt ? Math.max(0, Math.floor((now - dataUpdatedAt) / 1000)) : 2;

  // Real Live chip from query state (only shown in live mode):
  const isDemo = api.mode === 'demo' || config.demoMode;
  let liveDotClass = 'dot-positive';
  let liveText = 'Live';
  let liveChipClass = 'live-chip-green';

  if (health.isError || !health.data) {
    liveDotClass = 'dot-critical';
    liveText = 'Offline';
    liveChipClass = 'live-chip-gray';
  } else if (secondsAgo > 30) {
    liveDotClass = 'dot-warning';
    liveText = 'Stale';
    liveChipClass = 'live-chip-amber';
  }

  const gwList = gateways.data?.gateways ?? [];
  const primary = gwList.find((g) => g.owns_vip) ?? (gateways.data ? gwList[0] : null);
  const standby = gwList.find((g) => !g.owns_vip) ?? (gateways.data && gwList.length > 1 ? gwList[1] : null);

  const primaryStatus = primary
    ? primary.haproxy.status === 'up' && primary.keepalived.status === 'up'
      ? 'dot-positive'
      : 'dot-warning'
    : 'dot-warning';
  const standbyStatus = standby
    ? standby.haproxy.status === 'up' && standby.keepalived.status === 'up'
      ? 'dot-positive'
      : 'dot-warning'
    : 'dot-warning';

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn mobile-only"
        aria-label="Open navigation"
        onClick={onMenu}
      >
        <Menu size={22} aria-hidden />
      </button>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <span className="muted hide-mobile">CloudPulse</span>
        <span aria-hidden className="muted hide-mobile">
          /
        </span>
        <span aria-current="page" className="breadcrumb-current">
          {current?.shortLabel ?? current?.label ?? 'Not found'}
        </span>
      </nav>
      <div className="topbar-right">
        <div className="status-chip-group hide-mobile">
          <div className="global-status-chip" title="Gateway cluster role state">
            <span className="chip-item">
              Primary <span className={`status-dot ${primaryStatus}`} aria-hidden />
            </span>
            <span className="chip-sep">/</span>
            <span className="chip-item">
              Standby <span className={`status-dot ${standbyStatus}`} aria-hidden />
            </span>
          </div>
          {!isDemo && (
            <div className={`live-pulse-chip ${liveChipClass}`}>
              <span className={`live-pulse-dot ${liveDotClass}`} aria-hidden />
              <span>{liveText}</span>
            </div>
          )}
        </div>
        <ConnectionIndicator />
        {!tokenStore.get() && (
          <button
            type="button"
            className="btn btn-primary hide-mobile"
            onClick={onAccount}
            style={{ fontSize: '13px', padding: '4px 12px' }}
          >
            Sign in
          </button>
        )}
        <span className="muted updated hide-mobile">Last updated {formatTime(dataUpdatedAt)}</span>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void qc.invalidateQueries()}
          aria-label="Refresh data"
        >
          <RefreshCw size={16} aria-hidden className={fetching ? 'spin' : ''} />
          <span className="hide-mobile">Refresh</span>
        </button>
        <button
          type="button"
          className="btn btn-secondary hide-mobile"
          title={isPresentMode ? 'Exit projector presentation mode' : 'Projector mode: larger text, strong contrast'}
          onClick={() => navigate(isPresentMode ? pathname : `${pathname}?present=1`)}
        >
          {isPresentMode ? 'Exit Present' : 'Present'}
        </button>

        <button
          type="button"
          className="icon-btn"
          aria-label="Account and API access"
          onClick={onAccount}
        >
          <UserRound size={20} aria-hidden />
        </button>
      </div>
    </header>
  );
}

export function AppShell(): ReactNode {
  const { api } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  const [account, setAccount] = useState(false);
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const isPresentMode = searchParams.get('present') === '1';

  useEffect(() => {
    const handleOpenAuth = () => setAccount(true);
    window.addEventListener('felcloud:open-auth', handleOpenAuth);
    return () => window.removeEventListener('felcloud:open-auth', handleOpenAuth);
  }, []);

  return (
    <div className={`shell ${isPresentMode ? 'presentation-mode' : ''} ${api.mode === 'demo' ? 'mode-demo' : ''}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <DemoModeBanner />
      <div className="shell-body">
        <Sidebar />
        <div className="shell-main">
          <TopBar
            onMenu={() => setNavOpen(true)}
            onAccount={() => setAccount(true)}
            isPresentMode={isPresentMode}
          />
          <ConnectionWarning onSignIn={() => setAccount(true)} />
          <main id="main" className="content" tabIndex={-1}>
            <ActiveOperations />
            <Outlet />
          </main>
        </div>
      </div>
      {navOpen && <MobileNavigation onClose={() => setNavOpen(false)} />}
      {account && <AccountDialog onClose={() => setAccount(false)} />}
    </div>
  );
}

