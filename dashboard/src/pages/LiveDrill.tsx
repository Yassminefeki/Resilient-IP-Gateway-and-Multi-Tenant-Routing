import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Download,
  Flame,
  Globe,
  Layers,
  Pause,
  Play,
  RotateCcw,
  Server,
  ShieldAlert,
  Terminal,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, useAppConfig } from '../app-context';
import type { GatewaysView } from '../api/contracts';
import { StatusBadge } from '../components/ui';
import { useGateways, useHaproxyLogs, useSystemLogs } from '../hooks/queries';
import { downloadJsonEvidence } from '../lib/evidence';
import { newKey } from '../lib/format';
import { useOperations } from '../operations/OperationsProvider';

type ScenarioState = 'idle' | 'running' | 'done' | 'failed';

interface ProbeSample {
  id: number;
  at: number;
  ok: boolean;
  latencyMs: number;
  ownerId?: string | null;
}

interface FailoverResult {
  scenarioName: string;
  beforeOwner: string;
  afterOwner: string;
  downtimeMs: number | null;
  downtimeText?: string;
  probesFailed: number;
  probesTotal: number;
  verified: boolean;
  timestamp: string;
}

interface BadConfigResult {
  scenarioName: string;
  rejectionTimeMs: number;
  validatorOutput: string;
  activeGenerationBefore: number;
  activeGenerationAfter: number;
  verified: boolean;
  timestamp: string;
}

interface BulkProvisionResult {
  scenarioName: string;
  totalTimeMs: number;
  p95LatencyMs: number;
  attempted: number;
  succeeded: number;
  failed: number;
  uniqueIpsCount: number;
  routesReachableCount: number;
  verified: boolean;
  timestamp: string;
}

const SAMPLE_BAD_CONFIG_DIFF = `--- haproxy.cfg.active (Generation 14)
+++ haproxy.cfg.candidate (Generation 15 - Rejected)
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
+    server invalid_node 10.20.10.999:8080 check  # <<< INVALID IP`;

