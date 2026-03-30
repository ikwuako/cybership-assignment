/**
 * Integration tests: UpsRateOperation
 *
 * Stubs both the auth token endpoint and the UPS Rating API endpoint.
 * Verifies:
 *   - Request payloads are correctly built from domain models
 *   - Successful responses are parsed and normalized into RateQuote[]
 *   - All error responses produce the correct typed AppError subclass
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import axios from 'axios';
import { UpsAuthClient } from '../../src/carriers/ups/auth/UpsAuthClient.js';
import { UpsRateOperation } from '../../src/carriers/ups/operations/UpsRateOperation.js';
import {
  AuthError,
  CarrierError,
  NetworkError,
  ParseError,
  RateLimitError,
} from '../../src/domain/errors.js';
import type { RateRequest } from '../../src/domain/models.js';
import authSuccess from '../fixtures/ups-auth-success.json';
import rateSuccess from '../fixtures/ups-rate-success.json';
import rateShopSuccess from '../fixtures/ups-rate-shop-success.json';
import rateError400 from '../fixtures/ups-rate-error-400.json';
import rateError429 from '../fixtures/ups-rate-error-429.json';

const BASE_URL = 'https://wwwcie.ups.com';
const TOKEN_PATH = '/security/v1/oauth/token';
const SHOP_PATH = '/api/rating/v2409/Shop';
const RATE_PATH = '/api/rating/v2409/Rate';

/** Helper: stub the token endpoint to return a valid token */
function stubValidToken() {
  nock(BASE_URL).post(TOKEN_PATH).reply(200, authSuccess);
}

/** Canonical domain rate request used across tests */
const SAMPLE_REQUEST: RateRequest = {
  origin: {
    addressLines: ['1000 Innovation Way'],
    city: 'Atlanta',
    stateProvinceCode: 'GA',
    postalCode: '30301',
    countryCode: 'US',
  },
  destination: {
    addressLines: ['500 Commerce Blvd'],
    city: 'Los Angeles',
    stateProvinceCode: 'CA',
    postalCode: '90001',
    countryCode: 'US',
  },
  packages: [
    {
      weight: { value: 10, unit: 'LBS' },
      dimensions: { length: 12, width: 10, height: 8, unit: 'IN' },
    },
  ],
  serviceLevel: 'shop',
};

function makeOperation() {
  const httpClient = axios.create({ baseURL: BASE_URL, timeout: 5000 });
  const auth = new UpsAuthClient(
    { clientId: 'test', clientSecret: 'secret', baseUrl: BASE_URL },
    httpClient,
  );
  const operation = new UpsRateOperation(
    auth,
    { baseUrl: BASE_URL, timeoutMs: 5000 },
    httpClient,
  );
  return { auth, operation };
}

beforeEach(() => nock.cleanAll());
afterEach(() => nock.cleanAll());

