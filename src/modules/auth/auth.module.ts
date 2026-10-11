import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { IDENTITY_PROVIDER } from '../../common/auth/identity-provider';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LocalIdentityProvider } from './local-identity-provider';

/**
 * Wires the local identity provider, the JWT signer/verifier, and the auth
 * endpoints. Binding `IDENTITY_PROVIDER` to `LocalIdentityProvider` here is the
 * single swap point for Enterprise SSO later; nothing else references the
 * concrete provider.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    LocalIdentityProvider,
    { provide: IDENTITY_PROVIDER, useExisting: LocalIdentityProvider },
  ],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
