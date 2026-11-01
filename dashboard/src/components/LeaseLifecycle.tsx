import { useEffect, useState } from 'react';

const STAGES = [
  { state: 'FREE', text: 'Available to allocate' },
  { state: 'ALLOCATED', text: 'Leased to a sandbox' },
  { state: 'QUARANTINED', text: 'Cooling down; cannot be reallocated' },
  { state: 'FREE', text: 'Returned to the pool' },
];

export function LeaseCountdown({ until }: { until?: string | null }) {
  const [remaining, setRemaining] = useState<number | null>(() => {
    if (!until) return null;
    const diff = new Date(until).getTime() - Date.now();
    return Math.max(0, Math.floor(diff / 1000));
  });

  useEffect(() => {
    if (!until) return;
    const update = () => {
      const diff = new Date(until).getTime() - Date.now();
      setRemaining(Math.max(0, Math.floor(diff / 1000)));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [until]);

  if (remaining === null || remaining <= 0) {
    return (
      <span
        className="status-badge status-badge-warning"
        style={{ fontSize: '11px', padding: '1px 6px' }}
        title="Reaper lagging: lease expired but not yet reclaimed"
      >
        Expired (reaper lagging)
      </span>
    );
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const isUrgent = remaining < 60;

  return (
    <span
      className={`countdown-badge font-mono tabular-nums ${isUrgent ? 'urgent' : ''}`}
      title={`Cooldown expires in ${remaining} seconds`}
    >
      ⏱ {formatted} left
    </span>
  );
}

export function LeaseLifecycle() {
  return (
    <ol className="lifecycle" aria-label="Lease lifecycle: free, allocated, quarantined, free">
      {STAGES.map((s, i) => (
        <li key={i} className="lifecycle-step">
          <span className="lifecycle-state">{s.state}</span>
          <span className="muted">{s.text}</span>
          {i < STAGES.length - 1 && (
            <span className="lifecycle-arrow" aria-hidden>
              →
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
