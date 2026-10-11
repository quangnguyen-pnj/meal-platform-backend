import { Injectable } from '@nestjs/common';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { AuditService } from '../../common/audit/audit.service';
import {
  ResourceScope,
  ScopeGrant,
} from '../../common/authorization/resource-scope';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import {
  Prisma,
  Department,
  Factory,
  Team,
} from '../../generated/prisma/client';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';
import { CreateFactoryDto, UpdateFactoryDto } from './dto/factory.dto';
import { CreateTeamDto, UpdateTeamDto } from './dto/team.dto';
import {
  DepartmentView,
  FactoryView,
  ScopeTreeView,
  TeamView,
} from './organizations.types';

/**
 * Owns the tenant-tree business rules: containment validation (a department
 * belongs to one factory, a team's department must belong to the team's
 * factory), scope enforcement through `ScopeAuthorizer`, and an audit row
 * written in the same transaction as every mutation. Controllers stay thin and
 * never touch Prisma or the authorizer directly.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
    private readonly audit: AuditService,
  ) {}

  // --- Factories -----------------------------------------------------------

  async listFactories(principal: RequestPrincipal): Promise<FactoryView[]> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:read',
    });
    const grants = await this.scopeAuthorizer.listableScopeGrants(principal);
    const where: Prisma.FactoryWhereInput = {
      organizationId: principal.organizationId,
    };
    if (grants !== 'all') {
      Object.assign(where, factoryScopeWhere(grants));
    }
    const factories = await this.prisma.factory.findMany({
      where,
      orderBy: { code: 'asc' },
    });
    return factories.map(toFactoryView);
  }

  async getFactory(
    principal: RequestPrincipal,
    factoryId: string,
  ): Promise<FactoryView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:read',
    });
    const factory = await this.loadFactory(principal, factoryId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: { organizationId: factory.organizationId, factoryId: factory.id },
    });
    return toFactoryView(factory);
  }

  async createFactory(
    principal: RequestPrincipal,
    dto: CreateFactoryDto,
  ): Promise<FactoryView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:manage',
    });
    // A new factory sits directly under the organization, so the scope check
    // is at organization level: only an org-scoped manager may add factories.
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: { organizationId: principal.organizationId },
    });
    await this.assertFactoryCodeFree(principal.organizationId, dto.code);

    const factory = await this.audit.recordWithTransaction(
      (tx) =>
        tx.factory.create({
          data: {
            organizationId: principal.organizationId,
            code: dto.code,
            name: dto.name,
          },
        }),
      (created) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'factory.create',
        entityType: 'Factory',
        entityId: created.id,
        details: { code: created.code, name: created.name },
      }),
    );
    return toFactoryView(factory);
  }

  async updateFactory(
    principal: RequestPrincipal,
    factoryId: string,
    dto: UpdateFactoryDto,
  ): Promise<FactoryView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:manage',
    });
    const factory = await this.loadFactory(principal, factoryId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: { organizationId: factory.organizationId, factoryId: factory.id },
    });

    const updated = await this.audit.recordWithTransaction(
      (tx) =>
        tx.factory.update({
          where: { id: factory.id },
          data: { name: dto.name },
        }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'factory.update',
        entityType: 'Factory',
        entityId: result.id,
        details: { name: result.name },
      }),
    );
    return toFactoryView(updated);
  }

  async deleteFactory(
    principal: RequestPrincipal,
    factoryId: string,
  ): Promise<void> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:manage',
    });
    const factory = await this.loadFactory(principal, factoryId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: { organizationId: factory.organizationId, factoryId: factory.id },
    });
    await this.assertFactoryEmpty(factory.id);

    await this.audit.recordWithTransaction(
      (tx) => tx.factory.delete({ where: { id: factory.id } }),
      (deleted) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'factory.delete',
        entityType: 'Factory',
        entityId: deleted.id,
        details: { code: deleted.code },
      }),
    );
  }

  // --- Departments ---------------------------------------------------------

  async listDepartments(
    principal: RequestPrincipal,
    factoryId?: string,
  ): Promise<DepartmentView[]> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:read',
    });
    const grants = await this.scopeAuthorizer.listableScopeGrants(principal);
    const where: Prisma.DepartmentWhereInput = {
      organizationId: principal.organizationId,
    };
    if (grants !== 'all') {
      Object.assign(where, departmentScopeWhere(grants));
    }
    if (factoryId) {
      // Narrow to the requested factory, ANDed on top of the scope filter so
      // it can only ever shrink the result, never widen it past the grant.
      where.AND = [{ factoryId }];
    }
    const departments = await this.prisma.department.findMany({
      where,
      orderBy: { code: 'asc' },
    });
    return departments.map(toDepartmentView);
  }

  async getDepartment(
    principal: RequestPrincipal,
    departmentId: string,
  ): Promise<DepartmentView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:read',
    });
    const department = await this.loadDepartment(principal, departmentId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: this.departmentScope(department),
    });
    return toDepartmentView(department);
  }

  async createDepartment(
    principal: RequestPrincipal,
    dto: CreateDepartmentDto,
  ): Promise<DepartmentView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:manage',
    });
    const factory = await this.loadFactory(principal, dto.factoryId);
    // Scope is checked at the parent factory: a factory-scoped manager may add
    // departments under its own factory but not under another.
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: { organizationId: factory.organizationId, factoryId: factory.id },
    });
    await this.assertDepartmentCodeFree(principal.organizationId, dto.code);

    const department = await this.audit.recordWithTransaction(
      (tx) =>
        tx.department.create({
          data: {
            organizationId: principal.organizationId,
            factoryId: factory.id,
            code: dto.code,
            name: dto.name,
          },
        }),
      (created) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'department.create',
        entityType: 'Department',
        entityId: created.id,
        details: { code: created.code, factoryId: created.factoryId },
      }),
    );
    return toDepartmentView(department);
  }

  async updateDepartment(
    principal: RequestPrincipal,
    departmentId: string,
    dto: UpdateDepartmentDto,
  ): Promise<DepartmentView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:manage',
    });
    const department = await this.loadDepartment(principal, departmentId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: this.departmentScope(department),
    });

    const updated = await this.audit.recordWithTransaction(
      (tx) =>
        tx.department.update({
          where: { id: department.id },
          data: { name: dto.name },
        }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'department.update',
        entityType: 'Department',
        entityId: result.id,
        details: { name: result.name },
      }),
    );
    return toDepartmentView(updated);
  }

  async deleteDepartment(
    principal: RequestPrincipal,
    departmentId: string,
  ): Promise<void> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:manage',
    });
    const department = await this.loadDepartment(principal, departmentId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: this.departmentScope(department),
    });
    await this.assertDepartmentEmpty(department.id);

    await this.audit.recordWithTransaction(
      (tx) => tx.department.delete({ where: { id: department.id } }),
      (deleted) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'department.delete',
        entityType: 'Department',
        entityId: deleted.id,
        details: { code: deleted.code },
      }),
    );
  }

  // --- Teams ---------------------------------------------------------------

  async listTeams(
    principal: RequestPrincipal,
    departmentId?: string,
  ): Promise<TeamView[]> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:read',
    });
    const grants = await this.scopeAuthorizer.listableScopeGrants(principal);
    const where: Prisma.TeamWhereInput = {
      organizationId: principal.organizationId,
    };
    if (grants !== 'all') {
      Object.assign(where, teamScopeWhere(grants));
    }
    if (departmentId) {
      // ANDed on top of the scope filter so it can only shrink the result.
      where.AND = [{ departmentId }];
    }
    const teams = await this.prisma.team.findMany({
      where,
      orderBy: { code: 'asc' },
    });
    return teams.map(toTeamView);
  }

  async getTeam(
    principal: RequestPrincipal,
    teamId: string,
  ): Promise<TeamView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:read',
    });
    const team = await this.loadTeam(principal, teamId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: this.teamScope(team),
    });
    return toTeamView(team);
  }

  async createTeam(
    principal: RequestPrincipal,
    dto: CreateTeamDto,
  ): Promise<TeamView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:manage',
    });
    const department = await this.loadDepartment(principal, dto.departmentId);
    // Containment: the team's factory must be the department's factory. This
    // is what stops a team being created under a department of another factory.
    if (department.factoryId !== dto.factoryId) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Team factory must match the department factory.',
        {
          departmentFactoryId: department.factoryId,
          requestedFactoryId: dto.factoryId,
        },
      );
    }
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: this.departmentScope(department),
    });
    await this.assertTeamCodeFree(principal.organizationId, dto.code);

    const team = await this.audit.recordWithTransaction(
      (tx) =>
        tx.team.create({
          data: {
            organizationId: principal.organizationId,
            factoryId: department.factoryId,
            departmentId: department.id,
            code: dto.code,
            name: dto.name,
          },
        }),
      (created) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'team.create',
        entityType: 'Team',
        entityId: created.id,
        details: {
          code: created.code,
          factoryId: created.factoryId,
          departmentId: created.departmentId,
        },
      }),
    );
    return toTeamView(team);
  }

  async updateTeam(
    principal: RequestPrincipal,
    teamId: string,
    dto: UpdateTeamDto,
  ): Promise<TeamView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:manage',
    });
    const team = await this.loadTeam(principal, teamId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: this.teamScope(team),
    });

    const updated = await this.audit.recordWithTransaction(
      (tx) =>
        tx.team.update({ where: { id: team.id }, data: { name: dto.name } }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'team.update',
        entityType: 'Team',
        entityId: result.id,
        details: { name: result.name },
      }),
    );
    return toTeamView(updated);
  }

  async deleteTeam(principal: RequestPrincipal, teamId: string): Promise<void> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:manage',
    });
    const team = await this.loadTeam(principal, teamId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: this.teamScope(team),
    });
    await this.assertTeamEmpty(team.id);

    await this.audit.recordWithTransaction(
      (tx) => tx.team.delete({ where: { id: team.id } }),
      (deleted) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'team.delete',
        entityType: 'Team',
        entityId: deleted.id,
        details: { code: deleted.code },
      }),
    );
  }

  // --- Scope tree ----------------------------------------------------------

  async getScopeTree(principal: RequestPrincipal): Promise<ScopeTreeView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'organization:read',
    });
    const grants = await this.scopeAuthorizer.listableScopeGrants(principal);
    const factoryWhere: Prisma.FactoryWhereInput = {
      organizationId: principal.organizationId,
    };
    // The nested department/team filters pin a narrow grant to its own units,
    // so a department- or team-scoped principal never sees sibling units inside
    // the factory that contains its grant. `undefined` means "no filter" (an
    // org-level grant), which Prisma treats as unconstrained.
    let departmentWhere: Prisma.DepartmentWhereInput | undefined;
    let teamWhere: Prisma.TeamWhereInput | undefined;
    if (grants !== 'all') {
      Object.assign(factoryWhere, factoryScopeWhere(grants));
      departmentWhere = departmentScopeWhere(grants);
      teamWhere = teamScopeWhere(grants);
    }
    const factories = await this.prisma.factory.findMany({
      where: factoryWhere,
      orderBy: { code: 'asc' },
      include: {
        departments: {
          where: departmentWhere,
          orderBy: { code: 'asc' },
          include: { teams: { where: teamWhere, orderBy: { code: 'asc' } } },
        },
      },
    });

    return {
      organizationId: principal.organizationId,
      factories: factories.map((factory) => ({
        ...toFactoryView(factory),
        departments: factory.departments.map((department) => ({
          ...toDepartmentView(department),
          teams: department.teams.map(toTeamView),
        })),
      })),
    };
  }

  // --- Loaders (tenant-isolated reads) -------------------------------------

  private async loadFactory(
    principal: RequestPrincipal,
    factoryId: string,
  ): Promise<Factory> {
    const factory = await this.prisma.factory.findFirst({
      where: { id: factoryId, organizationId: principal.organizationId },
    });
    if (!factory) {
      throw new AppError('NOT_FOUND', 'Factory not found.', { factoryId });
    }
    return factory;
  }

  private async loadDepartment(
    principal: RequestPrincipal,
    departmentId: string,
  ): Promise<Department> {
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, organizationId: principal.organizationId },
    });
    if (!department) {
      throw new AppError('NOT_FOUND', 'Department not found.', {
        departmentId,
      });
    }
    return department;
  }

  private async loadTeam(
    principal: RequestPrincipal,
    teamId: string,
  ): Promise<Team> {
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, organizationId: principal.organizationId },
    });
    if (!team) {
      throw new AppError('NOT_FOUND', 'Team not found.', { teamId });
    }
    return team;
  }

  // --- Containment helpers -------------------------------------------------

  private departmentScope(department: Department): ResourceScope {
    return {
      organizationId: department.organizationId,
      factoryId: department.factoryId,
      departmentId: department.id,
    };
  }

  private teamScope(team: Team): ResourceScope {
    return {
      organizationId: team.organizationId,
      factoryId: team.factoryId,
      departmentId: team.departmentId,
      teamId: team.id,
    };
  }

  private async assertFactoryCodeFree(
    organizationId: string,
    code: string,
  ): Promise<void> {
    const existing = await this.prisma.factory.findUnique({
      where: { organizationId_code: { organizationId, code } },
    });
    if (existing) {
      throw new AppError('CONFLICT', 'Factory code already exists.', { code });
    }
  }

  private async assertDepartmentCodeFree(
    organizationId: string,
    code: string,
  ): Promise<void> {
    const existing = await this.prisma.department.findUnique({
      where: { organizationId_code: { organizationId, code } },
    });
    if (existing) {
      throw new AppError('CONFLICT', 'Department code already exists.', {
        code,
      });
    }
  }

  private async assertTeamCodeFree(
    organizationId: string,
    code: string,
  ): Promise<void> {
    const existing = await this.prisma.team.findUnique({
      where: { organizationId_code: { organizationId, code } },
    });
    if (existing) {
      throw new AppError('CONFLICT', 'Team code already exists.', { code });
    }
  }

  private async assertFactoryEmpty(factoryId: string): Promise<void> {
    const departmentCount = await this.prisma.department.count({
      where: { factoryId },
    });
    if (departmentCount > 0) {
      throw new AppError(
        'CONFLICT',
        'Cannot delete a factory that still has departments.',
        { factoryId },
      );
    }
  }

  private async assertDepartmentEmpty(departmentId: string): Promise<void> {
    const teamCount = await this.prisma.team.count({ where: { departmentId } });
    if (teamCount > 0) {
      throw new AppError(
        'CONFLICT',
        'Cannot delete a department that still has teams.',
        { departmentId },
      );
    }
  }

  private async assertTeamEmpty(teamId: string): Promise<void> {
    const employeeCount = await this.prisma.employee.count({
      where: { teamId },
    });
    if (employeeCount > 0) {
      throw new AppError(
        'CONFLICT',
        'Cannot delete a team that still has employees.',
        { teamId },
      );
    }
  }
}

/**
 * The deepest level a grant is pinned to. A grant always carries the full path
 * above its level (the `user_role_single_scope` CHECK guarantees it), so a
 * team grant names its factory and department too.
 */
