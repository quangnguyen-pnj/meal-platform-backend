/**
 * The catalog of permission codes seeded in F0-03. Keeping them as a string
 * literal union lets `@RequirePermission(...)` and `ScopeAuthorizer` reject
 * typos at compile time instead of silently never matching a grant.
 *
 * These must stay in sync with the `Permission` rows created by the seed.
 */
export const PERMISSION_CODES = [
  'organization:read',
  'organization:manage',
  'employee:read',
  'employee:manage',
  'employee:import',
  'role:assign',
  'audit:read',
  'menu:manage',
  'meal-session:manage',
  'registration:self',
  'registration:bulk',
  'registration:adjust',
  'reserve:manage',
  'report:read',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];
