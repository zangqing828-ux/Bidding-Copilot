// Web Bridge 的 HTTP client：封装对 /api/bridge 的 fetch 调用。
// 遇 501 WEB_CAPABILITY_PENDING 抛出可解释错误，由调用方 .catch / Toast 处理。

const BRIDGE_ENDPOINT = '/api/bridge';

export class WebCapabilityPendingError extends Error {
  readonly code = 'WEB_CAPABILITY_PENDING';
  readonly status = 501;

  constructor(message: string) {
    super(message);
    this.name = 'WebCapabilityPendingError';
  }
}

class WebCapabilityError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(code: string, message: string, status: number, retryAfterSeconds: number | null) {
    super(message);
    this.name = 'WebCapabilityError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
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

  if (payload.code === 'WEB_CAPABILITY_PENDING') {
    throw new WebCapabilityPendingError(payload.message || '该功能尚未在 Web 端提供');
  }

  if (!response.ok) {
    const errorCode = typeof payload.code === 'string' ? payload.code : `HTTP_${response.status}`;
    const retryAfter = Number(response.headers.get('Retry-After'));
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
    throw new WebCapabilityError(
      errorCode,
      payload.message || `Web 请求错误（HTTP ${response.status}）`,
      response.status,
      retryAfterSeconds,
    );
  }

  return (payload.data ?? payload) as T;
}

export interface UploadResult {
  fileId: string;
  fileName: string;
  extension?: string;
  size: number;
  uploadedAt?: string;
  deduplicated?: boolean;
}

const DOCUMENT_ACCEPT = '.doc,.docx,.pdf,.txt,.md,.xlsx';

function chooseFiles({ multiple = false, accept = DOCUMENT_ACCEPT }: { multiple?: boolean; accept?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    let settled = false;
    let focusTimer: number | null = null;
    const cleanup = () => {
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      window.removeEventListener('focus', onWindowFocus);
      input.remove();
    };
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(files);
    };
    const onWindowFocus = () => {
      focusTimer = window.setTimeout(() => finish(Array.from(input.files || [])), 300);
    };
    input.type = 'file';
    input.multiple = multiple;
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => finish(Array.from(input.files || [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    window.addEventListener('focus', onWindowFocus, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

async function downloadFile(downloadUrl: string, fileName = '投标技术文件.docx'): Promise<void> {
  let response: Response;
  try {
    response = await fetch(downloadUrl, { method: 'GET', credentials: 'same-origin' });
  } catch (error) {
    throw new Error(`下载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(message || `下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
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

async function chooseAndUpload(options: { multiple?: boolean; accept?: string } = {}): Promise<UploadResult[]> {
  const files = await chooseFiles(options);
  if (!files.length) return [];
  if (options.multiple) {
    const result = await uploadMultiple(files);
    return result.files || [];
  }
  return [await upload(files[0])];
}

export const httpClient = { invoke, upload, uploadMultiple, chooseAndUpload, downloadFile };
