import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { installUxEnhancements } from './uxEnhancements';
import './styles.css';
import './ux.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Renderer root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

installUxEnhancements();
