/**
 * Tenant context — propagated through every layer that touches shared state.
 *
 * A tenantId is a short, URL-safe string: "acme", "user_42", "org_abc123".
 * It is the caller's responsibility to resolve tenantId (from JWT, API key,
 * session, or CLI flag) before calling any engine function.
 *
 * The default tenant ("default") keeps single-tenant deployments working
 * with no code changes at the call site.
 */

export const DEFAULT_TENANT = 'default';

/**
 * Validate and normalise a tenantId.
 * Throws if the value is not a safe identifier (prevents key injection).
 */
export function assertTenantId(tenantId) {
  if (typeof tenantId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
    throw new Error(`Invalid tenantId: "${tenantId}". Must be 1-64 alphanumeric/dash/underscore chars.`);
  }
  return tenantId;
}