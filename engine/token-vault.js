/**
 * engine/token-vault.js — AES-256-GCM sealing for stored provider credentials
 *
 * GitLab / Bitbucket OAuth refresh tokens are long-lived secrets, unlike the
 * GitHub App flow (which stores nothing). They are sealed here before they go
 * into Redis, so a Redis dump alone does not yield usable tokens.
 *
 *   AEGIS_TOKEN_ENCRYPTION_KEY   32 bytes: 64 hex chars or base64.
 *                                Generate: openssl rand -hex 32
 *
 * Format:  v1.<iv>.<tag>.<ciphertext>   (each base64url)
 *
 * `aad` (additional authenticated data) binds a blob to its owner — callers
 * pass `${tenantId}:${provider}` so a blob copied under another tenant's key
 * fails authentication instead of decrypting.
 *
 * Rotation: not implemented. The `v1` prefix leaves room for a keyring later.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

function key() {
  const raw = (process.env.AEGIS_TOKEN_ENCRYPTION_KEY ?? '').trim();
  if (!raw) throw new Error('AEGIS_TOKEN_ENCRYPTION_KEY is not set.');
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('AEGIS_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64).');
  return buf;
}

export function tokenVaultConfigured() {
  try { key(); return true; } catch { return false; }
}

export function seal(plaintext, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf-8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((p, i) => (i === 0 ? p : p.toString('base64url'))).join('.');
}

export function open(sealed, aad) {
  const [v, iv, tag, ct] = String(sealed ?? '').split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised sealed value.');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf-8');
}
