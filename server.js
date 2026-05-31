// ─── server.js — key rotation / revocation additions ─────────────────────────
//
// Add this import alongside the other engine imports at the top of server.js:
//
//   import { createKey, revokeKey, listKeys } from './engine/key-store.js';
//
// Then add these three routes anywhere after the express app is created.
// They use the same requireApiKey / assertTenantAccess guards already present
// on the other management routes (POST /tenants, etc.).
//
// ─── Key management routes ────────────────────────────────────────────────────

/**
 * POST /tenants/:id/keys
 *
 * Create a new API key for a tenant (rotate without restart).
 * The raw key is returned exactly once — store it immediately.
 *
 * Body (optional JSON):
 *   { label?: string, expiresAt?: number }   expiresAt = ms epoch
 *
 * Response:
 *   { keyId, rawKey, label, createdAt, expiresAt }
 *
 * Example:
 *   curl -X POST /tenants/acme/keys \
 *        -H 'Authorization: Bearer <current-key>' \
 *        -d '{"label":"prod rotation 2026-05"}'
 */
app.post('/tenants/:id/keys', async (req, res) => {
  try {
    const tenantId = req.params.id;

    // Auth: caller must present a valid key for this tenant
    await requireApiKey(req, res, () => {}, tenantId);
    if (res.headersSent) return;
    if (!assertTenantAccess(req, tenantId, res)) return;

    const { label = '', expiresAt = null } = req.body ?? {};

    const { keyId, rawKey, record } = await createKey(tenantId, { label, expiresAt });

    res.status(201).json({
      keyId,
      rawKey,          // only time the raw key is ever returned
      label:     record.label,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /tenants/:id/keys
 *
 * List all keys for a tenant (metadata only — no raw keys or hashes).
 *
 * Response:
 *   { keys: [{ keyId, label, createdAt, expiresAt, revokedAt }] }
 */
app.get('/tenants/:id/keys', async (req, res) => {
  try {
    const tenantId = req.params.id;

    await requireApiKey(req, res, () => {}, tenantId);
    if (res.headersSent) return;
    if (!assertTenantAccess(req, tenantId, res)) return;

    const keys = await listKeys(tenantId);
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /tenants/:id/keys/:keyId
 *
 * Revoke a key immediately.
 * Takes effect on the very next request — no process restart required.
 * The record is tombstoned (revokedAt set) rather than deleted so the
 * audit trail is preserved.
 *
 * Response:
 *   { revoked: true, keyId }
 *
 * Zero-downtime rotation workflow:
 *   1. POST /tenants/:id/keys          → get new rawKey, distribute to services
 *   2. DELETE /tenants/:id/keys/:oldId → old key rejected immediately
 */
app.delete('/tenants/:id/keys/:keyId', async (req, res) => {
  try {
    const { id: tenantId, keyId } = req.params;

    await requireApiKey(req, res, () => {}, tenantId);
    if (res.headersSent) return;
    if (!assertTenantAccess(req, tenantId, res)) return;

    const ok = await revokeKey(tenantId, keyId);

    if (!ok) {
      return res.status(404).json({ error: `Key "${keyId}" not found for tenant "${tenantId}".` });
    }

    res.json({ revoked: true, keyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
