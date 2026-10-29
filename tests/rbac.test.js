/**
 * tests/rbac.test.js — engine/rbac.js role → permission model
 */
import { describe, it, expect } from 'vitest';
import { ROLES, PERMISSIONS, LEGACY_ROLE, can, isRole, permissionsFor } from '../engine/rbac.js';

describe('rbac', () => {
  it('orders roles viewer < member < admin', () => {
    expect(ROLES).toEqual(['viewer', 'member', 'admin']);
  });

  it('grants each permission to its minimum role and everything above', () => {
    for (const [perm, min] of Object.entries(PERMISSIONS)) {
      ROLES.forEach((role, i) => {
        expect(can(role, perm), `${role} → ${perm}`).toBe(i >= ROLES.indexOf(min));
      });
    }
  });

  it('viewer holds no mutating permission; admin holds all', () => {
    expect(permissionsFor('viewer')).toEqual([]);
    expect(permissionsFor('member')).toEqual(['workflow.run', 'review.resolve']);
    expect(permissionsFor('admin')).toEqual(Object.keys(PERMISSIONS));
  });

  it('fails closed on unknown roles and permissions', () => {
    expect(can('superuser', 'workflow.run')).toBe(false);
    expect(can(undefined, 'workflow.run')).toBe(false);
    expect(can('admin', 'nope')).toBe(false);
    expect(isRole('admin')).toBe(true);
    expect(isRole('root')).toBe(false);
  });

  it('keeps pre-RBAC credentials at full access', () => {
    expect(LEGACY_ROLE).toBe('admin');
  });
});
