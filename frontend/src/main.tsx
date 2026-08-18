import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installNextHmiSdk, warmRecharts } from './nextHmiSdk';

// Must run before anything can render a widget: compiled widget modules read
// their React instance and app helpers off window.__nextHMI__ at module-eval
// time. See nextHmiSdk.ts for the contract.
installNextHmiSdk();
warmRecharts();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
