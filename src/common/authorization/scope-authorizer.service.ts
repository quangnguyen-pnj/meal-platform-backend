import { Injectable } from '@nestjs/common';
import { AppError } from '../errors/app-error';
import { RequestPrincipal } from '../auth/request-principal';
import { PermissionCode } from './permission-code';
import { PrincipalAuthorizationService } from './principal-authorization.service';
import { ResourceScope, ScopeGrant } from './resource-scope';

/**
 * A Prisma `where` fragment that limits a list query to the rows a principal
 * may see. The caller spreads it into the query it already runs, so there is
 * no second round trip and no in-memory filtering after the fact.
 *
 * The fragment constrains the tenant-tree foreign keys the business tables
 * already carry (organizationId / factoryId / departmentId / teamId).
 */
export type ScopeFilter =
  | { organizationId: string }
  | { organizationId: string; factoryId: string }
  | { organizationId: string; departmentId: string }
  | { organizationId: string; teamId: string }
  | {
      organizationId: string;
      OR: Array<
        | { factoryId: string }
        | { departmentId: string }
        | { teamId: string }
        | { organizationId: string }
      >;
    };

/**
 * The authorization decision point. Services call it BEFORE reading or writing
 * so that a team-scoped user can never touch another team, regardless of what
 * the frontend sent. All data filtering lives here, not in the client.
 */
@Injectable()
export class ScopeAuthorizer {
  constructor(
    private readonly principalAuthorization: PrincipalAuthorizationService,
  ) {}

  /**
   * Throw FORBIDDEN unless the principal's effective permissions (resolved
   * from the database) include `permission`.
   */
  async assertPermission(input: {
    principal: RequestPrincipal;
    permission: PermissionCode;
  }): Promise<void> {
    const { permissions } = await this.principalAuthorization.resolve(
      input.principal,
    );
    if (!permissions.includes(input.permission)) {
      throw new AppError(
        'FORBIDDEN',
        `Missing required permission: ${input.permission}.`,
        { requiredPermission: input.permission },
      );
    }
  }

  /**
   * Throw FORBIDDEN unless the target `scope` lies inside at least one of the
   * principal's granted scope subtrees. An org-level grant covers every
   * factory/department/team under it; a team-level grant covers only its team.
   */
  async assertScope(input: {
    principal: RequestPrincipal;
    scope: ResourceScope;
  }): Promise<void> {
    const { scopeGrants } = await this.principalAuthorization.resolve(
      input.principal,
    );
    const covered = scopeGrants.some((grant) =>
      this.grantCoversScope(grant, input.scope),
    );
    if (!covered) {
      throw new AppError('FORBIDDEN', 'Target is outside your granted scope.');
    }
  }

  /**
   * Build the narrowest `where` fragment that still returns every row the
   * principal may see. When a principal holds several grants, the fragment
   * ORs them together. Throws FORBIDDEN when the principal holds no grant in
   * the organization it is operating in (nothing is visible).
   */
  async scopeFilter(principal: RequestPrincipal): Promise<ScopeFilter> {
    const { scopeGrants } =
      await this.principalAuthorization.resolve(principal);
    const grantsInOrg = scopeGrants.filter(
      (grant) => grant.organizationId === principal.organizationId,
    );
    if (grantsInOrg.length === 0) {
      throw new AppError(
        'FORBIDDEN',
        'No scope grant in the current organization.',
      );
    }

    // An org-level grant (no narrower level) makes the whole org visible, so
    // any narrower grants are redundant.
    if (grantsInOrg.some((grant) => this.levelOf(grant) === 'organization')) {
      return { organizationId: principal.organizationId };
    }

    const clauses = grantsInOrg.map((grant) => this.leafClause(grant));
    if (clauses.length === 1) {
      return { organizationId: principal.organizationId, ...clauses[0] };
    }
    return { organizationId: principal.organizationId, OR: clauses };
  }

  /**
   * The principal's grants in the organization it is operating in, or `'all'`
   * when it holds an organization-level grant (the whole org is visible).
   * Throws FORBIDDEN when the principal holds no grant in that organization.
   *
   * List queries over the tenant tree itself (factories, departments, teams)
   * cannot use `scopeFilter` directly, because each of those tables names its
   * own primary key differently (a department-level grant filters `department`
   * by `id` but `team` by `departmentId`). Callers map these grants to the
   * right column per table; the org-level and no-grant rules stay here so
   * every list path shares one source of truth.
   */
  async listableScopeGrants(
    principal: RequestPrincipal,
  ): Promise<ScopeGrant[] | 'all'> {
    const { scopeGrants } =
      await this.principalAuthorization.resolve(principal);
    const grantsInOrg = scopeGrants.filter(
      (grant) => grant.organizationId === principal.organizationId,
    );
    if (grantsInOrg.length === 0) {
      throw new AppError(
        'FORBIDDEN',
        'No scope grant in the current organization.',
      );
    }
    if (grantsInOrg.some((grant) => this.levelOf(grant) === 'organization')) {
      return 'all';
    }
    return grantsInOrg;
  }

  /**
   * True when `scope` is at or below `grant` in the tenant tree. The grant's
   * most specific level must match the same id on the scope, and the scope
   * must be in the same organization.
   */
  private grantCoversScope(grant: ScopeGrant, scope: ResourceScope): boolean {
    if (grant.organizationId !== scope.organizationId) {
      return false;
    }
    switch (this.levelOf(grant)) {
      case 'organization':
        return true;
      case 'factory':
        return scope.factoryId === grant.factoryId;
      case 'department':
        return scope.departmentId === grant.departmentId;
      case 'team':
        return scope.teamId === grant.teamId;
    }
  }

  private levelOf(
    grant: ScopeGrant,
  ): 'organization' | 'factory' | 'department' | 'team' {
    if (grant.teamId) return 'team';
    if (grant.departmentId) return 'department';
    if (grant.factoryId) return 'factory';
    return 'organization';
  }

  private leafClause(
    grant: ScopeGrant,
  ): { factoryId: string } | { departmentId: string } | { teamId: string } {
    switch (this.levelOf(grant)) {
      case 'factory':
        return { factoryId: grant.factoryId as string };
      case 'department':
        return { departmentId: grant.departmentId as string };
      case 'team':
        return { teamId: grant.teamId as string };
      case 'organization':
        // Unreachable: org-level grants are handled before this is called.
        throw new AppError(
          'INTERNAL_ERROR',
          'Cannot build a leaf clause for an organization-level grant.',
        );
    }
  }
}
