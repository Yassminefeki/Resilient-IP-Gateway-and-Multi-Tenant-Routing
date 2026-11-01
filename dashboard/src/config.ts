export interface AppConfig {
  apiBaseUrl: string;
  demoMode: boolean;
  timeoutMs: number;
  environmentLabel: string;
  grafanaUrl?: string;
}

type EnvLike = Record<string, string | boolean | undefined>;

/** Parse the public (browser-visible) environment into a typed config. */
export function loadConfig(env?: EnvLike): AppConfig {
  const timeout = Number(env ? env.VITE_API_TIMEOUT_MS : import.meta.env.VITE_API_TIMEOUT_MS);
  const rawGrafana = (env ? env.VITE_GRAFANA_URL : import.meta.env.VITE_GRAFANA_URL)
    ? String(env ? env.VITE_GRAFANA_URL : import.meta.env.VITE_GRAFANA_URL).trim()
    : '';
  const apiBase = env ? env.VITE_API_BASE_URL : import.meta.env.VITE_API_BASE_URL;
  const demoMode = env ? env.VITE_DEMO_MODE : import.meta.env.VITE_DEMO_MODE;
  const envLabel = env ? env.VITE_ENVIRONMENT_LABEL : import.meta.env.VITE_ENVIRONMENT_LABEL;

  return {
    apiBaseUrl: String(apiBase ?? '/api'),
    demoMode: String(demoMode ?? 'false').toLowerCase() === 'true',
    timeoutMs: Number.isFinite(timeout) && timeout >= 60_000 ? timeout : 120_000,
    environmentLabel: String(envLabel ?? 'Development'),
    grafanaUrl: rawGrafana || undefined,
  };
}

