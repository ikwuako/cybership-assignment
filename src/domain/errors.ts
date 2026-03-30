/**
 * Structured error hierarchy for the shipping carrier integration service.
 *
 * All errors returned to callers are instances of AppError or one of its
 * subclasses, ensuring consistent, actionable error information.
 */

export type ErrorCode =
  | 'AUTH_ERROR'
  | 'VALIDATION_ERROR'
  | 'NETWORK_ERROR'
  | 'RATE_LIMIT_ERROR'
  | 'PARSE_ERROR'
  | 'CARRIER_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'UNKNOWN_ERROR';

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  /** Original cause of the error, for debugging */
  cause?: unknown;
  /** Carrier-specific details (e.g. raw error body from UPS) */
  details?: unknown;
  /** HTTP status code from the carrier, if applicable */
  httpStatus?: number;
}

/**
 * Base error class. All errors thrown by this service extend AppError.
 * Callers can always rely on `.code`, `.message`, and `.details` being present.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly httpStatus?: number;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.details = options.details;
    this.httpStatus = options.httpStatus;

    // Preserve original stack when there is a cause
    if (options.cause instanceof Error && options.cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
    }
  }
}

/**
 * Authentication failure — token acquisition or refresh failed.
 * Caller should check credentials/config.
 */
export class AuthError extends AppError {
  constructor(message: string, options?: Omit<AppErrorOptions, 'code' | 'message'>) {
    super({ code: 'AUTH_ERROR', message, ...options });
  }
}

/**
 * Input validation failure — the domain model passed by the caller was invalid.
 * Thrown *before* any external HTTP call is made.
 */
export class ValidationError extends AppError {
  constructor(message: string, options?: Omit<AppErrorOptions, 'code' | 'message'>) {
    super({ code: 'VALIDATION_ERROR', message, ...options });
  }
}

/**
 * Network-level failure — timeout, connection refused, DNS failure, etc.
 */
export class NetworkError extends AppError {
  constructor(message: string, options?: Omit<AppErrorOptions, 'code' | 'message'>) {
    super({ code: 'NETWORK_ERROR', message, ...options });
  }
}

/**
 * Carrier-side rate limiting (HTTP 429).
 * Caller should back off and retry after the indicated delay.
 */
export class RateLimitError extends AppError {
  /** Number of seconds to wait before retrying, if provided by the carrier */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options?: Omit<AppErrorOptions, 'code' | 'message'> & { retryAfterSeconds?: number },
  ) {
    super({ code: 'RATE_LIMIT_ERROR', message, ...options });
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

/**
 * Response parsing failure — carrier returned malformed or unexpected JSON
 * that could not be mapped to our domain model.
 */
export class ParseError extends AppError {
  constructor(message: string, options?: Omit<AppErrorOptions, 'code' | 'message'>) {
    super({ code: 'PARSE_ERROR', message, ...options });
  }
}

/**
 * Structured error from the carrier (4xx/5xx with a parseable error body).
 * Distinct from NetworkError (transport) and ParseError (unreadable body).
 */
export class CarrierError extends AppError {
  constructor(message: string, options?: Omit<AppErrorOptions, 'code' | 'message'>) {
    super({ code: 'CARRIER_ERROR', message, ...options });
  }
}

/**
 * Service misconfiguration — required environment variable missing, etc.
 * Thrown during initialization, not at request time.
 */
export class ConfigurationError extends AppError {
  constructor(message: string, options?: Omit<AppErrorOptions, 'code' | 'message'>) {
    super({ code: 'CONFIGURATION_ERROR', message, ...options });
  }
}