function grantLevel(
  grant: ScopeGrant,
): 'organization' | 'factory' | 'department' | 'team' {
  if (grant.teamId) return 'team';
  if (grant.departmentId) return 'department';
  if (grant.factoryId) return 'factory';
  return 'organization';
}

/**
 * Scope filters for the three tenant-tree tables. Each maps a grant to the
 * narrowest column that exists on that table: the factory list keys off a
 * factory id, the department list off a department id (so a team-scoped grant
 * shows only the department containing its team, not siblings), and so on. A
 * grant below a table's own level still resolves to the containing row, so a
 * team-scoped principal still sees the factory and department above its team.
 * Callers only invoke these for non-org grants; an org-level grant is "all".
 */
function factoryScopeWhere(grants: ScopeGrant[]): { id: { in: string[] } } {
  const ids = new Set<string>();
  for (const grant of grants) {
    if (grant.factoryId) ids.add(grant.factoryId);
  }
  return { id: { in: [...ids] } };
}

function departmentScopeWhere(grants: ScopeGrant[]): {
  OR: Prisma.DepartmentWhereInput[];
} {
  const factoryIds = new Set<string>();
  const departmentIds = new Set<string>();
  for (const grant of grants) {
    if (grantLevel(grant) === 'factory' && grant.factoryId) {
      factoryIds.add(grant.factoryId);
    } else if (grant.departmentId) {
      // department- and team-level grants both pin to a single department.
      departmentIds.add(grant.departmentId);
    }
  }
  const or: Prisma.DepartmentWhereInput[] = [];
  if (factoryIds.size > 0) or.push({ factoryId: { in: [...factoryIds] } });
  if (departmentIds.size > 0) or.push({ id: { in: [...departmentIds] } });
  return { OR: or };
}

