/**
 * Typed, actionable errors. Every failure that crosses a module boundary or
 * reaches the user is a LlamactlError with a stable ErrorCode, so the CLI can
 * render it and the control plane / proxy can serialize it consistently.
 */

import type { ApiError, ErrorCode } from "./types.ts";

export class LlamactlError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;
  /** Suggested HTTP status when surfaced over the control plane / proxy. */
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, opts?: { detail?: unknown; httpStatus?: number }) {
    super(message);
    this.name = "LlamactlError";
    this.code = code;
    this.detail = opts?.detail;
    this.httpStatus = opts?.httpStatus ?? defaultStatus(code);
  }

  /** Serialize to the standard API error envelope. */
  toApiError(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail !== undefined ? { detail: this.detail } : {}),
      },
    };
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "bad_request":
      return 400;
    case "not_found":
    case "model_not_found":
    case "not_running":
      return 404;
    case "install_not_found":
    case "download_not_found":
    case "instance_not_found":
      return 404;
    case "ambiguous_model":
      return 409;
    case "already_running":
    case "instance_exists":
      return 409;
    case "missing_toolchain":
      return 422;
    case "daemon_unreachable":
      return 503;
    case "launch_failed":
    case "restart_cap_exceeded":
    case "llama_server_missing":
    case "build_failed":
    case "internal":
      return 500;
    default:
      return 500;
  }
}

/** Narrowing helper. */
export function isLlamactlError(e: unknown): e is LlamactlError {
  return e instanceof LlamactlError;
}

/** Coerce any thrown value into a LlamactlError (defaults to "internal"). */
export function toLlamactlError(e: unknown): LlamactlError {
  if (isLlamactlError(e)) return e;
  if (e instanceof Error) return new LlamactlError("internal", e.message);
  return new LlamactlError("internal", String(e));
}
