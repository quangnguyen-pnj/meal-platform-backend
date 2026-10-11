/**
 * Response and view-model shapes for the auth module.
 */

/** Tokens returned by login and refresh. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Access-token lifetime in seconds, for client-side refresh scheduling. */
  expiresIn: number;
}

/** A single scoped role grant the account holds. */
export interface PrincipalScopeGrant {
  roleCode: string;
  roleName: string;
  organizationId: string;
  factoryId: string | null;
  departmentId: string | null;
  teamId: string | null;
}

/** The linked workforce member, when the account is tied to one. */
export interface PrincipalEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
  factoryId: string;
  departmentId: string;
  teamId: string;
}

/**
 * The `/auth/me` payload: the authenticated account plus everything resolved
 * from the database (linked employee, roles, permissions, scope grants). None
 * of this comes from the token; it is read fresh so revoked roles take effect
 * immediately.
 */
export interface AuthenticatedPrincipalView {
  userAccountId: string;
  email: string;
  organizationId: string;
  employee: PrincipalEmployee | null;
  roles: string[];
  permissions: string[];
  scopeGrants: PrincipalScopeGrant[];
}
