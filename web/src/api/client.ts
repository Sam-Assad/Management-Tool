const BASE = '/api';

// Fired when the server says the session is gone (expired, signed out elsewhere, password reset): the app
// drops back to the sign-in page.
export const SIGNED_OUT_EVENT = 'hc-signed-out';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    // every request carries this header: the server refuses changes without it (blocks cross-site forgery)
    headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1', ...options.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    let message = body || `Request failed: ${res.status}`;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(body);
      code = parsed.code;
      // keep the JSON text as the message: pages already pull `.error` out of it
    } catch {
      // not JSON
    }
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    if (res.status === 403 && code === 'must_change_password') window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return res.json();
  return (await res.text()) as unknown as T;
}

// The `error` text of a failed request, for showing to the user.
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    return JSON.parse(raw).error ?? raw;
  } catch {
    return raw;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
