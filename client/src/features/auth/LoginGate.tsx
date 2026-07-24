import { useEffect, useState, useCallback, type ReactNode } from 'react';

interface LoginGateProps {
  children: ReactNode;
}

interface AuthMe {
  name: string;
  email: string;
}

type LoginState = 'checking' | 'loggedOut' | 'loggedIn';

// 全局 401 拦截：业务 API 返回 401 时自动切回登录页。
// 用一个模块级标志位通知 LoginGate，避免侵入每个调用点。
let onUnauthorizedHandler: (() => void) | null = null;

export function notifyUnauthorized() {
  onUnauthorizedHandler?.();
}

// 包装 fetch：仅拦截 /api/ 开头的 401 响应。
const originalFetch = window.fetch;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await originalFetch(input, init);
  if (response.status === 401) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
      notifyUnauthorized();
    }
  }
  return response;
};

// LoginGate：Web 环境下检测登录态，未登录显示登录按钮。
// Electron 环境直接放行（preload bridge 不走 /api/auth/me）。
function LoginGate({ children }: LoginGateProps) {
  const [state, setState] = useState<LoginState>('checking');

  const checkLogin = useCallback(() => {
    const isElectron = Boolean(window.yibiao && window.yibiao.platform !== 'web');

    if (isElectron) {
      setState('loggedIn');
      return;
    }

    fetch('/api/auth/me')
      .then((res) => {
        if (res.ok) {
          return res.json() as Promise<AuthMe>;
        }
        throw new Error('not logged in');
      })
      .then(() => setState('loggedIn'))
      .catch(() => setState('loggedOut'));
  }, []);

  useEffect(() => {
    checkLogin();
    // 注册 401 拦截回调
    onUnauthorizedHandler = () => setState('loggedOut');
    return () => {
      onUnauthorizedHandler = null;
    };
  }, [checkLogin]);

  const handleLogout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // 忽略网络错误，前端直接切回登录页
    }
    setState('loggedOut');
  }, []);

  if (state === 'checking') {
    return null;
  }

  if (state === 'loggedOut') {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ marginBottom: '16px' }}>易标投标工具箱</h2>
          <p style={{ marginBottom: '24px', color: '#6b7280' }}>请先登录以使用 Web 端</p>
          <a href="/api/auth/login">
            <button type="button" style={{ padding: '10px 32px', fontSize: '15px', cursor: 'pointer' }}>
              使用 MainQuest 账号登录
            </button>
          </a>
        </div>
      </div>
    );
  }

  return (
    <>
      {children}
      <LogoutButton onLogout={handleLogout} />
    </>
  );
}

// 简易退出按钮：固定在右下角。
function LogoutButton({ onLogout }: { onLogout: () => void }) {
  return (
    <button
      type="button"
      onClick={onLogout}
      style={{
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: 9999,
        padding: '6px 14px',
        fontSize: '13px',
        cursor: 'pointer',
        opacity: 0.6,
        border: '1px solid #e5e7eb',
        borderRadius: '6px',
        background: '#fff',
      }}
      title="退出登录"
    >
      退出登录
    </button>
  );
}

export default LoginGate;
