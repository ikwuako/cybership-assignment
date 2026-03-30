/**
 * TypeScript shapes for the raw UPS OAuth 2.0 API.
 * These types match the UPS Developer Portal documentation exactly.
 * They should NEVER be exposed outside the UPS infrastructure module.
 */

/** Successful token response from POST /security/v1/oauth/token */
export interface UpsTokenResponse {
  token_type: string;
  issued_at: string;
  client_id: string;
  access_token: string;
  scope: string;
  /** Lifetime of the token in seconds (returned as a string by UPS) */
  expires_in: string;
  refresh_count: string;
  status: string;
}

/** An in-flight cached token with pre-computed expiry */
export interface CachedToken {
  accessToken: string;
  /** Unix timestamp (ms) after which the token should be considered expired */
  expiresAt: number;
}
