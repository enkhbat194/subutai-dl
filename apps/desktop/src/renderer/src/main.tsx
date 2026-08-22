import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RootApp } from './RootApp';
import './mvp.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Renderer root element was not found');
}

createRoot(root).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
);
