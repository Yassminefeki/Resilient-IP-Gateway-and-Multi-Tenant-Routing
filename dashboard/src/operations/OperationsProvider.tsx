import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApi } from '../app-context';
import { isApiError } from '../api/errors';
import { isTerminal, type Job, type Operation } from '../api/contracts';
import { useToast } from '../components/Toast';

export type OpState = 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown';
export interface Verification {
  status: 'pending' | 'verified' | 'unverified' | 'skipped';
  detail: string;
}
export interface TrackedOp {
  id: string;
  label: string;
  jobId?: string;
  startedAt: string;
  state: OpState;
  message?: string;
  simulated: boolean;
  steps?: Job['steps'];
  verification?: Verification;
}
export interface VerifyResult {
  ok: boolean;
  detail: string;
}
export interface RunOptions {
  /** Re-reads authoritative state after the job succeeds. Success is only shown as verified if ok. */
  verify?: () => Promise<VerifyResult>;
}

interface OperationsContextValue {
  ops: TrackedOp[];
  /** Starts an operation. Rejects (with ApiError) if the request itself fails; nothing is tracked then. */
  run: <T>(
    label: string,
    start: () => Promise<Operation<T>>,
    options?: RunOptions,
  ) => Promise<void>;
  dismiss: (id: string) => void;
}

const OperationsContext = createContext<OperationsContextValue | null>(null);
const STORAGE_KEY = 'felcloud.operations';

function load(): TrackedOp[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '[]') as TrackedOp[];
    return parsed.map((op) =>
      op.state === 'succeeded' || op.state === 'failed'
        ? {
            ...op,
            verification:
              op.verification?.status === 'pending'
                ? { status: 'skipped', detail: 'Not re-checked after the page was reloaded.' }
                : op.verification,
          }
        : op,
    );
  } catch {
    return [];
  }
}

export function OperationsProvider({
  children,
  pollMs = 1500,
}: {
  children: ReactNode;
  pollMs?: number;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [ops, setOps] = useState<TrackedOp[]>(load);
  const verifiers = useRef(new Map<string, () => Promise<VerifyResult>>());
  const settled = useRef(new Set<string>());

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ops.slice(0, 8)));
    } catch {
      /* ignore */
    }
  }, [ops]);

  const patch = useCallback((id: string, changes: Partial<TrackedOp>) => {
    setOps((cur) => cur.map((o) => (o.id === id ? { ...o, ...changes } : o)));
  }, []);

  const finish = useCallback(
    async (
      op: TrackedOp,
      state: 'succeeded' | 'failed',
      message: string | undefined,
      steps?: Job['steps'],
    ) => {
      if (settled.current.has(op.id)) return;
      settled.current.add(op.id);
      const prefix = op.simulated ? 'Simulated: ' : '';
      if (state === 'failed') {
        patch(op.id, { state, message, steps });
        toast(`${prefix}${op.label} failed${message ? `: ${message}` : '.'}`, 'critical');
        await qc.invalidateQueries();
        return;
      }
      const verify = verifiers.current.get(op.id);
      patch(op.id, {
        state,
        message,
        steps,
        verification: verify
          ? { status: 'pending', detail: 'Job finished. Verifying the resulting state…' }
          : undefined,
      });
      await qc.invalidateQueries();
      if (!verify) {
        toast(`${prefix}${op.label} completed.`, 'positive');
        return;
      }
      try {
        const result = await verify();
        patch(op.id, {
          verification: { status: result.ok ? 'verified' : 'unverified', detail: result.detail },
        });
        toast(
          result.ok
            ? `${prefix}${op.label} verified.`
            : `${prefix}${op.label}: the job finished but the result could not be verified.`,
          result.ok ? 'positive' : 'warning',
        );
      } catch {
        patch(op.id, {
          verification: {
            status: 'unverified',
            detail: 'Verification could not be completed because the API did not answer.',
          },
        });
        toast(`${prefix}${op.label}: could not verify the result.`, 'warning');
      } finally {
        verifiers.current.delete(op.id);
      }
    },
    [patch, qc, toast],
  );

  const run = useCallback<OperationsContextValue['run']>(
    async (label, start, options) => {
      const started = await start();
      const id = `op-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const simulated = api.mode === 'demo' || started.simulated === true;
      const base: TrackedOp = {
        id,
        label,
        startedAt: new Date().toISOString(),
        state: 'accepted',
        simulated,
      };
      if (options?.verify) verifiers.current.set(id, options.verify);
      if (started.kind === 'accepted') {
        setOps((cur) => [
          {
            ...base,
            jobId: started.job.id,
            steps: started.job.steps,
            message: 'Request accepted. Waiting for the backend job to finish.',
          },
          ...cur,
        ]);
        return;
      }
      setOps((cur) => [base, ...cur]);
      await finish(base, 'succeeded', undefined);
    },
    [api.mode, finish],
  );

  const dismiss = useCallback((id: string) => setOps((cur) => cur.filter((o) => o.id !== id)), []);
  const value = useMemo(() => ({ ops, run, dismiss }), [ops, run, dismiss]);

  return (
    <OperationsContext.Provider value={value}>
      {children}
      {ops
        .filter((o) => o.jobId && (o.state === 'accepted' || o.state === 'running'))
        .map((o) => (
          <JobWatcher key={o.id} op={o} pollMs={pollMs} onUpdate={patch} onFinish={finish} />
        ))}
    </OperationsContext.Provider>
  );
}

function JobWatcher({
  op,
  pollMs,
  onUpdate,
  onFinish,
}: {
  op: TrackedOp;
  pollMs: number;
  onUpdate: (id: string, c: Partial<TrackedOp>) => void;
  onFinish: (
    op: TrackedOp,
    s: 'succeeded' | 'failed',
    m: string | undefined,
    steps?: Job['steps'],
  ) => Promise<void>;
}) {
  const api = useApi();
  const { data, error } = useQuery({
    queryKey: ['job', op.jobId],
    queryFn: ({ signal }) => api.jobs.get(op.jobId as string, signal),
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data) ? false : pollMs),
    retry: false,
    gcTime: 0,
  });

  useEffect(() => {
    if (!data) return;
    if (data.status === 'succeeded') void onFinish(op, 'succeeded', data.message, data.steps);
    else if (data.status === 'failed')
      void onFinish(op, 'failed', data.error?.message ?? data.message, data.steps);
    else
      onUpdate(op.id, {
        state: data.status === 'running' ? 'running' : 'accepted',
        steps: data.steps,
        message: data.message ?? op.message,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (!error) return;
    const gone = isApiError(error) && error.kind === 'not_found';
    onUpdate(op.id, {
      state: gone ? 'unknown' : op.state,
      message: gone
        ? 'The API no longer knows this job, so its outcome is unknown. Check the affected resource directly.'
        : 'Could not reach the API to check the job. Still waiting; the outcome is not yet known.',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  return null;
}

export function useOperations(): OperationsContextValue {
  const ctx = useContext(OperationsContext);
  if (!ctx) throw new Error('useOperations must be used inside <OperationsProvider>');
  return ctx;
}
