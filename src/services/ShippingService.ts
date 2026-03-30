/**
 * ShippingService — Application-level orchestration layer.
 *
 * Maintains a registry of ICarrierClient implementations and dispatches
 * rate requests to one or more carriers. Callers (CLI, HTTP handlers, etc.)
 * interact only with this service — they never touch carrier-specific code.
 *
 * Adding a new carrier:
 *   1. Implement ICarrierClient (e.g. FedExCarrierClient)
 *   2. Register it: service.registerCarrier(new FedExCarrierClient(config))
 *   Done. No other code changes required.
 */

import type { ICarrierClient } from '../domain/interfaces.js';
import type { RateRequest, RateResponse } from '../domain/models.js';
import { RateRequestSchema } from '../domain/models.js';
import { ValidationError, CarrierError } from '../domain/errors.js';

export interface RateShoppingResult {
  /** Successful rate responses, keyed by carrier ID */
  results: Map<string, RateResponse>;
  /** Errors per carrier — partial failures don't block successful carriers */
  errors: Map<string, Error>;
}

export class ShippingService {
  private readonly carriers = new Map<string, ICarrierClient>();

  /**
   * Register a carrier with the service.
   * If a carrier with the same carrierId is already registered, it is replaced.
   */
  registerCarrier(carrier: ICarrierClient): void {
    this.carriers.set(carrier.carrierId, carrier);
  }

  /**
   * Retrieve a registered carrier by its ID, or undefined if not registered.
   */
  getCarrier(carrierId: string): ICarrierClient | undefined {
    return this.carriers.get(carrierId);
  }

  /**
   * List all registered carrier IDs.
   */
  listCarriers(): string[] {
    return Array.from(this.carriers.keys());
  }

  /**
   * Fetch rates from a specific carrier.
   *
   * @throws ValidationError if the request fails domain validation
   * @throws CarrierError | AuthError | NetworkError | RateLimitError from the carrier
   */
  async getRates(carrierId: string, request: RateRequest): Promise<RateResponse> {
    this.validateRequest(request);

    const carrier = this.carriers.get(carrierId);
    if (!carrier) {
      throw new CarrierError(`Carrier "${carrierId}" is not registered`, {
        details: { registered: this.listCarriers() },
      });
    }

    return carrier.getRates(request);
  }

  /**
   * Fetch rates from ALL registered carriers in parallel.
   *
   * Uses allSettled so a failure from one carrier does not prevent results
   * from others. The caller can inspect `errors` to handle partial failures.
   *
   * @throws ValidationError if the request fails domain validation (before any calls)
   */
  async shopRates(request: RateRequest): Promise<RateShoppingResult> {
    this.validateRequest(request);

    if (this.carriers.size === 0) {
      throw new CarrierError('No carriers are registered in ShippingService');
    }

    const entries = Array.from(this.carriers.entries());
    const settled = await Promise.allSettled(
      entries.map(([, carrier]) => carrier.getRates(request)),
    );

    const result: RateShoppingResult = {
      results: new Map(),
      errors: new Map(),
    };

    for (let i = 0; i < entries.length; i++) {
      const [carrierId] = entries[i]!;
      const outcome = settled[i]!;

      if (outcome.status === 'fulfilled') {
        result.results.set(carrierId, outcome.value);
      } else {
        result.errors.set(
          carrierId,
          outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)),
        );
      }
    }

    return result;
  }

  /**
   * Run health checks on all registered carriers in parallel.
   */
  async healthCheckAll(): Promise<Map<string, { healthy: boolean; message?: string }>> {
    const checks = await Promise.all(
      Array.from(this.carriers.entries()).map(async ([id, carrier]) => {
        const result = await carrier.healthCheck();
        return [id, result] as const;
      }),
    );
    return new Map(checks);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private validateRequest(request: RateRequest): void {
    const result = RateRequestSchema.safeParse(request);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ValidationError(`Invalid rate request: ${issues}`, {
        details: result.error.issues,
      });
    }
  }
}
