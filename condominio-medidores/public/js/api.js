// Comunicação com o servidor.

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(method, url, body) {
  const opts = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique sua internet e tente novamente.', 0);
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/login')) onUnauthorized();
    throw new ApiError((data && data.error) || 'Ocorreu um erro. Tente novamente.', res.status, data && data.code);
  }
  return data;
}

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  get: (url, params) => request('GET', url + qs(params)),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url, params) => request('DELETE', url + qs(params)),
};
