import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AppProviders from './app/providers/AppProviders';
import WorkspaceDatabaseGate from './app/WorkspaceDatabaseGate';
import DeveloperTokenStatsWindow from './features/developer/pages/DeveloperTokenStatsWindow';
import LoginGate from './features/auth/LoginGate';
import { installRuntimeBridge } from './shared/runtime/installRuntimeBridge';
import './styles.css';

// 在 React 渲染前安装运行时 bridge：
// Electron 环境由 preload 注入，浏览器环境安装 Web Bridge。
installRuntimeBridge();

const windowMode = new URLSearchParams(window.location.search).get('window');

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {windowMode === 'token-stats' ? (
      <DeveloperTokenStatsWindow />
    ) : (
      <AppProviders>
        <LoginGate>
          <WorkspaceDatabaseGate>
            <App />
          </WorkspaceDatabaseGate>
        </LoginGate>
      </AppProviders>
    )}
  </React.StrictMode>
);
