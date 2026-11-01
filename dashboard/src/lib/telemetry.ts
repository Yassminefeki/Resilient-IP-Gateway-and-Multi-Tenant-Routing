/**
 * Client-side telemetry buffer: keeps polled values in memory and sessionStorage
 * (last 60 to 120 entries) to generate real, honest sparklines "since console opened".
 */

export interface TelemetryPoint {
  ts: number;
  freeIps?: number;
  allocatedIps?: number;
  latencyMs?: number;
  requestsPerSec?: number;
}

const STORAGE_KEY = 'felcloud_telemetry_buffer_v1';
const MAX_POINTS = 120;

function loadBuffer(): TelemetryPoint[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.slice(-MAX_POINTS);
    }
  } catch {
    // Ignore storage parse errors
  }
  return [];
}

let memoryBuffer: TelemetryPoint[] = loadBuffer();

export function recordTelemetryPoint(point: Omit<TelemetryPoint, 'ts'>) {
  const newPt: TelemetryPoint = {
    ts: Date.now(),
    ...point,
  };
  memoryBuffer.push(newPt);
  if (memoryBuffer.length > MAX_POINTS) {
    memoryBuffer = memoryBuffer.slice(-MAX_POINTS);
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memoryBuffer));
  } catch {
    // SessionStorage may be full or disabled
  }
}

export function getTelemetryBuffer(): TelemetryPoint[] {
  return [...memoryBuffer];
}

export function clearTelemetryBuffer() {
  memoryBuffer = [];
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}
