import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { createApi } from './api';
import { AppProviders, AppRoutes } from './App';
import { loadConfig } from './config';
import './styles/index.css';

async function start() {
  const config = loadConfig();
  const api = await createApi(config);
  const baseUrl = import.meta.env.BASE_URL || '/';
  const basename = baseUrl.endsWith('/') && baseUrl.length > 1 ? baseUrl.slice(0, -1) : baseUrl;
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <AppProviders api={api} config={config} pollMs={api.mode === 'demo' ? 700 : 2000}>
        <BrowserRouter basename={basename}>
          <AppRoutes />
        </BrowserRouter>
      </AppProviders>
    </StrictMode>,
  );
}

void start();
