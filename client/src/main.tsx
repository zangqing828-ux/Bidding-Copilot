import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AppProviders from './app/providers/AppProviders';
import WorkspaceDatabaseGate from './app/WorkspaceDatabaseGate';
import LoginGate from './features/auth/LoginGate';
import { installRuntimeBridge } from './shared/runtime/installRuntimeBridge';
import './styles.css';

installRuntimeBridge();

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppProviders>
      <LoginGate>
        <WorkspaceDatabaseGate>
          <App />
        </WorkspaceDatabaseGate>
      </LoginGate>
    </AppProviders>
  </React.StrictMode>
);