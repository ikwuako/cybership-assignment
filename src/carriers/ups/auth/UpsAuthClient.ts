/**
 * UPS OAuth 2.0 authentication client.
 *
 * Handles the full token lifecycle:
 *   - Acquiring a new token via the client-credentials flow
 *   - In-memory caching to avoid redundant auth calls
 *   - Transparent refresh when the cached token has (or is about to) expire
 *
 * This client is injected into UPS operation classes (UpsRateOperation, etc.)
 * so they never have to think about auth — they just call getAccessToken().
 *
 * Reference: https://developer.ups.com/api/reference/oauth/client-credentials
 */

import axios, { type AxiosInstance } from 'axios';
import { AuthError, NetworkError } from '../../../domain/errors.js';
import type { CachedToken, UpsTokenResponse } from './UpsAuthClient.types.js';

export interface UpsAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Optional UPS 6-digit account number sent as x-merchant-id header */
  shipperNumber?: string;
  baseUrl: string;
  timeoutMs?: number;
}

/**
 * Buffer in milliseconds subtracted from the token's reported expiry time.
 * This prevents edge cases where a token expires mid-request.
 */
const EXPIRY_BUFFER_MS = 60_000; // 60 seconds

export class UpsAuthClient {
  private readonly http: AxiosInstance;
  private readonly config: UpsAuthConfig;
  /** In-memory token cache. Null until first acquisition. */
  private cachedToken: CachedToken | null = null;

  constructor(config: UpsAuthConfig, httpClient?: AxiosInstance) {
    this.config = config;
    this.http =
      httpClient ??
      axios.create({
        baseURL: config.baseUrl,
        timeout: config.timeoutMs ?? 10_000,
      });
  }

  /**
   * Returns a valid OAuth 2.0 access token.
   *
   * Uses the in-memory cache if the token is still valid.
   * Transparently requests a new token if the cache is empty or expired.
   * Callers do not need to handle token lifecycle.
   */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.isTokenValid(this.cachedToken)) {
      return this.cachedToken.accessToken;
    }

    const fresh = await this.fetchNewToken();
    this.cachedToken = fresh;
    return fresh.accessToken;
  }

  /**
   * Force-invalidates the cached token.
   * Call this if an API call responds with 401 — the token may have been
   * revoked or expired slightly ahead of schedule.
   */
  invalidateToken(): void {
    this.cachedToken = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isTokenValid(token: CachedToken): boolean {
    return Date.now() < token.expiresAt;
  }

  private async fetchNewToken(): Promise<CachedToken> {
    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64');

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    };

    if (this.config.shipperNumber) {
      headers['x-merchant-id'] = this.config.shipperNumber;
    }

    try {
      const response = await this.http.post<UpsTokenResponse>(
        '/security/v1/oauth/token',
        'grant_type=client_credentials',
        { headers },
      );

      const data = response.data;

      if (!data.access_token) {
        throw new AuthError('UPS token response did not include an access_token', {
          details: data,
        });
      }

      const expiresInMs = parseInt(data.expires_in, 10) * 1000;
      const expiresAt = Date.now() + expiresInMs - EXPIRY_BUFFER_MS;

      return { accessToken: data.access_token, expiresAt };
    } catch (err: unknown) {
      // Re-throw typed errors as-is
      if (err instanceof AuthError) throw err;

      // HTTP error from UPS
      if (axios.isAxiosError(err)) {
        if (!err.response) {
          throw new NetworkError(
            `Network error fetching UPS token: ${err.message}`,
            { cause: err },
          );
        }

        const status = err.response.status;
        const body = err.response.data as Record<string, unknown>;

        throw new AuthError(
          `UPS token request failed with HTTP ${status}`,
          { httpStatus: status, details: body, cause: err },
        );
      }

      throw new AuthError(`Unexpected error fetching UPS token: ${String(err)}`, {
        cause: err,
      });
    }
  }
}
