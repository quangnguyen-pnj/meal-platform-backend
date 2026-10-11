/**
 * The scope at which a principal holds a role, and the scope a resource lives
 * at. Both the grants a principal holds and the target being checked are
 * described with this shape so `ScopeAuthorizer.assertScope` can compare them.
 *
 * The tenant tree is Organization -> Factory -> Department -> Team. A resource
 * always names its full path to the leaf it is targeting; the authorizer walks
 * that path against the principal's grants. Only the ids that exist on the
 * resource need to be set. For example, a factory target sets `factoryId` and
 * leaves `departmentId`/`teamId` undefined.
 */
export interface ResourceScope {
  organizationId: string;
  factoryId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
}

/**
 * A single scoped role grant resolved from the database. A grant is pinned to
 * exactly one level (the `user_role_single_scope` DB CHECK guarantees it): an
 * org-level grant has null factory/department/team and covers the whole org
 * subtree; a team-level grant covers only that one team.
 */
export interface ScopeGrant {
  organizationId: string;
  factoryId: string | null;
  departmentId: string | null;
  teamId: string | null;
}
