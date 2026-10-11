import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global so any domain module can inject `AuditService` to record audit rows
 * inside its own mutation transactions, without re-importing.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
