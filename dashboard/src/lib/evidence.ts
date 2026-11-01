/**
 * Helper to download structured JSON evidence from the console.
 * Used for jury reports, audit verification, and failover/stress drill validation.
 */
export function downloadJsonEvidence(filename: string, payload: Record<string, unknown>) {
  const content = JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      generator: 'FelCloud Control Plane Console',
      ...payload,
    },
    null,
    2,
  );
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = filename.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const dateStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `${safeName}-${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
