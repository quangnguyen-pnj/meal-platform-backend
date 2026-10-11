/**
 * Standard error response shape returned by every endpoint on failure.
 * Documented in the plan as `{ code, message, details?, requestId }`.
 */
export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
}
