/**
 * tests/tax.test.js — engine/billing/tax.js and status.js
 */
import { describe, it, expect } from 'vitest';
import { taxMode, taxInputError, taxFields } from '../engine/billing/tax.js';
import { getStatus } from '../engine/status.js';

const gst = {
  AEGIS_TAX_MODE: 'gst', AEGIS_TAX_HOME_STATE: 'ka',
  STRIPE_TAXRATE_IN_CGST: 'txr_c', STRIPE_TAXRATE_IN_SGST: 'txr_s', STRIPE_TAXRATE_IN_IGST: 'txr_i',
};

describe('tax', () => {
  it('is off by default and ignores bad modes', () => {
    expect(taxMode({})).toBe('off');
    expect(taxMode({ AEGIS_TAX_MODE: 'bogus' })).toBe('off');
    expect(taxFields({ address: { country: 'IN' } }, {})).toEqual({ customer: {}, subscription: {} });
    expect(taxInputError({}, {})).toBeNull();
  });
  it('requires country, and state in India', () => {
    expect(taxInputError({}, gst)).toMatch('country');
    expect(taxInputError({ address: { country: 'IN' } }, gst)).toMatch('state');
    expect(taxInputError({ address: { country: 'US' } }, gst)).toBeNull();
  });
  it('validates GSTIN shape', () => {
    const address = { country: 'IN', state: 'KA' };
    expect(taxInputError({ address, taxId: '29ABCDE1234F1Z5' }, gst)).toBeNull();
    expect(taxInputError({ address, taxId: 'nope' }, gst)).toMatch('GSTIN');
  });
  it('gst: same state → CGST+SGST, other state → IGST, abroad → none', () => {
    expect(taxFields({ address: { country: 'in', state: 'ka' } }, gst).subscription).toEqual({ default_tax_rates: ['txr_c', 'txr_s'] });
    expect(taxFields({ address: { country: 'IN', state: 'MH' } }, gst).subscription).toEqual({ default_tax_rates: ['txr_i'] });
    expect(taxFields({ address: { country: 'US' } }, gst).subscription).toEqual({});
  });
  it('gst: missing rate env fails loudly', () => {
    expect(() => taxFields({ address: { country: 'IN', state: 'MH' } }, { ...gst, STRIPE_TAXRATE_IN_IGST: '' })).toThrow('STRIPE_TAXRATE_IN_IGST');
  });
  it('stripe mode enables automatic_tax and sends GSTIN', () => {
    const f = taxFields({ address: { country: 'DE' }, taxId: '29abcde1234f1z5' }, { AEGIS_TAX_MODE: 'stripe' });
    expect(f.subscription).toEqual({ automatic_tax: { enabled: true } });
    expect(f.customer.tax_id_data).toEqual([{ type: 'in_gst', value: '29ABCDE1234F1Z5' }]);
  });
});

describe('getStatus', () => {
  it('operational → 200', async () => {
    const r = await getStatus({ redis: async () => {} });
    expect(r.httpStatus).toBe(200);
    expect(r.body.status).toBe('operational');
  });
  it('a failing dependency → 503 outage', async () => {
    const r = await getStatus({ redis: async () => { throw new Error('down'); } });
    expect(r.httpStatus).toBe(503);
    expect(r.body.components.redis.status).toBe('outage');
  });
});
