/**
 * engine/providers/oauth-util.js — shared HTTP helpers for OAuth providers.
 *
 * Error messages carry the HTTP status and OAuth error code only — never a
 * response body, which can echo tokens or codes.
 */

export const cfg = (k, d = '') => (process.env[k] ?? d).trim();

function oauthError(message, { status, code } = {}) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/**
 * POST an OAuth token request (form-encoded) and normalise the response.
 * `invalid_grant` (revoked / expired / already-used refresh token) is surfaced
 * as code OAUTH_INVALID_GRANT so callers can mark the connection revoked.
 *
 * @returns {Promise<{ accessToken: string, refreshToken: string|null, expiresAt: number }>}
 */
export async function postToken(url, params, { basicAuth, label }) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
  if (basicAuth) headers.Authorization = `Basic ${Buffer.from(`${basicAuth.id}:${basicAuth.secret}`).toString('base64')}`;

  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    const invalid = data.error === 'invalid_grant';
    throw oauthError(
      `${label} token request failed (HTTP ${res.status}${data.error ? `, ${String(data.error).slice(0, 40)}` : ''})`,
      { status: res.status, code: invalid ? 'OAUTH_INVALID_GRANT' : 'OAUTH_EXCHANGE_FAILED' },
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    // Default to 2 h (both providers' lifetime) if the field is missing.
    expiresAt: Date.now() + Number(data.expires_in ?? 7200) * 1000,
  };
}

export async function apiGet(url, token, label) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw oauthError(`${label} GET failed (HTTP ${res.status})`, { status: res.status, code: 'PROVIDER_API_ERROR' });
  return res.json();
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
export const safeSegment = (s) => NAME_RE.test(s) && s !== '.' && s !== '..';
