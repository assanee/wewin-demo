import { describe, expect, it } from 'vitest';

import { isRouteAccess } from '../../src/rbac/access';
import { PERMISSIONS, PERMISSION_CODES, isPermissionCode } from '../../src/rbac/permissions';

/**
 * The catalogue itself, and the two things about it that are load-bearing elsewhere.
 *
 * The shape check is a copy of `permissions_code_shape` from 0002_auth.sql. Duplicating a
 * constraint is normally a smell; here it is the point. The constraint runs inside a
 * migration that was applied long before this list is read, so a badly-shaped code would
 * surface as a failed INSERT during the boot sync — on a deploy, with the process on its
 * way up. This turns the same mistake into a red test.
 */
const CODE_SHAPE = /^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$/;

describe('permission catalogue', () => {
  it('is not empty', () => {
    // The boot sync inserts `PERMISSION_CODES` in one statement; an empty VALUES list is
    // a syntax error, and an empty catalogue would mean no route can require anything.
    expect(PERMISSION_CODES.length).toBeGreaterThan(0);
  });

  it('uses codes Postgres will accept', () => {
    const wrong = PERMISSION_CODES.filter((code) => !CODE_SHAPE.test(code));
    expect(wrong).toStrictEqual([]);
  });

  it('describes every permission in a sentence somebody can read in a dashboard', () => {
    const undescribed = PERMISSION_CODES.filter((code) => PERMISSIONS[code].trim().length < 10);
    expect(undescribed).toStrictEqual([]);
  });

  describe('isPermissionCode', () => {
    it('accepts every code in the catalogue', () => {
      expect(PERMISSION_CODES.every(isPermissionCode)).toBe(true);
    });

    it('rejects a code this build has never heard of', () => {
      // The rollback case: release N+1 added it, N must simply not recognise it.
      expect(isPermissionCode('orders.reconcile')).toBe(false);
    });

    it('rejects inherited object properties', () => {
      // `'toString' in PERMISSIONS` is true, which is why this uses Object.hasOwn.
      expect(isPermissionCode('toString')).toBe(false);
      expect(isPermissionCode('constructor')).toBe(false);
    });
  });
});

/**
 * Route metadata is read off a reflection registry any package can write to, so the guard
 * validates it instead of casting. The empty-list case is the one that matters: a policy
 * saying "requires all of []" is satisfied by everybody while reading as protected.
 */
describe('isRouteAccess', () => {
  it('accepts the three policies', () => {
    expect(isRouteAccess({ kind: 'anonymous', reason: 'why' })).toBe(true);
    expect(isRouteAccess({ kind: 'authenticated' })).toBe(true);
    expect(isRouteAccess({ kind: 'permissions', codes: ['orders.read'] })).toBe(true);
  });

  it('rejects a permission policy that requires nothing', () => {
    expect(isRouteAccess({ kind: 'permissions', codes: [] })).toBe(false);
  });

  it('rejects a permission policy naming a code that does not exist', () => {
    expect(isRouteAccess({ kind: 'permissions', codes: ['orders.read', 'orders.reconcile'] })).toBe(false);
  });

  it('rejects anything else that happens to be under the same metadata key', () => {
    expect(isRouteAccess(undefined)).toBe(false);
    expect(isRouteAccess(null)).toBe(false);
    expect(isRouteAccess('anonymous')).toBe(false);
    expect(isRouteAccess({ kind: 'anonymous' })).toBe(false);
    expect(isRouteAccess({ kind: 'admin' })).toBe(false);
  });
});
