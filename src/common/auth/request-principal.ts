/**
 * The authenticated principal attached to a request after the JWT guard runs.
 *
 * This is deliberately minimal: it carries only what the token proves (which
 * account, which organization, and the token id). Roles, permissions, and
 * scope grants are NOT trusted from the token; they are resolved from the
 * database when needed (e.g. by `/auth/me` and the F0-05 scope guard).
 */
export interface RequestPrincipal {
  userAccountId: string;
  organizationId: string;
  /** JWT id of the access token, for correlation and later revocation. */
  tokenId: string;
}
