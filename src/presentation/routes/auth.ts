/**
 * Authentication HTTP handlers — framework-agnostic.
 *
 * The handler is a pure function from a minimal request shape to a response
 * shape; any HTTP framework (node:http, Fastify, Express) adapts to it. All
 * security guarantees live here and in the engines:
 *
 *   - Schema validation (strict discriminated union) runs BEFORE any DB call;
 *     a malformed body is a uniform 400.
 *   - Every CREDENTIAL failure is the IDENTICAL 401 INVALID_CREDENTIALS —
 *     same status, same JSON body, same headers. No Retry-After, no
 *     WWW-Authenticate, no per-case header distinguishes an unknown user,
 *     wrong password, locked account, inactive account, or an existing email
 *     under a different tenant.
 *   - Rate limiting (429) and fail-closed boot (503) are the only responses
 *     allowed to differ, and neither reveals account existence/state.
 */
import { toErrorResponse } from '../../shared/errors.ts';
import type { AuthEngine } from '../../infrastructure/security/auth-composition.ts';
import { parseLoginRequest, parseRefreshRequest } from '../../application/engines/auth/request-schema.ts';

export interface HttpRequest {
  readonly method?: string;
  readonly path?: string;
  /** Parsed JSON body (already deserialised by the framework adapter). */
  readonly body?: unknown;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { readonly code: string; readonly message: string } | Record<string, unknown>;
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** The single, constant 401 shape — body AND headers. */
function invalidCredentialsResponse(): HttpResponse {
  return {
    status: 401,
    // Deliberately minimal and IDENTICAL for every credential failure.
    headers: { 'content-type': JSON_CONTENT_TYPE },
    body: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
  };
}

function jsonResponse(status: number, body: Record<string, unknown>): HttpResponse {
  return { status, headers: { 'content-type': JSON_CONTENT_TYPE }, body };
}

function errorResponse(status: number, code: string, message: string): HttpResponse {
  return jsonResponse(status, { code, message });
}

export interface AuthHandlers {
  login(req: HttpRequest): Promise<HttpResponse>;
  refresh(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * Wraps a (possibly un-booted) AuthEngine. The `engineFactory` is called once
 * lazily; if the security layer is not configured (missing secrets), it throws
 * ServiceUnavailableError and every auth route returns a constant 503 — the
 * fail-closed boot posture at the HTTP boundary.
 */
export function createAuthHandlers(engineFactory: () => AuthEngine): AuthHandlers {
  const handle = async (
    req: HttpRequest,
    run: (engine: AuthEngine) => Promise<{ status: 'ok'; accessToken: string; refreshToken: string }>,
  ): Promise<HttpResponse> => {
    let engine: AuthEngine;
    try {
      engine = engineFactory();
    } catch {
      // Fail-closed: secret/config problems never leak detail across the
      // boundary. The composition root logged the real cause server-side.
      return errorResponse(503, 'service.unavailable', 'Service temporarily unavailable');
    }

    try {
      const result = await run(engine);
      return jsonResponse(200, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        tokenType: 'Bearer',
      });
    } catch (error) {
      const mapped = toErrorResponse(error);
      // The uniform 401 MUST be exactly the constant shape/headers.
      if (mapped.status === 401 && mapped.code === 'INVALID_CREDENTIALS') {
        return invalidCredentialsResponse();
      }
      return errorResponse(mapped.status, mapped.code, mapped.message);
    }
  };

  return {
    async login(req: HttpRequest): Promise<HttpResponse> {
      // 1) Strict schema validation — NO DB call happens when the body is
      //    malformed (acceptance #2 for the PIN path; same rule for password).
      let parsed;
      try {
        parsed = parseLoginRequest(req.body);
      } catch (error) {
        const mapped = toErrorResponse(error);
        return errorResponse(mapped.status, mapped.code, mapped.message);
      }

      return handle(req, (engine) =>
        engine.login(parsed, {
          ipAddress: req.ipAddress ?? null,
          userAgent: req.userAgent ?? null,
        }),
      );
    },

    async refresh(req: HttpRequest): Promise<HttpResponse> {
      let parsed;
      try {
        parsed = parseRefreshRequest(req.body);
      } catch (error) {
        const mapped = toErrorResponse(error);
        return errorResponse(mapped.status, mapped.code, mapped.message);
      }

      return handle(req, (engine) =>
        engine.refresh(parsed, {
          ipAddress: req.ipAddress ?? null,
          userAgent: req.userAgent ?? null,
        }),
      );
    },
  };
}
