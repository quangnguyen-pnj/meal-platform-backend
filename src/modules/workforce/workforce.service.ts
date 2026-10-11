import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { AuditService } from '../../common/audit/audit.service';
import { ResourceScope } from '../../common/authorization/resource-scope';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import {
  Prisma,
  Employee,
  Role,
  Team,
  UserAccount,
  UserRole,
} from '../../generated/prisma/client';
import {
  CreateEmployeeDto,
  EmployeeAccountDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';
import { GrantRoleDto } from './dto/role-grant.dto';
import {
  EmployeeView,
  RoleGrantView,
  UserAccountView,
} from './workforce.types';

/** The role code whose grant must be constrained to the holder's own self. */
const EMPLOYEE_ROLE_CODE = 'Employee';

/**
 * Owns the workforce business rules: employee CRUD with tenant-tree
 * containment and a per-organization unique employeeCode, optional account
 * linking (Argon2id-hashed, never storing plaintext), and role/scope grants.
 *
 * Every read asserts `employee:read`, every employee write asserts
 * `employee:manage`, and every grant asserts `role:assign`, each followed by a
 * per-target scope check through `ScopeAuthorizer` BEFORE acting. Every
 * mutation writes an `AuditLog` row in the same transaction. Controllers stay
 * thin and never touch Prisma, Argon2, or the authorizer directly.
 */
@Injectable()
export class WorkforceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
    private readonly audit: AuditService,
  ) {}

  // --- Employees -----------------------------------------------------------

  async listEmployees(
    principal: RequestPrincipal,
    teamId?: string,
  ): Promise<EmployeeView[]> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:read',
    });
    // scopeFilter limits the query to the rows this principal may see, so a
    // team-scoped user never sees employees outside their team.
    const filter = await this.scopeAuthorizer.scopeFilter(principal);
    const where: Prisma.EmployeeWhereInput = { ...filter };
    if (teamId) {
      where.AND = [{ teamId }];
    }
    const employees = await this.prisma.employee.findMany({
      where,
      orderBy: { employeeCode: 'asc' },
    });
    return employees.map(toEmployeeView);
  }

  async getEmployee(
    principal: RequestPrincipal,
    employeeId: string,
  ): Promise<EmployeeView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:read',
    });
    const employee = await this.loadEmployee(principal, employeeId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: employeeScope(employee),
    });
    return toEmployeeView(employee);
  }

  async createEmployee(
    principal: RequestPrincipal,
    dto: CreateEmployeeDto,
  ): Promise<EmployeeView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:manage',
    });
    const placement = await this.resolvePlacement(principal, {
      factoryId: dto.factoryId,
      departmentId: dto.departmentId,
      teamId: dto.teamId,
    });
    // The target scope is the team the employee is placed in: a team-scoped
    // manager may add employees to its own team but not to another.
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: teamScope(placement.team),
    });
    await this.assertEmployeeCodeFree(
      principal.organizationId,
      dto.employeeCode,
    );

    let passwordHash: string | undefined;
    if (dto.account) {
      await this.assertAccountEmailFree(dto.account.email);
      passwordHash = await hashPassword(dto.account.password);
    }
    const accountEmail = dto.account?.email;

    const employee = await this.audit.recordWithTransaction(
      async (tx) => {
        let userAccountId: string | undefined;
        if (accountEmail && passwordHash) {
          const account = await tx.userAccount.create({
            data: { email: accountEmail, passwordHash },
          });
          userAccountId = account.id;
        }
        return tx.employee.create({
          data: {
            organizationId: principal.organizationId,
            factoryId: placement.team.factoryId,
            departmentId: placement.team.departmentId,
            teamId: placement.team.id,
            employeeCode: dto.employeeCode,
            fullName: dto.fullName,
            email: dto.email ?? null,
            hasPersonalDevice: dto.hasPersonalDevice ?? false,
            userAccountId: userAccountId ?? null,
          },
        });
      },
      (created) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'employee.create',
        entityType: 'Employee',
        entityId: created.id,
        details: {
          employeeCode: created.employeeCode,
          teamId: created.teamId,
          linkedAccount: created.userAccountId !== null,
        },
      }),
    );
    return toEmployeeView(employee);
  }

  async updateEmployee(
    principal: RequestPrincipal,
    employeeId: string,
    dto: UpdateEmployeeDto,
  ): Promise<EmployeeView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:manage',
    });
    const employee = await this.loadEmployee(principal, employeeId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: employeeScope(employee),
    });

    const data: Prisma.EmployeeUpdateInput = {};
    if (dto.fullName !== undefined) {
      data.fullName = dto.fullName;
    }
    if (dto.email !== undefined) {
      data.email = dto.email;
    }
    if (dto.hasPersonalDevice !== undefined) {
      data.hasPersonalDevice = dto.hasPersonalDevice;
    }

    // A move changes the tenant placement, so resolve and re-check containment
    // and scope for the new location before writing.
    if (
      dto.factoryId !== undefined ||
      dto.departmentId !== undefined ||
      dto.teamId !== undefined
    ) {
      const placement = await this.resolvePlacement(principal, {
        factoryId: dto.factoryId ?? employee.factoryId,
        departmentId: dto.departmentId ?? employee.departmentId,
        teamId: dto.teamId ?? employee.teamId,
      });
      await this.scopeAuthorizer.assertScope({
        principal,
        scope: teamScope(placement.team),
      });
      data.factory = { connect: { id: placement.team.factoryId } };
      data.department = { connect: { id: placement.team.departmentId } };
      data.team = { connect: { id: placement.team.id } };
    }

    const updated = await this.audit.recordWithTransaction(
      (tx) => tx.employee.update({ where: { id: employee.id }, data }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'employee.update',
        entityType: 'Employee',
        entityId: result.id,
        details: {
          employeeCode: result.employeeCode,
          teamId: result.teamId,
        },
      }),
    );
    return toEmployeeView(updated);
  }

  async deleteEmployee(
    principal: RequestPrincipal,
    employeeId: string,
  ): Promise<void> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:manage',
    });
    const employee = await this.loadEmployee(principal, employeeId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: employeeScope(employee),
    });

    await this.audit.recordWithTransaction(
      (tx) => tx.employee.delete({ where: { id: employee.id } }),
      (deleted) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'employee.delete',
        entityType: 'Employee',
        entityId: deleted.id,
        details: { employeeCode: deleted.employeeCode },
      }),
    );
  }

  // --- Account linking -----------------------------------------------------

  /**
   * Create a login account for an existing employee and link it. Rejected if
   * the employee already has an account. The password is hashed with Argon2id
   * before anything is written and never stored or returned in plaintext.
   */
  async createEmployeeAccount(
    principal: RequestPrincipal,
    employeeId: string,
    dto: EmployeeAccountDto,
  ): Promise<UserAccountView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:manage',
    });
    const employee = await this.loadEmployee(principal, employeeId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: employeeScope(employee),
    });
    if (employee.userAccountId) {
      throw new AppError('CONFLICT', 'Employee already has a linked account.', {
        employeeId,
      });
    }
    await this.assertAccountEmailFree(dto.email);
    const passwordHash = await hashPassword(dto.password);

    const account = await this.audit.recordWithTransaction(
      async (tx) => {
        const created = await tx.userAccount.create({
          data: { email: dto.email, passwordHash },
        });
        await tx.employee.update({
          where: { id: employee.id },
          data: { userAccount: { connect: { id: created.id } } },
        });
        return created;
      },
      (created) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'employee.account.create',
        entityType: 'UserAccount',
        entityId: created.id,
        details: { employeeId: employee.id, email: created.email },
      }),
    );
    return toUserAccountView(account);
  }

  // --- Role / scope grants -------------------------------------------------

  async grantRole(
    principal: RequestPrincipal,
    dto: GrantRoleDto,
  ): Promise<RoleGrantView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'role:assign',
    });

    const scope = this.toGrantScope(principal.organizationId, dto);
    const account = await this.loadAccount(principal, dto.userAccountId);
    const role = await this.loadRole(principal, dto.roleId);

    // You cannot grant beyond your own authority: the target scope must lie
    // inside at least one of the granting principal's own grants.
    await this.scopeAuthorizer.assertScope({ principal, scope });

    // The Employee role is a self-only grant. It must target the account's own
    // linked employee at that employee's team, never a broader scope that
    // would let a plain employee act on others.
    if (role.code === EMPLOYEE_ROLE_CODE) {
      await this.assertEmployeeSelfScope(account.id, scope);
    }

    await this.assertGrantFree(scope, account.id, role.id);

    const grant = await this.audit.recordWithTransaction(
      (tx) =>
        tx.userRole.create({
          data: {
            userAccountId: account.id,
            roleId: role.id,
            organizationId: scope.organizationId,
            factoryId: scope.factoryId ?? null,
            departmentId: scope.departmentId ?? null,
            teamId: scope.teamId ?? null,
          },
        }),
      (created) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'role.grant',
        entityType: 'UserRole',
        entityId: created.id,
        details: {
          userAccountId: created.userAccountId,
          roleId: created.roleId,
          factoryId: created.factoryId,
          departmentId: created.departmentId,
          teamId: created.teamId,
        },
      }),
    );
    return toRoleGrantView(grant);
  }

  async revokeRole(
    principal: RequestPrincipal,
    grantId: string,
  ): Promise<void> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'role:assign',
    });
    const grant = await this.prisma.userRole.findFirst({
      where: { id: grantId, organizationId: principal.organizationId },
    });
    if (!grant) {
      throw new AppError('NOT_FOUND', 'Role grant not found.', { grantId });
    }
    // Revoking is bounded by the same authority as granting: the principal
    // must own the scope the grant sits at.
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: grantScope(grant),
    });

    await this.audit.recordWithTransaction(
      (tx) => tx.userRole.delete({ where: { id: grant.id } }),
      (deleted) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'role.revoke',
        entityType: 'UserRole',
        entityId: deleted.id,
        details: {
          userAccountId: deleted.userAccountId,
          roleId: deleted.roleId,
        },
      }),
    );
  }

  // --- Placement + containment ---------------------------------------------

  /**
   * Resolve the team an employee is placed under and verify the full chain is
   * consistent and tenant-local: the team's department must be the requested
   * department, and that department's factory must be the requested factory,
   * all in the principal's organization. Mirrors P0-01's containment approach.
   */
  private async resolvePlacement(
    principal: RequestPrincipal,
    placement: { factoryId: string; departmentId: string; teamId: string },
  ): Promise<{ team: Team }> {
    const team = await this.prisma.team.findFirst({
      where: {
        id: placement.teamId,
        organizationId: principal.organizationId,
      },
    });
    if (!team) {
      throw new AppError('NOT_FOUND', 'Team not found.', {
        teamId: placement.teamId,
      });
    }
    if (team.departmentId !== placement.departmentId) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Employee team must belong to the given department.',
        {
          teamDepartmentId: team.departmentId,
          requestedDepartmentId: placement.departmentId,
        },
      );
    }
    if (team.factoryId !== placement.factoryId) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Employee department must belong to the given factory.',
        {
          teamFactoryId: team.factoryId,
          requestedFactoryId: placement.factoryId,
        },
      );
    }
    return { team };
  }

  // --- Grant scope resolution ----------------------------------------------

  /**
   * Turn the optional tenant ids on the DTO into a single coherent scope. A
   * grant sits at exactly one level, matching the `user_role_single_scope` DB
   * CHECK: a teamId requires its departmentId and factoryId, a departmentId
   * requires its factoryId, and so on. A gap (for example teamId without
   * departmentId) is a VALIDATION_ERROR.
   */
  private toGrantScope(
    organizationId: string,
    dto: GrantRoleDto,
  ): ResourceScope {
    if (dto.teamId) {
      if (!dto.departmentId || !dto.factoryId) {
        throw new AppError(
          'VALIDATION_ERROR',
          'A team-scoped grant requires its department and factory.',
        );
      }
      return {
        organizationId,
        factoryId: dto.factoryId,
        departmentId: dto.departmentId,
        teamId: dto.teamId,
      };
    }
    if (dto.departmentId) {
      if (!dto.factoryId) {
        throw new AppError(
          'VALIDATION_ERROR',
          'A department-scoped grant requires its factory.',
        );
      }
      return {
        organizationId,
        factoryId: dto.factoryId,
        departmentId: dto.departmentId,
      };
    }
    if (dto.factoryId) {
      return { organizationId, factoryId: dto.factoryId };
    }
    return { organizationId };
  }

  /**
   * Enforce the self-only rule for the Employee role: the account must be
   * linked to an employee, and the grant must target exactly that employee's
   * own team scope. Any broader or different scope is FORBIDDEN.
   */
  private async assertEmployeeSelfScope(
    userAccountId: string,
    scope: ResourceScope,
  ): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { userAccountId },
    });
    if (!employee) {
      throw new AppError(
        'VALIDATION_ERROR',
        'The Employee role can only be granted to an account linked to an employee.',
        { userAccountId },
      );
    }
    const isSelfScope =
      scope.factoryId === employee.factoryId &&
      scope.departmentId === employee.departmentId &&
      scope.teamId === employee.teamId;
    if (!isSelfScope) {
      throw new AppError(
        'FORBIDDEN',
        'The Employee role is self-scoped and must target the account holder own team.',
        {
          expected: {
            factoryId: employee.factoryId,
            departmentId: employee.departmentId,
            teamId: employee.teamId,
          },
        },
      );
    }
  }

  // --- Loaders (tenant-isolated reads) -------------------------------------

  private async loadEmployee(
    principal: RequestPrincipal,
    employeeId: string,
  ): Promise<Employee> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId: principal.organizationId },
    });
    if (!employee) {
      throw new AppError('NOT_FOUND', 'Employee not found.', { employeeId });
    }
    return employee;
  }

  /**
   * Load the target account and confine it to the principal's organization.
   * An account belongs to a tenant through its linked employee, so an account
   * whose employee is in another organization (or that has no employee at all)
   * is not a valid grant target here. Without this the account id alone could
   * attach a role scoped to the principal's org to an account in another org.
   * Reported as NOT_FOUND so a caller cannot probe for accounts outside its
   * tenant.
   */
  private async loadAccount(
    principal: RequestPrincipal,
    userAccountId: string,
  ): Promise<UserAccount> {
    const account = await this.prisma.userAccount.findUnique({
      where: { id: userAccountId },
    });
    if (!account) {
      throw new AppError('NOT_FOUND', 'User account not found.', {
        userAccountId,
      });
    }
    const employee = await this.prisma.employee.findFirst({
      where: {
        userAccountId: account.id,
        organizationId: principal.organizationId,
      },
    });
    if (!employee) {
      throw new AppError('NOT_FOUND', 'User account not found.', {
        userAccountId,
      });
    }
    return account;
  }

  private async loadRole(
    principal: RequestPrincipal,
    roleId: string,
  ): Promise<Role> {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, organizationId: principal.organizationId },
    });
    if (!role) {
      throw new AppError('NOT_FOUND', 'Role not found.', { roleId });
    }
    return role;
  }

  // --- Uniqueness / conflict guards ----------------------------------------

  private async assertEmployeeCodeFree(
    organizationId: string,
    employeeCode: string,
  ): Promise<void> {
    const existing = await this.prisma.employee.findUnique({
      where: {
        organizationId_employeeCode: { organizationId, employeeCode },
      },
    });
    if (existing) {
      throw new AppError('CONFLICT', 'Employee code already exists.', {
        employeeCode,
      });
    }
  }

  private async assertAccountEmailFree(email: string): Promise<void> {
    const existing = await this.prisma.userAccount.findUnique({
      where: { email },
    });
    if (existing) {
      throw new AppError('CONFLICT', 'An account with this email exists.', {
        email,
      });
    }
  }

  private async assertGrantFree(
    scope: ResourceScope,
    userAccountId: string,
    roleId: string,
  ): Promise<void> {
    const existing = await this.prisma.userRole.findFirst({
      where: {
        userAccountId,
        roleId,
        organizationId: scope.organizationId,
        factoryId: scope.factoryId ?? null,
        departmentId: scope.departmentId ?? null,
        teamId: scope.teamId ?? null,
      },
    });
    if (existing) {
      throw new AppError(
        'CONFLICT',
        'This role is already granted at this scope.',
        { userAccountId, roleId },
      );
    }
  }
}

