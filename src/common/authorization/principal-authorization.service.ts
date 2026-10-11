import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AppError } from '../errors/app-error';
import { RequestPrincipal } from '../auth/request-principal';
import { ScopeGrant } from './resource-scope';

/**
 * A scope grant plus the role it grants. The scope-checking logic only needs
 * the tenant ids on `ScopeGrant`; the role identity is here so the `/auth/me`
 * view can report which role is held at each scope without a second query.
 */
export interface ResolvedScopeGrant extends ScopeGrant {
  roleCode: string;
  roleName: string;
}

/**
 * Everything authorization needs about an account, read fresh from the
 * database. Roles, permissions, and scope grants are never trusted from the
 * token: a role revoked a second ago must take effect on the next request.
 */
export interface ResolvedAuthorization {
  roles: string[];
  permissions: string[];
  scopeGrants: ResolvedScopeGrant[];
  /** The linked employee's scope, when the account has one. */
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    factoryId: string;
    departmentId: string;
    teamId: string;
  } | null;
}

/**
 * The acting employee resolved from a principal, with the factory its
 * self-service reads and writes are bound to. The employee-facing surfaces
 * (self-registration and My Meals) only ever act on this employee, scoped to
 * this factory.
 */
export interface SelfEmployee {
  id: string;
  factoryId: string;
}

/**
 * Single source of truth for turning a `RequestPrincipal` into its effective
 * permissions and scope grants. Both the permission guard and the
 * `/auth/me` view read through this so the role/permission/scope query lives
 * in exactly one place.
 */
@Injectable()
export class PrincipalAuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the principal's own employee for employee self-service. Requires
   * the `registration:self` permission and a linked employee; an account with
   * neither can act on its own meals. Both the self-registration commands and
   * the My Meals read go through this so the "self only" gate lives in one
   * place and the employee id is never taken from the request.
   */
  async resolveSelfEmployee(
    principal: RequestPrincipal,
  ): Promise<SelfEmployee> {
    const resolved = await this.resolve(principal);
    if (!resolved.permissions.includes('registration:self')) {
      throw new AppError(
        'FORBIDDEN',
        'Missing required permission: registration:self.',
        { requiredPermission: 'registration:self' },
      );
    }
    if (!resolved.employee) {
      throw new AppError(
        'FORBIDDEN',
        'Your account is not linked to an employee, so it cannot self-register.',
      );
    }
    return {
      id: resolved.employee.id,
      factoryId: resolved.employee.factoryId,
    };
  }

  /**
   * Resolve the account's roles, de-duplicated permission codes, and scope
   * grants. Throws UNAUTHORIZED if the account is gone or deactivated.
   */
  async resolve(principal: RequestPrincipal): Promise<ResolvedAuthorization> {
    const account = await this.prisma.userAccount.findUnique({
      where: { id: principal.userAccountId },
      include: {
        employee: true,
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
      },
    });

    if (!account || !account.isActive) {
      throw new AppError('UNAUTHORIZED', 'Account is no longer active.');
    }

    const roles = account.userRoles.map((userRole) => userRole.role.code);
    const permissions = [
      ...new Set(
        account.userRoles.flatMap((userRole) =>
          userRole.role.rolePermissions.map(
            (rolePermission) => rolePermission.permission.code,
          ),
        ),
      ),
    ];
    const scopeGrants: ResolvedScopeGrant[] = account.userRoles.map(
      (userRole) => ({
        roleCode: userRole.role.code,
        roleName: userRole.role.name,
        organizationId: userRole.organizationId,
        factoryId: userRole.factoryId,
        departmentId: userRole.departmentId,
        teamId: userRole.teamId,
      }),
    );

    return {
      roles,
      permissions,
      scopeGrants,
      employee: account.employee
        ? {
            id: account.employee.id,
            employeeCode: account.employee.employeeCode,
            fullName: account.employee.fullName,
            factoryId: account.employee.factoryId,
            departmentId: account.employee.departmentId,
            teamId: account.employee.teamId,
          }
        : null,
    };
  }
}
