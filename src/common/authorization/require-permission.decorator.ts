import { SetMetadata } from '@nestjs/common';
import { PermissionCode } from './permission-code';

/** Metadata key the `PermissionGuard` reads to find the required permission. */
export const REQUIRE_PERMISSION_KEY = 'requirePermission';

/**
 * Declare the permission a route handler requires. The `PermissionGuard`
 * resolves the caller's effective permissions from the database and returns
 * 403 when this code is missing.
 *
 * ```ts
 * @RequirePermission('employee:manage')
 * @Post()
 * create() { ... }
 * ```
 */
export const RequirePermission = (permission: PermissionCode) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);