function teamScopeWhere(grants: ScopeGrant[]): { OR: Prisma.TeamWhereInput[] } {
  const factoryIds = new Set<string>();
  const departmentIds = new Set<string>();
  const teamIds = new Set<string>();
  for (const grant of grants) {
    switch (grantLevel(grant)) {
      case 'factory':
        if (grant.factoryId) factoryIds.add(grant.factoryId);
        break;
      case 'department':
        if (grant.departmentId) departmentIds.add(grant.departmentId);
        break;
      case 'team':
        if (grant.teamId) teamIds.add(grant.teamId);
        break;
    }
  }
  const or: Prisma.TeamWhereInput[] = [];
  if (factoryIds.size > 0) or.push({ factoryId: { in: [...factoryIds] } });
  if (departmentIds.size > 0)
    or.push({ departmentId: { in: [...departmentIds] } });
  if (teamIds.size > 0) or.push({ id: { in: [...teamIds] } });
  return { OR: or };
}

function toFactoryView(factory: Factory): FactoryView {
  return {
    id: factory.id,
    organizationId: factory.organizationId,
    code: factory.code,
    name: factory.name,
  };
}

function toDepartmentView(department: Department): DepartmentView {
  return {
    id: department.id,
    organizationId: department.organizationId,
    factoryId: department.factoryId,
    code: department.code,
    name: department.name,
  };
}

function toTeamView(team: Team): TeamView {
  return {
    id: team.id,
    organizationId: team.organizationId,
    factoryId: team.factoryId,
    departmentId: team.departmentId,
    code: team.code,
    name: team.name,
  };
}
