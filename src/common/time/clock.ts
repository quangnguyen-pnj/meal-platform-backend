import { Injectable } from '@nestjs/common';

/**
 * The current instant, behind an injectable seam. Cutoff decisions depend on
 * "now", and the plan's `MealSessionAccess` takes `now` as an argument so the
 * decision is pure and testable. Services that need the time inject this
 * instead of calling `new Date()` inline, so a test can pin "now" to a moment
 * before or after a session's window and drive the real cutoff logic.
 */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
