import { createContext, useContext, type ReactNode } from 'react';
import type { Api } from './api/contracts';
import type { AppConfig } from './config';

interface AppContextValue {
  api: Api;
  config: AppConfig;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppContextProvider({
  api,
  config,
  children,
}: AppContextValue & { children: ReactNode }) {
  return <AppContext.Provider value={{ api, config }}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppContextProvider>');
  return ctx;
}
export const useApi = (): Api => useApp().api;
export const useAppConfig = (): AppConfig => useApp().config;
