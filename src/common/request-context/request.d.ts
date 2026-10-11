import type { RequestPrincipal } from '../auth/request-principal';

// Augments Express Request with per-request context: the request id set by
// RequestIdMiddleware, and the authenticated principal set by JwtAuthGuard.
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      principal?: RequestPrincipal;
    }
  }
}

export {};
