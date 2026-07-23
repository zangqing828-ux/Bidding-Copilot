// Web Bridge 的 HTTP client：封装对 /api/bridge 的 fetch 调用。
// 遇 501 WEB_CAPABILITY_PENDING 抛出可解释错误，由调用方 .catch / Toast 处理。

const BRIDGE_ENDPOINT = '/api/bridge';

export class WebCapabilityPendingError extends Error {
  readonly code = 'WEB_CAPABILITY_PENDING';

  constructor(message: string) {
    super(message);
    this.name = 'WebCapabilityPendingError';
  }
}

export interface BridgeResponse<T = unknown> {
  code?: string;
  message?: string;
  data?: T;
}

async function invoke<T = unknown>(namespace: string, method: string, args: unknown[] = []): Promise<T> {
  let response: Response;
  try {
    response = await fetch(BRIDGE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace, method, args }),
    });
  } catch (error) {
    throw new Error(`Web 请求失败：${error instanceof Error ? error.message : String(error)}`);
  }

  let payload: BridgeResponse<T>;
  try {
    payload = (await response.json()) as BridgeResponse<T>;
  } catch {
    throw new Error(`Web 响应解析失败（HTTP ${response.status}）`);
  }

  if (response.status === 501 || payload.code === 'WEB_CAPABILITY_PENDING') {
    throw new WebCapabilityPendingError(payload.message || '该功能尚未在 Web 端提供');
  }

  if (!response.ok) {
    throw new Error(payload.message || `Web 请求错误（HTTP ${response.status}）`);
  }

  return (payload.data ?? payload) as T;
}

export interface UploadResult {
  fileId: string;
  fileName: string;
  size: number;
}

// 上传单文件
async function upload(file: File): Promise<UploadResult> {
  const formData = new FormData();
  formData.append('file', file);

  let response: Response;
  try {
    response = await fetch('/api/uploads', { method: 'POST', body: formData });
  } catch (error) {
    throw new Error(`上传失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || `上传失败（HTTP ${response.status}）`);
  }

  return response.json();
}

// 上传多文件
async function uploadMultiple(files: File[]): Promise<{ files: UploadResult[] }> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }

  let response: Response;
  try {
    response = await fetch('/api/uploads/multiple', { method: 'POST', body: formData });
  } catch (error) {
    throw new Error(`上传失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || `上传失败（HTTP ${response.status}）`);
  }

  return response.json();
}

// 创建下载令牌并返回下载 URL
async function createDownloadUrl(filePath: string, fileName?: string): Promise<string> {
  const response = await fetch('/api/downloads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, fileName }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || `下载创建失败（HTTP ${response.status}）`);
  }

  const { downloadId } = await response.json();
  return `/api/downloads/${downloadId}`;
}

export const httpClient = { invoke, upload, uploadMultiple, createDownloadUrl };
