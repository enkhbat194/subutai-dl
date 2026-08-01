import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RootApp } from './RootApp';
import './styles.css';
import './live.css';
import './media.css';
import './queue.css';
import './transfer.css';
import './batch.css';
import './resilience.css';
import './tools.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Renderer root element was not found');
}

createRoot(root).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
);
