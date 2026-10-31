/**
 * engine/billing/tax.js
 *
 * Tax parameters for Stripe subscriptions. AEGIS_TAX_MODE:
 *
 *   off     (default) no tax parameters; behaviour is unchanged.
 *   stripe  Stripe Tax (`automatic_tax`). Needs Stripe Tax set up with your
 *           registrations. In India Stripe Tax only covers non-resident
 *           sellers (IGST on OIDAR), so an India-based seller uses `gst`.
 *   gst     India-based seller. Charges fixed Stripe Tax Rates chosen by place
 *           of supply: customer in AEGIS_TAX_HOME_STATE → CGST + SGST, another
 *           Indian state → IGST, customer outside India → no tax (export of
 *           services; zero-rated only if you hold a valid LUT).
 *           Env: AEGIS_TAX_HOME_STATE (ISO 3166-2:IN code, e.g. KA),
 *           STRIPE_TAXRATE_IN_CGST / _SGST / _IGST (from scripts/stripe-setup.js).
 *
 * Customers must give a billing country (and an Indian state when in India).
 */

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function taxMode(env = process.env) {
  const mode = (env.AEGIS_TAX_MODE ?? 'off').trim().toLowerCase();
  return ['off', 'stripe', 'gst'].includes(mode) ? mode : 'off';
}

/** Trim + upper-case the fields we compare on; drops empty ones. */
export function normalizeAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const out = {};
  for (const k of ['country', 'state', 'postal_code']) {
    const v = typeof address[k] === 'string' ? address[k].trim() : '';
    if (v) out[k] = k === 'postal_code' ? v : v.toUpperCase();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validate billing input for the active mode. Returns an error string, or null.
 * Run before any Stripe call so a bad request is a 400, not a 502.
 */
export function taxInputError({ address, taxId } = {}, env = process.env) {
  const mode = taxMode(env);
  if (mode === 'off') return null;
  const a = normalizeAddress(address);
  if (!a?.country || !/^[A-Z]{2}$/.test(a.country)) {
    return '`billingAddress.country` (ISO 3166-1 alpha-2, e.g. "IN") is required.';
  }
  if (a.country === 'IN' && !a.state) {
    return '`billingAddress.state` (ISO 3166-2:IN code, e.g. "KA") is required for customers in India.';
  }
  if (taxId !== undefined && taxId !== null && taxId !== '') {
    if (typeof taxId !== 'string' || !GSTIN_RE.test(taxId.trim().toUpperCase())) {
      return '`taxId` must be a valid 15-character GSTIN.';
    }
  }
  return null;
}

function requireEnv(env, name) {
  if (!env[name]) throw new Error(`Tax mode "gst" needs ${name} — run scripts/stripe-setup.js.`);
  return env[name];
}

/**
 * Stripe fields to merge into customers.create / subscriptions.create.
 * @returns {{ customer: object, subscription: object }}
 */
export function taxFields({ address, taxId } = {}, env = process.env) {
  const mode = taxMode(env);
  if (mode === 'off') return { customer: {}, subscription: {} };
  const a = normalizeAddress(address);
  const customer = {};
  if (a) customer.address = a;
  if (taxId) customer.tax_id_data = [{ type: 'in_gst', value: taxId.trim().toUpperCase() }];

  if (mode === 'stripe') return { customer, subscription: { automatic_tax: { enabled: true } } };
  if (mode !== 'gst' || a?.country !== 'IN') return { customer, subscription: {} };

  const home = requireEnv(env, 'AEGIS_TAX_HOME_STATE').trim().toUpperCase();
  const rates = a.state === home
    ? [requireEnv(env, 'STRIPE_TAXRATE_IN_CGST'), requireEnv(env, 'STRIPE_TAXRATE_IN_SGST')]
    : [requireEnv(env, 'STRIPE_TAXRATE_IN_IGST')];
  return { customer, subscription: { default_tax_rates: rates } };
}
