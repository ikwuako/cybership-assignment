/**
 * Integration tests: UpsAuthClient
 *
 * Stubs the UPS /security/v1/oauth/token endpoint using nock.
 * Verifies the full token lifecycle: acquisition, caching, refresh, errors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import axios from 'axios';
import { UpsAuthClient } from '../../src/carriers/ups/auth/UpsAuthClient.js';
import { AuthError, NetworkError } from '../../src/domain/errors.js';
import authSuccess from '../fixtures/ups-auth-success.json';
import authError from '../fixtures/ups-auth-error.json';

const BASE_URL = 'https://wwwcie.ups.com';
const TOKEN_PATH = '/security/v1/oauth/token';

const AUTH_CONFIG = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  baseUrl: BASE_URL,
  timeoutMs: 5000,
};

// Create a dedicated axios instance per test to avoid shared state
function makeClient(overrides = {}) {
  const httpClient = axios.create({ baseURL: BASE_URL, timeout: 5000 });
  return new UpsAuthClient({ ...AUTH_CONFIG, ...overrides }, httpClient);
}

beforeEach(() => {
  nock.cleanAll();
});

afterEach(() => {
  nock.cleanAll();
});

describe('UpsAuthClient', () => {
  // ─── Token Acquisition ───────────────────────────────────────────────────

  describe('getAccessToken()', () => {
    it('acquires a new token on first call and returns the access_token string', async () => {
      nock(BASE_URL)
        .post(TOKEN_PATH, 'grant_type=client_credentials')
        .reply(200, authSuccess);

      const client = makeClient();
      const token = await client.getAccessToken();

      expect(token).toBe(authSuccess.access_token);
    });

    it('sends Basic Auth header with base64-encoded clientId:secret', async () => {
      const expected = Buffer.from('test-client-id:test-client-secret').toString('base64');

      nock(BASE_URL)
        .post(TOKEN_PATH)
        .matchHeader('Authorization', `Basic ${expected}`)
        .reply(200, authSuccess);

      const client = makeClient();
      await client.getAccessToken();
    });

    it('sends x-merchant-id header when shipperNumber is configured', async () => {
      nock(BASE_URL)
        .post(TOKEN_PATH)
        .matchHeader('x-merchant-id', '123456')
        .reply(200, authSuccess);

      const client = makeClient({ shipperNumber: '123456' });
      await client.getAccessToken();
    });

    it('sends Content-Type: application/x-www-form-urlencoded', async () => {
      nock(BASE_URL)
        .post(TOKEN_PATH)
        .matchHeader('Content-Type', /application\/x-www-form-urlencoded/)
        .reply(200, authSuccess);

      const client = makeClient();
      await client.getAccessToken();
    });
  });

  // ─── Token Caching ───────────────────────────────────────────────────────

  describe('token caching', () => {
    it('returns the cached token on subsequent calls without making a second HTTP request', async () => {
      // nock will throw if this endpoint is called more than once
      nock(BASE_URL)
        .post(TOKEN_PATH)
        .once()
        .reply(200, authSuccess);

      const client = makeClient();

      const first = await client.getAccessToken();
      const second = await client.getAccessToken();
      const third = await client.getAccessToken();

      expect(first).toBe(second);
      expect(second).toBe(third);
    });

    it('fetches a new token after invalidateToken() is called', async () => {
      const secondToken = { ...authSuccess, access_token: 'second-fresh-token' };

      nock(BASE_URL).post(TOKEN_PATH).once().reply(200, authSuccess);
      nock(BASE_URL).post(TOKEN_PATH).once().reply(200, secondToken);

      const client = makeClient();
      const first = await client.getAccessToken();

      client.invalidateToken();
      const second = await client.getAccessToken();

      expect(first).toBe(authSuccess.access_token);
      expect(second).toBe('second-fresh-token');
    });

    it('fetches a new token when the cached token has expired', async () => {
      // Return a token that expires immediately (expires_in = '0')
      // The 60s buffer means anything <= 60s is already considered expired
      const expiredToken = { ...authSuccess, expires_in: '0' };
      const freshToken = { ...authSuccess, access_token: 'fresh-token-after-expiry' };

      nock(BASE_URL).post(TOKEN_PATH).once().reply(200, expiredToken);
      nock(BASE_URL).post(TOKEN_PATH).once().reply(200, freshToken);

      const client = makeClient();

      // First call — token is fetched and cached, but already past expiry due to 0s lifetime
      const first = await client.getAccessToken();
      expect(first).toBe(authSuccess.access_token);

      // Second call — isTokenValid returns false, so a new token is fetched
      const second = await client.getAccessToken();
      expect(second).toBe('fresh-token-after-expiry');
    });
  });

  // ─── Error Handling ──────────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws AuthError on HTTP 401 with structured details', async () => {
      nock(BASE_URL).post(TOKEN_PATH).reply(401, authError);

      const client = makeClient();
      const err = await client.getAccessToken().catch((e) => e);

      expect(err).toBeInstanceOf(AuthError);
      const authErr = err as AuthError;
      expect(authErr.code).toBe('AUTH_ERROR');
      expect(authErr.httpStatus).toBe(401);
    });

    it('throws NetworkError on connection error', async () => {
      // nock replyWithError simulates a connection-level failure (ECONNREFUSED)
      nock(BASE_URL)
        .post(TOKEN_PATH)
        .replyWithError('connect ECONNREFUSED 127.0.0.1:443');

      const client = makeClient();
      const err = await client.getAccessToken().catch((e) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).code).toBe('NETWORK_ERROR');
    }, 10_000);

    it('throws AuthError on HTTP 500 server error from auth endpoint', async () => {
      nock(BASE_URL).post(TOKEN_PATH).reply(500, { error: 'Internal Server Error' });

      const client = makeClient();
      await expect(client.getAccessToken()).rejects.toThrow(AuthError);
    });

    it('throws AuthError when response is missing access_token field', async () => {
      const malformed = { token_type: 'Bearer', expires_in: '3600' };
      nock(BASE_URL).post(TOKEN_PATH).reply(200, malformed);

      const client = makeClient();
      await expect(client.getAccessToken()).rejects.toThrow(AuthError);
    });
  });
});
