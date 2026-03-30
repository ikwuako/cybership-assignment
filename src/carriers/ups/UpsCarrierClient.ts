/**
 * UPS Carrier Client
 *
 * Top-level implementation of ICarrierClient for UPS.
 * Composes UpsAuthClient and UpsRateOperation — callers only interact
 * with this class (or through ShippingService).
 *
 * To add a new UPS operation (e.g. labels, tracking):
 *   1. Create `src/carriers/ups/operations/UpsLabelOperation.ts`
 *   2. Add an optional `labelOperation` parameter to this constructor
 *   3. Add `createLabel()` to ICarrierClient and implement it here
 *   Zero changes needed in UpsRateOperation or ShippingService.
 */

import axios from 'axios';
import type { ICarrierClient } from '../../domain/interfaces.js';
import type { RateRequest, RateResponse } from '../../domain/models.js';
import { UpsAuthClient, type UpsAuthConfig } from './auth/UpsAuthClient.js';
import { UpsRateOperation } from './operations/UpsRateOperation.js';

export interface UpsCarrierConfig extends UpsAuthConfig {
  timeoutMs?: number;
}

export class UpsCarrierClient implements ICarrierClient {
  readonly carrierId = 'UPS';
  readonly displayName = 'United Parcel Service';

  private readonly auth: UpsAuthClient;
  private readonly rateOperation: UpsRateOperation;

  constructor(config: UpsCarrierConfig) {
    // Share a single Axios instance so connection pooling is maximised
    const httpClient = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs ?? 10_000,
    });

    this.auth = new UpsAuthClient(config, httpClient);
    this.rateOperation = new UpsRateOperation(
      this.auth,
      { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs },
      httpClient,
    );
  }

  async getRates(request: RateRequest): Promise<RateResponse> {
    return this.rateOperation.getRates(request);
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      // A health check for an auth-gated service validates token acquisition
      await this.auth.getAccessToken();
      return { healthy: true };
    } catch (err: unknown) {
      return {
        healthy: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
