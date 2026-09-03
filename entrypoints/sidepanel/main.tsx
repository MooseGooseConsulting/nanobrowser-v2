import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found in sidepanel');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
