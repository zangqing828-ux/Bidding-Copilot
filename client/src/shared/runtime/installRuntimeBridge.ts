// 运行时选择：Electron 环境 preload 已注入 window.yibiao，浏览器环境安装 Web Bridge。
import type { YibiaoBridge } from '../types/ipc';
import { webBridge } from '../api/webBridge';

export function installRuntimeBridge(): void {
  if (window.yibiao) {
    // Electron 环境：preload.cjs 已通过 contextBridge 注入，直接使用。
    return;
  }

  // 浏览器环境：安装 Web Bridge。
  window.yibiao = webBridge satisfies YibiaoBridge;
  window.yibiaoClient = {
    appName: webBridge.appName,
    platform: webBridge.platform,
  };
}