async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

function employeeScope(employee: Employee): ResourceScope {
  return {
    organizationId: employee.organizationId,
    factoryId: employee.factoryId,
    departmentId: employee.departmentId,
    teamId: employee.teamId,
  };
}

function teamScope(team: Team): ResourceScope {
  return {
    organizationId: team.organizationId,
    factoryId: team.factoryId,
    departmentId: team.departmentId,
    teamId: team.id,
  };
}

function grantScope(grant: UserRole): ResourceScope {
  return {
    organizationId: grant.organizationId,
    factoryId: grant.factoryId,
    departmentId: grant.departmentId,
    teamId: grant.teamId,
  };
}

function toEmployeeView(employee: Employee): EmployeeView {
  return {
    id: employee.id,
    organizationId: employee.organizationId,
    factoryId: employee.factoryId,
    departmentId: employee.departmentId,
    teamId: employee.teamId,
    employeeCode: employee.employeeCode,
    fullName: employee.fullName,
    email: employee.email,
    hasPersonalDevice: employee.hasPersonalDevice,
    userAccountId: employee.userAccountId,
  };
}

function toUserAccountView(account: UserAccount): UserAccountView {
  return {
    id: account.id,
    email: account.email,
    isActive: account.isActive,
  };
}

function toRoleGrantView(grant: UserRole): RoleGrantView {
  return {
    id: grant.id,
    userAccountId: grant.userAccountId,
    roleId: grant.roleId,
    organizationId: grant.organizationId,
    factoryId: grant.factoryId,
    departmentId: grant.departmentId,
    teamId: grant.teamId,
  };
}
