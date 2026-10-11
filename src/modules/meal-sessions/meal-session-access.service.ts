import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { MealSession } from '../../generated/prisma/client';
import { MealSessionStatus } from '../../generated/prisma/enums';
import { RegistrationWindow } from './meal-sessions.types';

/**
 * THE single place the backend decides whether a meal session is open for
 * registration right now (the `MealSessionAccess` boundary from the plan).
 * Every cutoff decision - here, and Phase 2 registration - flows through
 * `getRegistrationWindow`, so there is exactly one implementation of "is this
 * session open".
 *
 * The window is derived on demand from `status`, `opensAt`, and `cutoffAt`
 * relative to the `now` the caller passes. It does NOT depend on a background
 * job: a session whose `cutoffAt` has passed reports `CUTOFF_PASSED`/closed
 * even if its stored status is still OPEN and no close worker ran. `now` is
 * injected so this is a pure, testable decision.
 */
@Injectable()
export class MealSessionAccess {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Load the session and evaluate its registration window. Throws NOT_FOUND
   * when the session does not exist. Pass the organization to keep the lookup
   * tenant-scoped (the Phase 2 registration caller holds a principal).
   */
  async getRegistrationWindow(input: {
    mealSessionId: string;
    organizationId: string;
    now: Date;
  }): Promise<RegistrationWindow> {
    const session = await this.prisma.mealSession.findFirst({
      where: {
        id: input.mealSessionId,
        organizationId: input.organizationId,
      },
    });
    if (!session) {
      throw new AppError('NOT_FOUND', 'Meal session not found.', {
        mealSessionId: input.mealSessionId,
      });
    }
    return evaluateRegistrationWindow(session, input.now);
  }
}

/**
 * Pure evaluator for a loaded session. Kept as a standalone function so the
 * session service can describe an already-loaded session without a second
 * query, while all window logic still lives in this one module.
 *
 * Precedence: a CANCELLED or CLOSED status is terminal; otherwise time decides.
 * Past `cutoffAt` always reports `CUTOFF_PASSED` regardless of stored status,
 * which is what makes correctness independent of a close worker. Registration
 * is open only when the session is OPEN and `now` is in `[opensAt, cutoffAt)`.
 */
export function evaluateRegistrationWindow(
  session: Pick<MealSession, 'id' | 'status' | 'opensAt' | 'cutoffAt'>,
  now: Date,
): RegistrationWindow {
  const base = {
    mealSessionId: session.id,
    opensAt: session.opensAt.toISOString(),
    cutoffAt: session.cutoffAt.toISOString(),
  };

  if (session.status === MealSessionStatus.CANCELLED) {
    return {
      ...base,
      state: 'CANCELLED',
      isOpen: false,
      reason: 'The meal session was cancelled.',
    };
  }

  if (now.getTime() >= session.cutoffAt.getTime()) {
    return {
      ...base,
      state: 'CUTOFF_PASSED',
      isOpen: false,
      reason: 'The cutoff time has passed; registration is closed.',
    };
  }

  if (session.status === MealSessionStatus.CLOSED) {
    return {
      ...base,
      state: 'CLOSED',
      isOpen: false,
      reason: 'The meal session is closed.',
    };
  }

  if (
    session.status === MealSessionStatus.DRAFT ||
    session.status === MealSessionStatus.PUBLISHED ||
    now.getTime() < session.opensAt.getTime()
  ) {
    return {
      ...base,
      state: 'BEFORE_OPEN',
      isOpen: false,
      reason: 'Registration has not opened yet.',
    };
  }

  return {
    ...base,
    state: 'OPEN',
    isOpen: true,
    reason: 'Registration is open.',
  };
}
