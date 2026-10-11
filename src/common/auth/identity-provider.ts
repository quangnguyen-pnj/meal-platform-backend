/**
 * Identity-provider abstraction. The auth module is the only place that knows
 * how a credential turns into a user account. Domain and workforce modules
 * never see passwords or SSO details; they only ever receive a resolved
 * principal.
 *
 * Phase 0-2 ships a single `LocalIdentityProvider` (email + Argon2id password
 * hash). An `EnterpriseSsoIdentityProvider` can be added later as another
 * implementation of this interface without touching any domain module.
 */

/**
 * The result of a successful authentication: just enough to identify which
 * UserAccount logged in. Roles, permissions, and scope grants are resolved
 * from the database afterwards, never trusted from the credential itself.
 */
export interface AuthenticatedIdentity {
  userAccountId: string;
  email: string;
}

/** Credentials passed to a provider. Local uses email + password. */
export interface AuthenticateInput {
  email: string;
  password: string;
}

export interface IdentityProvider {
  readonly provider: 'local' | 'enterprise-sso';

  /**
   * Returns the authenticated identity, or `null` when the credentials are
   * invalid. Implementations must not reveal whether the failure was an
   * unknown account or a wrong password.
   */
  authenticate(input: AuthenticateInput): Promise<AuthenticatedIdentity | null>;
}

/**
 * Injection token for the active identity provider. Bound to
 * `LocalIdentityProvider` today; swap or extend the binding in `AuthModule`
 * when SSO arrives.
 */
export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
