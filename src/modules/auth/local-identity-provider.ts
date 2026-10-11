import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/database/prisma.service';
import {
  AuthenticatedIdentity,
  AuthenticateInput,
  IdentityProvider,
} from '../../common/auth/identity-provider';

/**
 * Local credential provider: looks up a UserAccount by email and verifies the
 * supplied password against the stored Argon2id hash. This is the only
 * implementation in Phase 0-2.
 *
 * Returns `null` for every failure mode (unknown email, inactive account, no
 * local password, wrong password) so callers cannot distinguish them and the
 * API never leaks whether an email exists.
 */
@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  readonly provider = 'local' as const;

  constructor(private readonly prisma: PrismaService) {}

  async authenticate(
    input: AuthenticateInput,
  ): Promise<AuthenticatedIdentity | null> {
    const account = await this.prisma.userAccount.findUnique({
      where: { email: input.email },
    });

    if (!account || !account.isActive || !account.passwordHash) {
      return null;
    }

    const passwordMatches = await argon2.verify(
      account.passwordHash,
      input.password,
    );
    if (!passwordMatches) {
      return null;
    }

    return { userAccountId: account.id, email: account.email };
  }
}
