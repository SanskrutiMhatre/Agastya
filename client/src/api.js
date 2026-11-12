// The one place the client talks to the server. Same-origin requests, the
// session travels only in the HttpOnly cookie (never in storage), and every
// failure becomes an ApiError carrying the server's status and code.

export class ApiError extends Error {
  constructor(status, code, message, body) {
    super(message || 'Request failed.');
    this.status = status;
    this.code = code || null;
    this.body = body || null;
  }
}

/*
  The administrator's override editing session (decisions.md V3), while one
  is open on a page: { id, projectId, onStale, onEnded, onUsed }. Writes to
  that project carry its id; the server checks it is live and names the
  document being changed. A save the server refuses because it would make a
  pending request out of date (409 OVERRIDE_MAKES_STALE) is put to the
  administrator (onStale) and, if they accept, sent once more with their
  acknowledgement.
*/
let override = null;
export function setOverrideSession(o) { override = o; }
const overrideFor = (path, method) => (override && method !== 'GET' && path.startsWith(`/api/projects/${override.projectId}/`) ? override : null);

function afterOverride(ov, res, data) {
  if (!ov) return;
  if (res.ok) { if (ov.onUsed) ov.onUsed(); return; }
  if (res.status === 403 && data && data.code === 'OVERRIDE_SESSION_ENDED' && ov.onEnded) ov.onEnded();
}

export async function api(path, { method = 'GET', body, signal, headers: extra } = {}) {
  const ov = overrideFor(path, method);
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(ov ? { 'X-Agastya-Override-Session': ov.id } : {}), ...(extra || {}) }, signal };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Agastya server. Check your connection and try again.');
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  afterOverride(ov, res, data);
  if (ov && res.status === 409 && data && data.code === 'OVERRIDE_MAKES_STALE' && ov.onStale && !(extra && extra['X-Agastya-Override-Stale'])) {
    if (await ov.onStale(data)) return api(path, { method, body, signal, headers: { ...(extra || {}), 'X-Agastya-Override-Stale': 'accept' } });
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) {
      window.dispatchEvent(new CustomEvent('agastya:unauthorized'));
    }
    const fallback = res.status === 429 ? 'Too many attempts. Try again later.' : `Request failed (${res.status}).`;
    throw new ApiError(res.status, data && data.code, (data && data.error) || fallback, data);
  }
  return data;
}

async function failure(res) {
  let data = null;
  try { data = JSON.parse(await res.text()); } catch { data = null; }
  if (res.status === 401) window.dispatchEvent(new CustomEvent('agastya:unauthorized'));
  return new ApiError(res.status, data && data.code, (data && data.error) || `Request failed (${res.status}).`, data);
}

// Multipart upload (one file under "file" plus text fields). The browser sets the boundary.
export async function postForm(path, fields = {}, file = null, { accepted = false } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') form.append(k, v);
  if (file) form.append('file', file, file.name);
  const ov = overrideFor(path, 'POST');
  const headers = { ...(ov ? { 'X-Agastya-Override-Session': ov.id } : {}), ...(accepted ? { 'X-Agastya-Override-Stale': 'accept' } : {}) };
  let res;
  try { res = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin', headers }); } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Agastya server. Check your connection and try again.');
  }
  if (!res.ok) {
    const err = await failure(res);
    afterOverride(ov, res, err.body);
    if (ov && err.code === 'OVERRIDE_MAKES_STALE' && ov.onStale && !accepted && await ov.onStale(err.body)) return postForm(path, fields, file, { accepted: true });
    throw err;
  }
  afterOverride(ov, res, null);
  return res.json();
}

// Multipart upload, same as postForm, but the response is a file (a zip) rather than JSON.
export async function postFormBlob(path, fields = {}, file = null) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') form.append(k, v);
  if (file) form.append('file', file, file.name);
  let res;
  try { res = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin' }); } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Agastya server. Check your connection and try again.');
  }
  if (!res.ok) throw await failure(res);
  return res.blob();
}

// A JSON body, with the response as a Blob (a zip) rather than JSON.
export async function postBlob(path, body) {
  let res;
  try { res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Agastya server. Check your connection and try again.');
  }
  if (!res.ok) throw await failure(res);
  return res.blob();
}

// A binary response (PDF, spreadsheet) as a Blob.
export async function fetchBlob(path, { method = 'GET' } = {}) {
  let res;
  try { res = await fetch(path, { method, credentials: 'same-origin' }); } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Agastya server. Check your connection and try again.');
  }
  if (!res.ok) throw await failure(res);
  return res.blob();
}

export const get = (p, opts) => api(p, opts);
export const put = (p, body) => api(p, { method: 'PUT', body });
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = (p, body) => api(p, { method: 'DELETE', body });
