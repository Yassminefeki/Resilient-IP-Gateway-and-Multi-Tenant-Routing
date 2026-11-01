export type Tone = 'positive' | 'warning' | 'critical' | 'info' | 'neutral';

interface Label {
  text: string;
  tone: Tone;
}

/** Every status has a text label and a distinct symbol so colour is never the only signal. */
const LABELS: Record<string, Label> = {
  active: { text: 'Active', tone: 'positive' },
  requested: { text: 'Requested', tone: 'info' },
  provisioning: { text: 'Provisioning', tone: 'info' },
  failed: { text: 'Failed', tone: 'critical' },
  terminating: { text: 'Terminating', tone: 'warning' },
  terminated: { text: 'Terminated', tone: 'neutral' },
  expired: { text: 'Expired', tone: 'neutral' },
  free: { text: 'Free', tone: 'neutral' },
  allocated: { text: 'Allocated', tone: 'info' },
  quarantined: { text: 'Quarantined', tone: 'warning' },
  master: { text: 'Master', tone: 'positive' },
  backup: { text: 'Backup', tone: 'info' },
  fault: { text: 'Fault', tone: 'critical' },
  unknown: { text: 'Unknown', tone: 'neutral' },
  up: { text: 'Up', tone: 'positive' },
  down: { text: 'Down', tone: 'critical' },
  healthy: { text: 'Healthy', tone: 'positive' },
  unhealthy: { text: 'Unhealthy', tone: 'critical' },
  ok: { text: 'OK', tone: 'positive' },
  degraded: { text: 'Degraded', tone: 'warning' },
  pending: { text: 'Pending', tone: 'info' },
  running: { text: 'Running', tone: 'info' },
  succeeded: { text: 'Succeeded', tone: 'positive' },
  passed: { text: 'Passed', tone: 'positive' },
  not_run: { text: 'Not run', tone: 'neutral' },
  not_deployed: { text: 'Not deployed', tone: 'neutral' },
  deployed: { text: 'Deployed', tone: 'positive' },
  partial: { text: 'Partially deployed', tone: 'warning' },
  applied: { text: 'Applied', tone: 'positive' },
  info: { text: 'Info', tone: 'info' },
  warning: { text: 'Warning', tone: 'warning' },
  error: { text: 'Error', tone: 'critical' },
  critical: { text: 'Critical', tone: 'critical' },
  valid: { text: 'Valid', tone: 'positive' },
  expiring: { text: 'Expiring', tone: 'warning' },
  invalid: { text: 'Invalid', tone: 'critical' },
  configured: { text: 'Configured', tone: 'neutral' },
  validated: { text: 'Validated', tone: 'info' },
  reachable: { text: 'Reachable', tone: 'positive' },
  live: { text: 'Live measurement', tone: 'positive' },
  historical: { text: 'Historical result', tone: 'info' },
  imported: { text: 'Imported result', tone: 'neutral' },
  demo: { text: 'Demo data', tone: 'warning' },
};

export function labelFor(status: string): Label {
  return LABELS[status] ?? { text: status.replace(/_/g, ' '), tone: 'neutral' };
}

export const TONE_SYMBOL: Record<Tone, string> = {
  positive: '✓',
  warning: '!',
  critical: '✕',
  info: '●',
  neutral: '○',
};