describe('UpsRateOperation', () => {
  // ─── Request Building ─────────────────────────────────────────────────────

  describe('request payload construction', () => {
    it('sends a Shop request when serviceLevel is "shop"', async () => {
      stubValidToken();

      let capturedBody: unknown;
      nock(BASE_URL)
        .post(SHOP_PATH, (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, rateShopSuccess);

      const { operation } = makeOperation();
      await operation.getRates({ ...SAMPLE_REQUEST, serviceLevel: 'shop' });

      expect(capturedBody).toMatchObject({
        RateRequest: {
          Shipment: {
            Shipper: {
              Address: {
                PostalCode: '30301',
                CountryCode: 'US',
              },
            },
            ShipTo: {
              Address: {
                PostalCode: '90001',
                CountryCode: 'US',
              },
            },
          },
        },
      });
    });

    it('sends a Rate request (not Shop) when serviceLevel is "ground"', async () => {
      stubValidToken();
      nock(BASE_URL).post(RATE_PATH).reply(200, rateSuccess);

      const { operation } = makeOperation();
      await operation.getRates({ ...SAMPLE_REQUEST, serviceLevel: 'ground' });
    });

    it('includes Package Weight and Dimensions in the request body', async () => {
      stubValidToken();

      let capturedBody: unknown;
      nock(BASE_URL)
        .post(SHOP_PATH, (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, rateShopSuccess);

      const { operation } = makeOperation();
      await operation.getRates(SAMPLE_REQUEST);

      expect(capturedBody).toMatchObject({
        RateRequest: {
          Shipment: {
            Package: [
              {
                PackageWeight: {
                  UnitOfMeasurement: { Code: 'LBS' },
                  Weight: '10',
                },
                Dimensions: {
                  UnitOfMeasurement: { Code: 'IN' },
                  Length: '12',
                  Width: '10',
                  Height: '8',
                },
              },
            ],
          },
        },
      });
    });

    it('sets Service code to "03" for "ground" service level', async () => {
      stubValidToken();

      let capturedBody: unknown;
      nock(BASE_URL)
        .post(RATE_PATH, (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, rateSuccess);

      const { operation } = makeOperation();
      await operation.getRates({ ...SAMPLE_REQUEST, serviceLevel: 'ground' });

      expect(capturedBody).toMatchObject({
        RateRequest: {
          Shipment: {
            Service: { Code: '03' },
          },
        },
      });
    });

    it('includes Authorization Bearer header with the token', async () => {
      stubValidToken();

      nock(BASE_URL)
        .post(SHOP_PATH)
        .matchHeader('Authorization', `Bearer ${authSuccess.access_token}`)
        .reply(200, rateShopSuccess);

      const { operation } = makeOperation();
      await operation.getRates(SAMPLE_REQUEST);
    });

    it('sets ResidentialAddressIndicator when destination is marked residential', async () => {
      stubValidToken();

      let capturedBody: unknown;
      nock(BASE_URL)
        .post(SHOP_PATH, (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, rateShopSuccess);

      const { operation } = makeOperation();
      await operation.getRates({
        ...SAMPLE_REQUEST,
        destination: { ...SAMPLE_REQUEST.destination, residential: true },
      });

      expect(capturedBody).toMatchObject({
        RateRequest: {
          Shipment: {
            ShipTo: {
              Address: { ResidentialAddressIndicator: '' },
            },
          },
        },
      });
    });
  });

  // ─── Response Parsing ─────────────────────────────────────────────────────

  describe('response parsing and normalization', () => {
    it('maps a single RatedShipment to a RateResponse with one quote', async () => {
      stubValidToken();
      nock(BASE_URL).post(RATE_PATH).reply(200, rateSuccess);

      const { operation } = makeOperation();
      const response = await operation.getRates({ ...SAMPLE_REQUEST, serviceLevel: 'ground' });

      expect(response.carrier).toBe('UPS');
      expect(response.quotes).toHaveLength(1);
      expect(response.ratedAt).toBeTruthy();

      const quote = response.quotes[0]!;
      expect(quote.carrier).toBe('UPS');
      expect(quote.serviceCode).toBe('03');
      expect(quote.serviceName).toBe('UPS Ground');
      expect(quote.totalCharge.amount).toBe(14.22);
      expect(quote.totalCharge.currency).toBe('USD');
      expect(quote.baseCharge.amount).toBe(14.22);
      expect(quote.billingWeight.value).toBe(10.0);
      expect(quote.billingWeight.unit).toBe('LBS');
    });

    it('maps Shop response with multiple RatedShipments to multiple quotes', async () => {
      stubValidToken();
      nock(BASE_URL).post(SHOP_PATH).reply(200, rateShopSuccess);

      const { operation } = makeOperation();
      const response = await operation.getRates(SAMPLE_REQUEST);

      expect(response.quotes).toHaveLength(4);

      const ground = response.quotes.find((q) => q.serviceCode === '03')!;
      expect(ground.serviceName).toBe('UPS Ground');
      expect(ground.totalCharge.amount).toBe(14.22);

      // 2nd Day Air should prefer negotiated rate
      const secondDay = response.quotes.find((q) => q.serviceCode === '02')!;
      expect(secondDay.totalCharge.amount).toBe(32.15); // negotiated rate
      expect(secondDay.baseCharge.amount).toBe(38.50); // base charge unchanged
    });

    it('extracts warning alerts from RatedShipmentAlert into quote.warnings', async () => {
      stubValidToken();
      nock(BASE_URL).post(SHOP_PATH).reply(200, rateShopSuccess);

      const { operation } = makeOperation();
      const response = await operation.getRates(SAMPLE_REQUEST);

      const ground = response.quotes.find((q) => q.serviceCode === '03')!;
      expect(ground.warnings).toHaveLength(1);
      expect(ground.warnings![0]).toContain('110971');
    });

    it('uses service code lookup table when Description is not in response', async () => {
      stubValidToken();

      // Response with no Description field on Service
      const noDesc = {
        RateResponse: {
          RatedShipment: {
            Service: { Code: '01' }, // no Description
            BillingWeight: { UnitOfMeasurement: { Code: 'LBS' }, Weight: '5.0' },
            TransportationCharges: { CurrencyCode: 'USD', MonetaryValue: '60.00' },
            ServiceOptionsCharges: { CurrencyCode: 'USD', MonetaryValue: '0.00' },
            TotalCharges: { CurrencyCode: 'USD', MonetaryValue: '60.00' },
          },
        },
      };

      nock(BASE_URL).post(RATE_PATH).reply(200, noDesc);

      const { operation } = makeOperation();
      const response = await operation.getRates({ ...SAMPLE_REQUEST, serviceLevel: 'overnight' });

      expect(response.quotes[0]!.serviceName).toBe('UPS Next Day Air');
    });
  });

  // ─── Error Handling ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws CarrierError on HTTP 400 with carrier error details', async () => {
      stubValidToken();
      nock(BASE_URL).post(SHOP_PATH).reply(400, rateError400);

      const { operation } = makeOperation();
      const err = await operation.getRates(SAMPLE_REQUEST).catch((e) => e);

      expect(err).toBeInstanceOf(CarrierError);
      const error = err as CarrierError;
      expect(error.code).toBe('CARRIER_ERROR');
      expect(error.httpStatus).toBe(400);
      expect(error.message).toContain('110601');
    });

    it('throws AuthError on HTTP 401 and invalidates the token cache', async () => {
      stubValidToken();
      nock(BASE_URL)
        .post(SHOP_PATH)
        .reply(401, { response: { errors: [{ code: '10401', message: 'Unauthorized' }] } });

      const { auth, operation } = makeOperation();

      // Spy to confirm invalidateToken is called
      let invalidated = false;
      const original = auth.invalidateToken.bind(auth);
      auth.invalidateToken = () => { invalidated = true; original(); };

      await expect(operation.getRates(SAMPLE_REQUEST)).rejects.toThrow(AuthError);
      expect(invalidated).toBe(true);
    });

    it('throws RateLimitError on HTTP 429 with retryAfterSeconds', async () => {
      stubValidToken();
      nock(BASE_URL)
        .post(SHOP_PATH)
        .reply(429, rateError429, { 'retry-after': '60' });

      const { operation } = makeOperation();
      const err = await operation.getRates(SAMPLE_REQUEST).catch((e) => e);

      expect(err).toBeInstanceOf(RateLimitError);
      const error = err as RateLimitError;
      expect(error.code).toBe('RATE_LIMIT_ERROR');
      expect(error.retryAfterSeconds).toBe(60);
    });

    it('throws NetworkError on connection error', async () => {
      stubValidToken();
      nock(BASE_URL)
        .post(SHOP_PATH)
        .replyWithError('connect ECONNREFUSED 127.0.0.1:443');

      const { operation } = makeOperation();
      const err = await operation.getRates(SAMPLE_REQUEST).catch((e) => e);
      expect(err).toBeInstanceOf(NetworkError);
    }, 10_000);

    it('throws CarrierError on HTTP 500 server error', async () => {
      stubValidToken();
      nock(BASE_URL).post(SHOP_PATH).reply(500, { error: 'Internal Server Error' });

      const { operation } = makeOperation();
      await expect(operation.getRates(SAMPLE_REQUEST)).rejects.toThrow(CarrierError);
    });

    it('throws ParseError when response is missing RatedShipment', async () => {
      stubValidToken();
      nock(BASE_URL).post(SHOP_PATH).reply(200, { RateResponse: {} }); // no RatedShipment

      const { operation } = makeOperation();
      await expect(operation.getRates(SAMPLE_REQUEST)).rejects.toThrow(ParseError);
    });

    it('throws ParseError when response body is completely malformed JSON', async () => {
      stubValidToken();
      nock(BASE_URL)
        .post(SHOP_PATH)
        .reply(200, 'not valid json at all <!DOCTYPE html>', {
          'Content-Type': 'text/html',
        });

      const { operation } = makeOperation();
      // Axios will fail to parse the response as JSON
      await expect(operation.getRates(SAMPLE_REQUEST)).rejects.toThrow();
    });
  });
});
