/**
 * Carrier plugin interfaces.
 *
 * This file defines the contracts that every carrier integration must implement.
 * Adding a new carrier (FedEx, USPS, DHL) means:
 *   1. Implement ICarrierClient in a new `src/carriers/<name>/` directory.
 *   2. Register the client in ShippingService.
 *
 * No existing code changes are required.
 */

import type { RateRequest, RateResponse } from './models.js';

// ---------------------------------------------------------------------------
// Operation interfaces — one per UPS/FedEx/etc. capability
// ---------------------------------------------------------------------------

/**
 * A single, focused carrier capability (e.g. Rate, Label, Track).
 * Operations are composed into an ICarrierClient.
 *
 * This makes it easy to add a new UPS operation (e.g. UpsLabelOperation)
 * without modifying UpsRateOperation or any other existing code.
 */
export interface IRateOperation {
  /**
   * Fetch rate quote(s) for the given request.
   * Implementations are responsible for:
   *   - Translating the domain RateRequest into the carrier's wire format.
   *   - Making the HTTP call (with a valid auth token).
   *   - Translating the carrier's response into RateResponse.
   *   - Throwing a typed AppError subclass on any failure.
   */
  getRates(request: RateRequest): Promise<RateResponse>;
}

// ---------------------------------------------------------------------------
// Carrier client — the top-level plugin contract
// ---------------------------------------------------------------------------

/**
 * The plugin contract every carrier must implement.
 *
 * ShippingService holds a registry of ICarrierClient instances and dispatches
 * rate requests to the appropriate carrier(s) without knowing their internals.
 */
export interface ICarrierClient {
  /** Unique identifier for this carrier, e.g. "UPS", "FEDEX" */
  readonly carrierId: string;

  /** Human-readable name, e.g. "United Parcel Service" */
  readonly displayName: string;

  /**
   * Return rate quote(s) for the given request.
   * Delegates to the carrier's rate operation implementation.
   */
  getRates(request: RateRequest): Promise<RateResponse>;

  /**
   * Check whether this carrier client is properly configured and reachable.
   * ShippingService may call this at startup or on demand.
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}
