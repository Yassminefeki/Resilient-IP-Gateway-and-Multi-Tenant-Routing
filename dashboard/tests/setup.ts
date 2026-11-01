import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});
