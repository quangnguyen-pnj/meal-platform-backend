import { Global, Module } from '@nestjs/common';
import { PermissionGuard } from './permission.guard';
import { PrincipalAuthorizationService } from './principal-authorization.service';
import { ScopeAuthorizer } from './scope-authorizer.service';

/**
 * Global so any domain module can inject `ScopeAuthorizer` to guard its reads
 * and writes, and apply `PermissionGuard` on its controllers, without
 * re-importing. `PrincipalAuthorizationService` is the shared DB resolver both
 * the authorizer and `/auth/me` build on.
 */
@Global()
@Module({
  providers: [PrincipalAuthorizationService, ScopeAuthorizer, PermissionGuard],
  exports: [PrincipalAuthorizationService, ScopeAuthorizer, PermissionGuard],
})
export class AuthorizationModule {}