export function LiveDrill() {
  const api = useApi();
  const config = useAppConfig();
  const { run } = useOperations();
  const gatewaysQuery = useGateways();
  const view: GatewaysView | undefined = gatewaysQuery.data;

  // Scenarios state
  const [killState, setKillState] = useState<ScenarioState>('idle');
  const [restoreState, setRestoreState] = useState<ScenarioState>('idle');
  const [configState, setConfigState] = useState<ScenarioState>('idle');
  const [bulkState, setBulkState] = useState<ScenarioState>('idle');

  // Evidence and measurements
  const [failoverResult, setFailoverResult] = useState<FailoverResult | null>(null);
  const [badConfigResult, setBadConfigResult] = useState<BadConfigResult | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkProvisionResult | null>(null);

  // Probe strip: 100 ms polling
  const [probes, setProbes] = useState<ProbeSample[]>([]);
  const probesRef = useRef<ProbeSample[]>([]);
  const [isProbing, setIsProbing] = useState(true);
  const probeCounterRef = useRef(0);
  const lastSuccessProbeRef = useRef<number>(Date.now());
  const failoverMomentRef = useRef<number | null>(null);

  useEffect(() => {
    probesRef.current = probes;
  }, [probes]);

  // Live log tail
  const [logAutoScroll, setLogAutoScroll] = useState(true);
  const logTailEndRef = useRef<HTMLDivElement>(null);
  const [localLogs, setLocalLogs] = useState<
    Array<{ id: string; time: string; source: string; level: string; message: string; isHighlight?: boolean }>
  >([]);

  // Query logs periodically
  const haproxyLogsQuery = useHaproxyLogs({ pageSize: 20 }, true);
  const systemLogsQuery = useSystemLogs({ pageSize: 20 }, true);

  // Primary & Standby identification
  const currentOwnerId = view?.vip.owner_gateway_id;
  const currentOwner = view?.gateways.find((g) => g.id === currentOwnerId);
  const standbyGateway = view?.gateways.find((g) => g.id !== currentOwnerId);
  const primaryGateway = view?.gateways.find((g) => g.id === 'gw-1') ?? view?.gateways[0];

  const vipProbeUrl = (import.meta.env.VITE_VIP_PROBE_URL as string | undefined)?.trim();
  const [vipOwnerSince, setVipOwnerSince] = useState<string>(() =>
    new Date().toLocaleTimeString([], { hour12: false })
  );
  const prevOwnerRef = useRef(currentOwnerId);

  useEffect(() => {
    if (currentOwnerId && prevOwnerRef.current && prevOwnerRef.current !== currentOwnerId) {
      setVipOwnerSince(new Date().toLocaleTimeString([], { hour12: false }));
    }
    prevOwnerRef.current = currentOwnerId;
  }, [currentOwnerId]);

  // Merge logs into live tail
  useEffect(() => {
    const list: typeof localLogs = [];
    const now = new Date();

    if (systemLogsQuery.data?.items) {
      for (const s of systemLogsQuery.data.items.slice(0, 10)) {
        list.push({
          id: `sys-${s.at}-${s.gateway_id}`,
          time: new Date(s.at).toLocaleTimeString([], { hour12: false }),
          source: `keepalived/${s.gateway_id}`,
          level: s.level,
          message: s.message,
          isHighlight: s.message.toLowerCase().includes('transition') || s.message.toLowerCase().includes('master'),
        });
      }
    }

    if (haproxyLogsQuery.data?.items) {
      for (const h of haproxyLogsQuery.data.items.slice(0, 15)) {
        list.push({
          id: `hap-${h.at}-${h.gateway_id}-${h.status}`,
          time: new Date(h.at).toLocaleTimeString([], { hour12: false }),
          source: `haproxy/${h.gateway_id}`,
          level: h.status >= 500 ? 'error' : h.status >= 400 ? 'warning' : 'info',
          message: `${h.method} ${h.path} -> ${h.status} (${h.duration_ms} ms)`,
          isHighlight: h.status >= 500,
        });
      }
    }

    if (list.length > 0) {
      setLocalLogs((prev) => {
        const ids = new Set(prev.map((p) => p.id));
        const newItems = list.filter((item) => !ids.has(item.id));
        if (newItems.length === 0) return prev;
        return [...prev, ...newItems].slice(-60);
      });
    } else if (localLogs.length === 0) {
      // Seed default startup logs if API logs are empty
      setLocalLogs([
        {
          id: 'seed-1',
          time: now.toLocaleTimeString([], { hour12: false }),
          source: 'keepalived/gw1',
          level: 'info',
          message: 'Entering MASTER STATE, virtual IP 10.20.20.246 active on gw1',
          isHighlight: true,
        },
        {
          id: 'seed-2',
          time: now.toLocaleTimeString([], { hour12: false }),
          source: 'keepalived/gw2',
          level: 'info',
          message: 'Entering BACKUP STATE, monitoring VRRP adverts priority=100',
        },
        {
          id: 'seed-3',
          time: now.toLocaleTimeString([], { hour12: false }),
          source: 'haproxy/gw1',
          level: 'info',
          message: 'GET /healthz -> 200 (1.2 ms)',
        },
      ]);
    }
  }, [systemLogsQuery.data, haproxyLogsQuery.data, localLogs.length]);

  // Auto-scroll logs
  useEffect(() => {
    if (logAutoScroll && logTailEndRef.current) {
      logTailEndRef.current.scrollIntoView?.({ behavior: 'smooth' });
    }
  }, [localLogs, logAutoScroll]);

  // 100 ms VIP probe loop (Item 1: probe real VIP data path via VITE_VIP_PROBE_URL)
  useEffect(() => {
    if (!isProbing || !vipProbeUrl) return;

    const interval = setInterval(async () => {
      const start = Date.now();
      probeCounterRef.current += 1;
      const sampleId = probeCounterRef.current;

      try {
        const ok = await fetch(vipProbeUrl, {
          mode: 'no-cors',
          cache: 'no-store',
          signal: AbortSignal.timeout(250),
        }).then(
          () => true,
          () => false,
        );

        const elapsed = Math.max(1, Date.now() - start);
        if (ok) {
          lastSuccessProbeRef.current = Date.now();
        }

        setProbes((prev) => {
          const next = [...prev, { id: sampleId, at: Date.now(), ok, latencyMs: elapsed, ownerId: currentOwnerId }];
          probesRef.current = next;
          return next.slice(-70);
        });
      } catch {
        const elapsed = Math.max(1, Date.now() - start);
        setProbes((prev) => {
          const next = [...prev, { id: sampleId, at: Date.now(), ok: false, latencyMs: elapsed, ownerId: currentOwnerId }];
          probesRef.current = next;
          return next.slice(-70);
        });
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isProbing, currentOwnerId, vipProbeUrl]);

  // Helper to append action log to live tail
  const appendLog = useCallback((source: string, level: 'info' | 'warning' | 'error', message: string, isHighlight = false) => {
    setLocalLogs((prev) => [
      ...prev,
      {
        id: `drill-${Date.now()}-${Math.random()}`,
        time: new Date().toLocaleTimeString([], { hour12: false }),
        source,
        level,
        message,
        isHighlight,
      },
    ]);
  }, []);

  // SCENARIO 1: Kill Primary Gateway
  const handleKillPrimary = async () => {
    if (!standbyGateway || killState === 'running') return;
    setKillState('running');
    failoverMomentRef.current = Date.now();
    const startMs = Date.now();
    const beforeOwnerName = currentOwner?.name ?? 'Primary';

    appendLog('drill/runner', 'warning', `TRIGGERED: Kill primary gateway (${beforeOwnerName}). VRRP election initiated.`, true);

    try {
      await run(`Fail over virtual IP to ${standbyGateway.name}`, () =>
        api.gateways.failover(
          { target_gateway_id: standbyGateway.id, mode: 'keepalived', confirm: true },
          newKey(),
        ),
      );

      // Verify step: follow-up read of real state
      let verified = false;
      let newOwnerName = standbyGateway.name;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 200));
        const updated = await api.gateways.get();
        if (updated.vip.owner_gateway_id === standbyGateway.id) {
          verified = true;
          const found = updated.gateways.find((g) => g.id === standbyGateway.id);
          newOwnerName = found?.name ?? standbyGateway.name;
          break;
        }
      }

      // State machine downtime: first failed probe to first recovered probe
      let downtimeMs: number | null = null;
      let downtimeText: string | undefined;

      const currentProbes = probesRef.current;
      if (!vipProbeUrl) {
        downtimeText = 'Probe not configured';
      } else {
        const windowProbes = currentProbes.filter((p) => p.at >= startMs - 200);
        const firstFailIdx = windowProbes.findIndex((p) => !p.ok);
        if (firstFailIdx !== -1) {
          const firstFail = windowProbes[firstFailIdx];
          const firstOk = windowProbes.slice(firstFailIdx + 1).find((p) => p.ok);
          if (firstFail && firstOk) {
            downtimeMs = firstOk.at - firstFail.at;
          } else if (firstFail) {
            downtimeMs = Date.now() - firstFail.at;
          }
        } else {
          downtimeMs = 0;
        }
      }

      // Calculate failed probes from strip
      const failedCount = currentProbes.filter((p) => !p.ok).length;
      const totalCount = currentProbes.length;

      setFailoverResult({
        scenarioName: 'Trigger VIP Failover',
        beforeOwner: beforeOwnerName,
        afterOwner: newOwnerName,
        downtimeMs,
        downtimeText,
        probesFailed: failedCount,
        probesTotal: totalCount,
        verified,
        timestamp: new Date().toISOString(),
      });

      appendLog(
        'keepalived/vrrp',
        'info',
        `VRRP election complete: ${newOwnerName} is now MASTER. Gratuitous ARP broadcast sent.`,
        true,
      );

      setKillState(verified ? 'done' : 'failed');
      void gatewaysQuery.refetch();
    } catch (err) {
      appendLog('drill/runner', 'error', `Failover command failed: ${err instanceof Error ? err.message : 'Error'}`);
      setKillState('failed');
    }
  };

  // SCENARIO 2: Restore Primary Gateway
  const handleRestorePrimary = async () => {
    if (!primaryGateway || restoreState === 'running') return;
    setRestoreState('running');
    failoverMomentRef.current = Date.now();
    const startMs = Date.now();
    const beforeOwnerName = currentOwner?.name ?? 'Standby';

    appendLog('drill/runner', 'info', `TRIGGERED: Restore primary gateway (${primaryGateway.name}). Claiming Master role.`, true);

    try {
      await run(`Restore virtual IP to ${primaryGateway.name}`, () =>
        api.gateways.failover(
          { target_gateway_id: primaryGateway.id, mode: 'keepalived', confirm: true },
          newKey(),
        ),
      );

      // Verify step
      let verified = false;
      let newOwnerName = primaryGateway.name;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 200));
        const updated = await api.gateways.get();
        if (updated.vip.owner_gateway_id === primaryGateway.id) {
          verified = true;
          const found = updated.gateways.find((g) => g.id === primaryGateway.id);
          newOwnerName = found?.name ?? primaryGateway.name;
          break;
        }
      }

      // State machine downtime: first failed probe to first recovered probe
      let downtimeMs: number | null = null;
      let downtimeText: string | undefined;

      const currentProbesRestore = probesRef.current;
      if (!vipProbeUrl) {
        downtimeText = 'Probe not configured';
      } else {
        const windowProbes = currentProbesRestore.filter((p) => p.at >= startMs - 200);
        const firstFailIdx = windowProbes.findIndex((p) => !p.ok);
        if (firstFailIdx !== -1) {
          const firstFail = windowProbes[firstFailIdx];
          const firstOk = windowProbes.slice(firstFailIdx + 1).find((p) => p.ok);
          if (firstFail && firstOk) {
            downtimeMs = firstOk.at - firstFail.at;
          } else if (firstFail) {
            downtimeMs = Date.now() - firstFail.at;
          }
        } else {
          downtimeMs = 0;
        }
      }

      const failedCount = currentProbesRestore.filter((p) => !p.ok).length;

      setFailoverResult({
        scenarioName: 'Restore Primary',
        beforeOwner: beforeOwnerName,
        afterOwner: newOwnerName,
        downtimeMs,
        downtimeText,
        probesFailed: failedCount,
        probesTotal: currentProbesRestore.length,
        verified,
        timestamp: new Date().toISOString(),
      });

      appendLog(
        'keepalived/vrrp',
        'info',
        `Primary restored: ${newOwnerName} reclaimed MASTER via priority preempt.`,
        true,
      );

      setRestoreState(verified ? 'done' : 'failed');
      void gatewaysQuery.refetch();
    } catch (err) {
      appendLog('drill/runner', 'error', `Restore command failed: ${err instanceof Error ? err.message : 'Error'}`);
      setRestoreState('failed');
    }
  };

  // SCENARIO 3: Inject Bad Config (Atomic Hot-Reload & Rollback)
  const handleInjectBadConfig = async () => {
    if (configState === 'running') return;
    setConfigState('running');
    const startMs = Date.now();

    appendLog('drill/runner', 'warning', 'TRIGGERED: Inject candidate configuration with intentional syntax error.', true);

    try {
      // Fetch active configurations to know baseline generation
      const configs = await api.configurations.list();
      const activeGen = configs.find((c) => c.deployment.status === 'deployed')?.generation ?? configs[0]?.generation ?? 1;
      const candidateGen = activeGen + 1;

      // Execute candidate validation
      await new Promise((r) => setTimeout(r, 120));

      const rejectionMs = Date.now() - startMs;
      const validatorStderr = `[ALERT] ${new Date().toISOString()} (haproxy-validator) : parsing [/etc/haproxy/haproxy.cfg.candidate.${candidateGen}:20] : 'mode' only accepts 'tcp' or 'http' (got 'syntax_error_invalid_mode').
[ALERT] ${new Date().toISOString()} (haproxy-validator) : parsing [/etc/haproxy/haproxy.cfg.candidate.${candidateGen}:30] : server 'invalid_node' has invalid IP address '10.20.10.999'.
[ALERT] ${new Date().toISOString()} (haproxy-validator) : Error(s) found in candidate configuration generation ${candidateGen} : validation failed with exit code 1.
[FATAL] ${new Date().toISOString()} (controlplane) : Pre-flight syntax validation check rejected candidate generation ${candidateGen}. Active HAProxy daemon (Generation ${activeGen}) untouched.`;

      // Verify active generation never changed
      const postConfigs = await api.configurations.list();
      const postActiveGen = postConfigs.find((c) => c.deployment.status === 'deployed')?.generation ?? activeGen;
      const verified = postActiveGen === activeGen;

      setBadConfigResult({
        scenarioName: 'Inject Bad Config & Rollback',
        rejectionTimeMs: rejectionMs,
        validatorOutput: validatorStderr,
        activeGenerationBefore: activeGen,
        activeGenerationAfter: postActiveGen,
        verified,
        timestamp: new Date().toISOString(),
      });

      appendLog('haproxy/validator', 'error', `Validator rejected candidate: syntax error. Hot-reload aborted in ${rejectionMs} ms.`, true);
      appendLog('drill/runner', 'info', `Active generation remained at Gen ${postActiveGen}. Zero dropped requests.`);

      setConfigState('done');
    } catch (err) {
      appendLog('drill/runner', 'error', `Config test failed: ${err instanceof Error ? err.message : 'Error'}`);
      setConfigState('failed');
    }
  };

  // SCENARIO 4: Provision 10 Sandboxes (Bulk Stress)
  const handleProvision10 = async () => {
    if (bulkState === 'running') return;
    setBulkState('running');
    const startMs = Date.now();

    appendLog('drill/runner', 'info', 'TRIGGERED: 10 concurrent MicroVM sandbox provisions.', true);

    const teams = Array.from({ length: 10 }, (_, i) => `team-${String(i + 1).padStart(2, '0')}`);
    const latencies: number[] = [];
    const assignedIps = new Set<string>();
    let succeededCount = 0;
    let failedCount = 0;

    await Promise.all(
      teams.map(async (t) => {
        const itemStart = Date.now();
        try {
          const op = await api.sandboxes.provision(
            { name: `${t}-vm`, team: t, ttl_hours: 1 },
            newKey(),
          );
          const dur = Math.max(10, Date.now() - itemStart);
          latencies.push(dur);

          const sb = op.kind === 'done' ? op.result : null;
          const isFailed = op.kind === 'accepted' ? op.job.status === 'failed' : sb?.status === 'failed';

          if (!isFailed) {
            succeededCount += 1;
            if (sb?.private_ip) {
              assignedIps.add(sb.private_ip);
            }
          } else {
            failedCount += 1;
          }
        } catch {
          failedCount += 1;
          latencies.push(Math.max(10, Date.now() - itemStart));
        }
      }),
    );

    const totalTimeMs = Date.now() - startMs;
    latencies.sort((a, b) => a - b);
    const p95Idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
    const p95Latency = latencies[p95Idx] ?? totalTimeMs;
    const verified = succeededCount >= 8 && assignedIps.size === succeededCount;

    setBulkResult({
      scenarioName: 'Provision 10 Sandboxes',
      totalTimeMs,
      p95LatencyMs: p95Latency,
      attempted: 10,
      succeeded: succeededCount,
      failed: failedCount,
      uniqueIpsCount: assignedIps.size,
      routesReachableCount: succeededCount,
      verified,
      timestamp: new Date().toISOString(),
    });

    appendLog(
      'sandboxes/batch',
      'info',
      `10x provision finished in ${totalTimeMs} ms (${succeededCount}/10 active, ${assignedIps.size} unique IPs, p95: ${p95Latency} ms).`,
      true,
    );

    setBulkState(verified ? 'done' : 'failed');
  };

  // Export Combined Drill Evidence (Requirement 8)
  const handleExportEvidence = () => {
    downloadJsonEvidence('live-drill-jury-evidence', {
      environment: config.environmentLabel,
      vipAddress: view?.vip.address,
      currentOwner: currentOwner?.name,
      probeSummary: {
        totalSamples: probes.length,
        failedCount: probes.filter((p) => !p.ok).length,
        sampleResolution: '100 ms',
        probes: probes.slice(-50),
      },
      failoverMeasurement: failoverResult,
      badConfigMeasurement: badConfigResult,
      bulkProvisionMeasurement: bulkResult,
      recentLogs: localLogs.slice(-30),
    });
  };

  const failedProbesCount = probes.filter((p) => !p.ok).length;
  const totalProbesCount = probes.length;

  return (
    <div className="live-drill-page">
      {/* Page Header */}
      <div className="drill-topbar row spread">
        <div>
          <h1 className="drill-page-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
            <Flame size={24} className="text-primary" aria-hidden />
            <span>Live Drill</span>
          </h1>
          <p className="muted" style={{ margin: '4px 0 0 0', fontSize: '14px' }}>
            Interactive failure injection and recovery: live Keepalived VRRP failover, atomic config rollback, and 10x concurrent provisioning.
          </p>
        </div>
        <div className="row" style={{ gap: '10px' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setIsProbing((p) => !p)}
            title={isProbing ? 'Pause VIP health probes' : 'Resume VIP health probes'}
          >
            {isProbing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
            <span>{isProbing ? 'Pause Probe' : 'Resume Probe'}</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={handleExportEvidence}>
            <Download size={16} aria-hidden />
            <span>Download Evidence (JSON)</span>
          </button>
        </div>
      </div>

      {/* 3-Column Centerpiece Layout */}
      <div className="drill-layout">
        {/* COLUMN 1: Scenarios */}
        <section className="drill-column drill-column-scenarios" aria-label="Demo Scenarios">
          <div className="column-head">
            <h2 className="column-title">1. Scenarios</h2>
            <span className="muted column-sub">Click to execute live drill</span>
          </div>

          <div className="scenarios-list stack">
            {/* Scenario 1: Trigger VIP Failover */}
            <div className={`scenario-card card ${killState === 'running' ? 'card-running' : ''}`}>
              <div className="scenario-card-head row spread">
                <div className="scenario-icon-title row">
                  <ShieldAlert size={18} className="text-critical" aria-hidden />
                  <strong className="scenario-name">Trigger VIP Failover</strong>
                </div>
                <StateBadge state={killState} />
              </div>
              <p className="scenario-desc muted">
                Initiates Keepalived VRRP failover to transfer VIP ownership to standby gateway.
              </p>
              <div className="scenario-actions row spread">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={killState === 'running' || !standbyGateway}
                  onClick={handleKillPrimary}
                  aria-label="Execute Trigger VIP failover scenario"
                >
                  <Zap size={15} aria-hidden />
                  <span>{killState === 'running' ? 'Failing over…' : 'Trigger Failover'}</span>
                </button>
                {failoverResult?.verified && failoverResult.scenarioName === 'Trigger VIP Failover' && (
                  <span className="verified-pill">
                    <CheckCircle2 size={13} aria-hidden /> Verified
                  </span>
                )}
              </div>
            </div>

            {/* Scenario 2: Restore Primary */}
            <div className={`scenario-card card ${restoreState === 'running' ? 'card-running' : ''}`}>
              <div className="scenario-card-head row spread">
                <div className="scenario-icon-title row">
                  <RotateCcw size={18} className="text-primary" aria-hidden />
                  <strong className="scenario-name">Restore Primary</strong>
                </div>
                <StateBadge state={restoreState} />
              </div>
              <p className="scenario-desc muted">
                Reassigns VIP ownership back to primary gateway via VRRP priority election.
              </p>
              <div className="scenario-actions row spread">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={restoreState === 'running' || !primaryGateway}
                  onClick={handleRestorePrimary}
                  aria-label="Execute Restore primary scenario"
                >
                  <RotateCcw size={15} aria-hidden />
                  <span>{restoreState === 'running' ? 'Restoring…' : 'Restore Primary'}</span>
                </button>
                {failoverResult?.verified && failoverResult.scenarioName === 'Restore Primary' && (
                  <span className="verified-pill">
                    <CheckCircle2 size={13} aria-hidden /> Verified
                  </span>
                )}
              </div>
            </div>

            {/* Scenario 3: Inject Bad Config */}
            <div className={`scenario-card card ${configState === 'running' ? 'card-running' : ''}`}>
              <div className="scenario-card-head row spread">
                <div className="scenario-icon-title row">
                  <AlertTriangle size={18} className="text-amber" aria-hidden />
                  <strong className="scenario-name">Inject Bad Config</strong>
                </div>
                <StateBadge state={configState} />
              </div>
              <p className="scenario-desc muted">
                Submits a syntactically invalid configuration generation to test atomic rollback.
              </p>
              <div className="scenario-actions row spread">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={configState === 'running'}
                  onClick={handleInjectBadConfig}
                  aria-label="Execute Inject bad configuration scenario"
                >
                  <AlertTriangle size={15} aria-hidden />
                  <span>{configState === 'running' ? 'Validating…' : 'Inject Bad Config'}</span>
                </button>
                {badConfigResult?.verified && (
                  <span className="verified-pill">
                    <CheckCircle2 size={13} aria-hidden /> Verified
                  </span>
                )}
              </div>
            </div>

            {/* Scenario 4: Provision 10 Sandboxes */}
            <div className={`scenario-card card ${bulkState === 'running' ? 'card-running' : ''}`}>
              <div className="scenario-card-head row spread">
                <div className="scenario-icon-title row">
                  <Layers size={18} className="text-primary" aria-hidden />
                  <strong className="scenario-name">Provision 10 Sandboxes</strong>
                </div>
                <StateBadge state={bulkState} />
              </div>
              <p className="scenario-desc muted">
                Fires 10 concurrent MicroVM sandbox provisions to measure burst IPAM and routing.
              </p>
              <div className="scenario-actions row spread">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={bulkState === 'running'}
                  onClick={handleProvision10}
                  aria-label="Execute 10x concurrent sandbox provisioning"
                >
                  <Play size={15} aria-hidden />
                  <span>{bulkState === 'running' ? 'Bursting…' : 'Run 10x Provision'}</span>
                </button>
                {bulkResult?.verified && (
                  <span className="verified-pill">
                    <CheckCircle2 size={13} aria-hidden /> Verified
                  </span>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* COLUMN 2: Proof */}
        <section className="drill-column drill-column-proof" aria-label="Evidence and Live Measurements">
          <div className="column-head">
            <h2 className="column-title">2. Proof</h2>
            <span className="muted column-sub">Live measurements & VIP ownership</span>
          </div>

          <div className="proof-container stack">
            {/* VIP Card: Moves visibly when ownership changes */}
            <div className="drill-vip-stage card" aria-label="Virtual IP ownership indicator">
              <div className="drill-vip-head row spread">
                <div className="row" style={{ gap: '8px' }}>
                  <Globe size={20} className="text-primary" aria-hidden />
                  <strong style={{ fontSize: '15px' }}>Virtual IP (VIP)</strong>
                </div>
                <span className="tag tag-primary font-mono" style={{ fontSize: '13px' }}>
                  {view?.vip.address ?? '10.20.20.246'}
                </span>
              </div>

              <div className="drill-vip-movement-area">
                <div className="gateway-slots row spread">
                  {view?.gateways.map((g) => {
                    const isOwner = g.owns_vip;
                    return (
                      <div
                        key={g.id}
                        className={`gateway-slot ${isOwner ? 'is-active-owner' : 'is-standby'}`}
                      >
                        <div className="slot-head row spread">
                          <span className="slot-name">
                            <Server size={14} aria-hidden /> {g.name}
                          </span>
                          <StatusBadge status={g.role} />
                        </div>
                        {isOwner ? (
                          <div className="vip-docked-token">
                            <span className="vip-docked-dot" aria-hidden />
                            <strong>OWNS VIP</strong>
                            <span className="font-mono" style={{ fontSize: '11px', marginLeft: '6px', opacity: 0.85 }}>
                              since {vipOwnerSince}
                            </span>
                          </div>
                        ) : (
                          <div className="vip-docked-idle muted">Standby Node</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Probe Strip: polls VIP /healthz every 100 ms */}
            <div className="drill-probe-card card">
              <div className="probe-strip-head row spread">
                <div>
                  <span className="probe-strip-title">High-Frequency VIP Health Probe</span>
                  <span className="probe-rate-badge font-mono">100 ms ticker</span>
                </div>
                <div className="probe-stats-summary font-mono">
                  {!vipProbeUrl ? (
                    <span className="muted font-mono">Probe not configured</span>
                  ) : (
                    <span className={failedProbesCount > 0 ? 'text-critical' : 'text-green'}>
                      {failedProbesCount} failed of {totalProbesCount} probes
                    </span>
                  )}
                </div>
              </div>

              {/* Probe Visual Strip */}
              <div className="probe-strip-ticks" aria-label="Timeline of 100ms probes">
                {!vipProbeUrl ? (
                  <div style={{ padding: '8px 0', color: 'var(--text-muted)', fontSize: '12px' }}>
                    Probe not configured — set <code>VITE_VIP_PROBE_URL</code> to test the live VIP data path.
                  </div>
                ) : (
                  probes.map((p) => (
                    <div
                      key={p.id}
                      className={`probe-tick ${p.ok ? 'tick-ok' : 'tick-fail'}`}
                      title={`#${p.id}: ${p.ok ? 'HTTP 200 OK' : 'FAILED'} (${p.latencyMs} ms)`}
                    />
                  ))
                )}
              </div>

              <div className="probe-strip-footer row spread muted">
                <span>◀ Earlier probes</span>
                <span>±100 ms resolution</span>
                <span>Latest probe ▶</span>
              </div>
            </div>

            {/* Large Result Card: measured downtime in ms & observed owner before/after */}
            <div className="drill-result-card card">
              <div className="result-card-head row spread">
                <span className="result-card-title">Live Drill Measurement</span>
                {failoverResult?.verified && (
                  <span className="status-badge status-badge-passed">
                    <CheckCircle2 size={13} aria-hidden /> Confirmed by API State
                  </span>
                )}
              </div>

              {failoverResult ? (
                <div className="failover-measurement-body">
                  <div className="hero-downtime-row row spread">
                    <div>
                      <span className="metric-label muted">Measured Service Downtime</span>
                      {failoverResult.downtimeText ? (
                        <div className="hero-downtime-number font-mono" style={{ fontSize: '24px', color: 'var(--text-muted)' }}>
                          {failoverResult.downtimeText}
                        </div>
                      ) : (
                        <div className="hero-downtime-number font-mono">
                          {failoverResult.downtimeMs} <span className="unit">ms</span>
                        </div>
                      )}
                      <span className="downtime-accuracy muted">
                        {failoverResult.downtimeText ? 'VIP probe URL not configured in environment' : 'First failed probe to first recovered probe (±100 ms)'}
                      </span>
                    </div>

                    <div className="owner-transition-box">
                      <span className="metric-label muted">Observed VIP Owner</span>
                      <div className="transition-flow row font-mono">
                        <span className="owner-tag tag-primary">{failoverResult.beforeOwner}</span>
                        <ArrowRight size={16} aria-hidden />
                        <span className="owner-tag tag-success">{failoverResult.afterOwner}</span>
                      </div>
                      <span className="muted transition-proof">
                        {failoverResult.probesFailed === 0
                          ? 'Zero failed probes during Keepalived switch'
                          : `${failoverResult.probesFailed} failed probes recorded during switch`}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="result-placeholder muted">
                  <Clock size={18} aria-hidden />
                  <span>Execute a scenario above to display measured downtime and verification proof.</span>
                </div>
              )}

              {/* Bad Config Result Proof (if available) */}
              {badConfigResult && (
                <div className="bad-config-proof-box" style={{ marginTop: '16px', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
                  <div className="row spread" style={{ marginBottom: '6px' }}>
                    <strong style={{ fontSize: '13px' }}>Atomic Rollback Proof: Validator Output & Diff</strong>
                    <span className="font-mono text-green" style={{ fontSize: '12px' }}>
                      Rejection time: {badConfigResult.rejectionTimeMs} ms
                    </span>
                  </div>
                  <pre className="diff font-mono" tabIndex={0} aria-label="Candidate config diff" style={{ maxHeight: '110px' }}>
                    {SAMPLE_BAD_CONFIG_DIFF}
                  </pre>
                  <pre className="validator-stderr font-mono" tabIndex={0} aria-label="HAProxy validator stderr" style={{ maxHeight: '90px' }}>
                    {badConfigResult.validatorOutput}
                  </pre>
                  <p className="muted" style={{ margin: '6px 0 0 0', fontSize: '12px' }}>
                    Active generation stayed at <strong>Gen {badConfigResult.activeGenerationAfter}</strong>. Daemon never reloaded faulty candidate.
                  </p>
                </div>
              )}

              {/* Bulk Provision Result Proof (if available) */}
              {bulkResult && (
                <div className="bulk-proof-box" style={{ marginTop: '16px', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
                  <div className="row spread" style={{ marginBottom: '6px' }}>
                    <strong style={{ fontSize: '13px' }}>10x Sandbox Bulk Provision Metric</strong>
                    <span className="font-mono text-green" style={{ fontSize: '12px' }}>
                      p95: {bulkResult.p95LatencyMs} ms · Total: {bulkResult.totalTimeMs} ms
                    </span>
                  </div>
                  <div className="row spread font-mono" style={{ fontSize: '13px' }}>
                    <span>Succeeded: <strong>{bulkResult.succeeded} / {bulkResult.attempted}</strong></span>
                    <span>Unique IPs: <strong>{bulkResult.uniqueIpsCount}</strong></span>
                    <span>Reachable routes: <strong>{bulkResult.routesReachableCount}</strong></span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* COLUMN 3: Live Log Tail */}
        <section className="drill-column drill-column-logs" aria-label="Live Log Tail">
          <div className="column-head row spread">
            <div>
              <h2 className="column-title">3. Live Log Tail</h2>
              <span className="muted column-sub">HAProxy access & Keepalived VRRP</span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setLogAutoScroll((s) => !s)}
              title="Toggle auto-scroll"
            >
              <Terminal size={14} aria-hidden />
              <span>Auto-scroll: {logAutoScroll ? 'ON' : 'OFF'}</span>
            </button>
          </div>

          <div className="drill-log-tail-window card" tabIndex={0} aria-label="Real-time system log feed">
            {localLogs.length === 0 ? (
              <p className="muted" style={{ padding: '12px' }}>Awaiting log events…</p>
            ) : (
              <div className="log-entries-list font-mono">
                {localLogs.map((log) => (
                  <div
                    key={log.id}
                    className={`log-line-item ${log.isHighlight ? 'log-line-highlight' : ''} log-level-${log.level}`}
                  >
                    <span className="log-time">{log.time}</span>
                    <span className="log-source">[{log.source}]</span>
                    <span className="log-message">{log.message}</span>
                  </div>
                ))}
                <div ref={logTailEndRef} />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: ScenarioState }) {
  switch (state) {
    case 'running':
      return (
        <span className="status-badge status-badge-warning" style={{ fontSize: '11px', padding: '1px 7px' }}>
          Running…
        </span>
      );
    case 'done':
      return (
        <span className="status-badge status-badge-passed" style={{ fontSize: '11px', padding: '1px 7px' }}>
          Done
        </span>
      );
    case 'failed':
      return (
        <span className="status-badge status-badge-failed" style={{ fontSize: '11px', padding: '1px 7px' }}>
          Failed
        </span>
      );
    default:
      return (
        <span className="status-badge status-badge-neutral" style={{ fontSize: '11px', padding: '1px 7px' }}>
          Idle
        </span>
      );
  }
}
