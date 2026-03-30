/**
 * Integration tests: ShippingService
 *
 * Tests the application-layer orchestration:
 *   - Input validation (ValidationError before any HTTP call)
 *   - Single-carrier rate dispatch
 *   - Multi-carrier rate shopping (allSettled, partial failures)
 *   - Carrier registry management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import axios from 'axios';
import { ShippingService } from '../../src/services/ShippingService.js';
import { UpsCarrierClient } from '../../src/carriers/ups/UpsCarrierClient.js';
import { ValidationError, CarrierError } from '../../src/domain/errors.js';
import type { RateRequest } from '../../src/domain/models.js';
import authSuccess from '../fixtures/ups-auth-success.json';
import rateShopSuccess from '../fixtures/ups-rate-shop-success.json';

const BASE_URL = 'https://wwwcie.ups.com';
const TOKEN_PATH = '/security/v1/oauth/token';
const SHOP_PATH = '/api/rating/v2409/Shop';

const VALID_REQUEST: RateRequest = {
  origin: {
    addressLines: ['1 Infinite Loop'],
    city: 'Cupertino',
    stateProvinceCode: 'CA',
    postalCode: '95014',
    countryCode: 'US',
  },
  destination: {
    addressLines: ['1600 Amphitheatre Pkwy'],
    city: 'Mountain View',
    stateProvinceCode: 'CA',
    postalCode: '94043',
    countryCode: 'US',
  },
  packages: [
    { weight: { value: 5, unit: 'LBS' } },
  ],
  serviceLevel: 'shop',
};

function makeUpsClient() {
  return new UpsCarrierClient({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    baseUrl: BASE_URL,
    timeoutMs: 5000,
  });
}

beforeEach(() => nock.cleanAll());
afterEach(() => nock.cleanAll());

describe('ShippingService', () => {
  // ─── Carrier Registry ─────────────────────────────────────────────────────

  describe('carrier registry', () => {
    it('registers and retrieves a carrier by ID', () => {
      const service = new ShippingService();
      const ups = makeUpsClient();
      service.registerCarrier(ups);

      expect(service.getCarrier('UPS')).toBe(ups);
      expect(service.listCarriers()).toEqual(['UPS']);
    });

    it('replaces an existing carrier when registering with the same ID', () => {
      const service = new ShippingService();
      const ups1 = makeUpsClient();
      const ups2 = makeUpsClient();

      service.registerCarrier(ups1);
      service.registerCarrier(ups2);

      expect(service.getCarrier('UPS')).toBe(ups2);
      expect(service.listCarriers()).toHaveLength(1);
    });

    it('returns undefined for an unregistered carrier', () => {
      const service = new ShippingService();
      expect(service.getCarrier('FEDEX')).toBeUndefined();
    });
  });

  // ─── Input Validation ─────────────────────────────────────────────────────

  describe('input validation', () => {
    it('throws ValidationError (before any HTTP call) when packages array is empty', async () => {
      const service = new ShippingService();
      service.registerCarrier(makeUpsClient());

      const invalid = { ...VALID_REQUEST, packages: [] };

      await expect(service.getRates('UPS', invalid as RateRequest)).rejects.toThrow(
        ValidationError,
      );

      // No HTTP calls should have been made
      expect(nock.activeMocks()).toHaveLength(0);
    });

    it('throws ValidationError when origin countryCode is too long', async () => {
      const service = new ShippingService();
      service.registerCarrier(makeUpsClient());

      const invalid = {
        ...VALID_REQUEST,
        origin: { ...VALID_REQUEST.origin, countryCode: 'USA' }, // must be 2-char
      };

      await expect(service.getRates('UPS', invalid as RateRequest)).rejects.toThrow(
        ValidationError,
      );
    });

    it('throws ValidationError when package weight is negative', async () => {
      const service = new ShippingService();
      service.registerCarrier(makeUpsClient());

      const invalid = {
        ...VALID_REQUEST,
        packages: [{ weight: { value: -1, unit: 'LBS' as const } }],
      };

      await expect(service.getRates('UPS', invalid)).rejects.toThrow(ValidationError);
    });

    it('ValidationError contains structured issue details', async () => {
      const service = new ShippingService();
      service.registerCarrier(makeUpsClient());

      const invalid = { ...VALID_REQUEST, packages: [] };

      try {
        await service.getRates('UPS', invalid as RateRequest);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        const ve = err as ValidationError;
        expect(ve.code).toBe('VALIDATION_ERROR');
        expect(ve.details).toBeDefined();
      }
    });
  });

  // ─── Single Carrier Rates ─────────────────────────────────────────────────

  describe('getRates() — single carrier', () => {
    it('dispatches to the correct carrier and returns normalized quotes', async () => {
      nock(BASE_URL).post(TOKEN_PATH).reply(200, authSuccess);
      nock(BASE_URL).post(SHOP_PATH).reply(200, rateShopSuccess);

      const service = new ShippingService();
      service.registerCarrier(makeUpsClient());

      const response = await service.getRates('UPS', VALID_REQUEST);

      expect(response.carrier).toBe('UPS');
      expect(response.quotes).toHaveLength(4);
      expect(response.quotes[0]!.totalCharge).toBeDefined();
    });

    it('throws CarrierError when requesting an unregistered carrier', async () => {
      const service = new ShippingService();

      await expect(service.getRates('FEDEX', VALID_REQUEST)).rejects.toThrow(CarrierError);
    });
  });

  // ─── Multi-Carrier Rate Shopping ──────────────────────────────────────────

  describe('shopRates() — all carriers', () => {
    it('returns results from all registered carriers', async () => {
      nock(BASE_URL).post(TOKEN_PATH).reply(200, authSuccess);
      nock(BASE_URL).post(SHOP_PATH).reply(200, rateShopSuccess);

      const service = new ShippingService();
      service.registerCarrier(makeUpsClient());

      const result = await service.shopRates(VALID_REQUEST);

      expect(result.results.has('UPS')).toBe(true);
      expect(result.errors.size).toBe(0);

      const upsResponse = result.results.get('UPS')!;
      expect(upsResponse.quotes).toHaveLength(4);
    });

    it('returns partial results when one carrier fails — other carriers succeed', async () => {
      // UPS succeeds
      nock(BASE_URL).post(TOKEN_PATH).reply(200, authSuccess);
      nock(BASE_URL).post(SHOP_PATH).reply(200, rateShopSuccess);

      // Mock "FedEx" — a second UPS client pointed at a different base (simulates different carrier)
      const FEDEX_URL = 'https://apis.fedex.com';
      nock(FEDEX_URL).post('/oauth/token').reply(200, authSuccess);
      nock(FEDEX_URL)
        .post('/rate/v1/rates/quotes')
        .replyWithError('FedEx service down');

      const service = new ShippingService();
      service.registerCarrier(makeUpsClient());

      // Simulate second carrier as a mock ICarrierClient
      const failingCarrier = {
        carrierId: 'FEDEX',
        displayName: 'FedEx',
        getRates: async () => { throw new Error('FedEx service down'); },
        healthCheck: async () => ({ healthy: false }),
      };
      service.registerCarrier(failingCarrier);

      const result = await service.shopRates(VALID_REQUEST);

      // UPS should succeed
      expect(result.results.has('UPS')).toBe(true);
      // FedEx should be in errors, not crashing the whole operation
      expect(result.errors.has('FEDEX')).toBe(true);
      expect(result.errors.get('FEDEX')!.message).toContain('FedEx service down');
    });

    it('throws CarrierError immediately when no carriers are registered', async () => {
      const service = new ShippingService();
      await expect(service.shopRates(VALID_REQUEST)).rejects.toThrow(CarrierError);
    });

    it('throws ValidationError before making any HTTP calls when request is invalid', async () => {
      const service = new ShippingService();
      service.registerCarrier(makeUpsClient());

      const invalid = { ...VALID_REQUEST, packages: [] };
      await expect(service.shopRates(invalid as RateRequest)).rejects.toThrow(ValidationError);
      expect(nock.activeMocks()).toHaveLength(0);
    });
  });
});
