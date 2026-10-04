import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './critical.css';
import './index.css';

window.addEventListener('error', (e) => {
  const el = document.getElementById('root');
  if (el) {
    el.innerHTML += `<div style="padding:20px;color:red;background:#fee2e2;margin:20px;border-radius:8px;font-size:12px;font-family:monospace;white-space:pre-wrap;">${e.message}\n${e.filename}:${e.lineno}</div>`;
  }
});

try {
  const rootElement = document.getElementById('root');
  if (rootElement) {
    const root = createRoot(rootElement);
    root.render(<App />);
  }
} catch (err: any) {
  const el = document.getElementById('root');
  if (el) {
    el.innerHTML = `<div style="padding:20px;color:red;background:#fee2e2;margin:20px;border-radius:8px;font-size:12px;font-family:monospace;white-space:pre-wrap;">Startup Error:\n${err?.message || err}</div>`;
  }
}
