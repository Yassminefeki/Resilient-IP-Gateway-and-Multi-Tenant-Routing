const KEY = 'felcloud.apiToken';

/**
 * Optional bearer token. Held in sessionStorage only (cleared when the tab
 * closes) and never read from VITE_* variables, which are public.
 * See docs/SECURITY.md for the trade-offs.
 */
export const tokenStore = {
  get(): string | null {
    try {
      return window.sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    try {
      window.sessionStorage.setItem(KEY, token.trim());
    } catch {
      /* storage unavailable: token simply is not retained */
    }
  },
  clear(): void {
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};
