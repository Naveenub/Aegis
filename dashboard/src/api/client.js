const BASE_URL = import.meta.env.VITE_AEGIS_API_URL || '';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, apiKey, params } = {}) {
  const url = new URL(path, BASE_URL || window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export const api = {
  // health
  health: () => request('/health'),

  // tasks / workflow control
  submitTask: (apiKey, { task, tenantId, priority }) =>
    request('/task', { method: 'POST', apiKey, body: { task, tenantId, priority } }),
  resumeWorkflow: (apiKey, { workflowId, tenantId }) =>
    request('/resume', { method: 'POST', apiKey, body: { workflowId, tenantId } }),
  cancelWorkflow: (apiKey, { workflowId, tenantId, reason }) =>
    request('/cancel', { method: 'POST', apiKey, body: { workflowId, tenantId, reason } }),

  // workflows
  listWorkflows: (apiKey, { status, tenantId, cursor, limit } = {}) =>
    request('/workflows', { apiKey, params: { status, tenantId, cursor, limit } }),
  getWorkflow: (apiKey, workflowId) =>
    request(`/workflows/${encodeURIComponent(workflowId)}`, { apiKey }),
  getRewindHistory: (apiKey, workflowId) =>
    request(`/workflows/${encodeURIComponent(workflowId)}/rewind-history`, { apiKey }),
  rewindStep: (apiKey, workflowId, stepId, { tenantId, reason } = {}) =>
    request(`/workflows/${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepId)}/rewind`, {
      method: 'POST', apiKey, body: { tenantId, reason },
    }),

  // concurrency
  getConcurrency: (apiKey, workflowId, priority) =>
    request(`/concurrency/${encodeURIComponent(workflowId)}`, { apiKey, params: { priority } }),

  // jobs
  listJobs: (apiKey, { tenantId, limit } = {}) =>
    request('/jobs', { apiKey, params: { tenantId, limit } }),
  getJob: (apiKey, jobId, tenantId) =>
    request(`/jobs/${encodeURIComponent(jobId)}`, { apiKey, params: { tenantId } }),

  // dlq
  listDlq: (apiKey, { tenantId, limit } = {}) =>
    request('/dlq', { apiKey, params: { tenantId, limit } }),

  // traces
  listTraces: (apiKey, limit) => request('/traces', { apiKey, params: { limit } }),
  getTrace: (apiKey, traceId) => request(`/traces/${encodeURIComponent(traceId)}`, { apiKey }),

  // review queue
  getReviewQueue: (apiKey, { status, limit } = {}) =>
    request('/review-queue', { apiKey, params: { status, limit } }),
  resolveReview: (apiKey, { workflowId, stepId, resolution, note, tenantId }) =>
    request('/review-queue/resolve', { method: 'POST', apiKey, body: { workflowId, stepId, resolution, note, tenantId } }),

  // metrics / anomalies
  getMetrics: (apiKey) => request('/api/metrics', { apiKey }),
  getAnomalies: (apiKey, limit) => request('/anomalies', { apiKey, params: { limit } }),

  // tenants
  listTenants: (apiKey) => request('/tenants', { apiKey }),
  createTenant: (apiKey, { tenantId, label }) =>
    request('/tenants', { method: 'POST', apiKey, body: { tenantId, label } }),
  getTenant: (apiKey, id) => request(`/tenants/${encodeURIComponent(id)}`, { apiKey }),
  listKeys: (apiKey, tenantId) => request(`/tenants/${encodeURIComponent(tenantId)}/keys`, { apiKey }),
  createKey: (apiKey, tenantId, { label, expiresAt } = {}) =>
    request(`/tenants/${encodeURIComponent(tenantId)}/keys`, { method: 'POST', apiKey, body: { label, expiresAt } }),
  revokeKey: (apiKey, tenantId, keyId) =>
    request(`/tenants/${encodeURIComponent(tenantId)}/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', apiKey }),

  // EventSource cannot set headers, so the key travels as a query param —
  // the backend's extractKey() has an explicit fallback for this (auth.js).
  eventsUrl: (apiKey) => {
    const url = new URL('/events', BASE_URL || window.location.origin);
    if (apiKey) url.searchParams.set('apiKey', apiKey);
    return url.toString();
  },
};

export { ApiError, BASE_URL };
