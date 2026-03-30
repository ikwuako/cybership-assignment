/**
 * UPS Rate Operation
 *
 * Implements IRateOperation for the UPS Rating API. Responsible for:
 *   1. Translating the domain RateRequest into the UPS wire format
 *   2. Authenticating and making the HTTP call
 *   3. Translating the UPS response into domain RateQuote[]
 *   4. Mapping all UPS error responses into typed AppError subclasses
 *
 * This class knows everything about UPS rate shapes and nothing about any
 * other carrier. UpsCarrierClient composes this operation.
 *
 * Reference: https://developer.ups.com/api/reference/rating/getRates
 */

import axios, { type AxiosInstance } from 'axios';
import type { IRateOperation } from '../../../domain/interfaces.js';
import type { RateRequest, RateQuote, RateResponse } from '../../../domain/models.js';
import {
  AuthError,
  CarrierError,
  NetworkError,
  ParseError,
  RateLimitError,
} from '../../../domain/errors.js';
import type { UpsAuthClient } from '../auth/UpsAuthClient.js';
import type {
  UpsRateRequest,
  UpsRateResponse,
  UpsRatedShipment,
  UpsErrorResponse,
} from '../ups.types.js';

/** UPS service code → normalised service level name */
const UPS_SERVICE_NAMES: Record<string, string> = {
  '01': 'UPS Next Day Air',
  '02': 'UPS 2nd Day Air',
  '03': 'UPS Ground',
  '07': 'UPS Worldwide Express',
  '08': 'UPS Worldwide Expedited',
  '11': 'UPS Standard',
  '12': 'UPS 3 Day Select',
  '13': 'UPS Next Day Air Saver',
  '14': 'UPS Next Day Air Early',
  '54': 'UPS Worldwide Express Plus',
  '59': 'UPS 2nd Day Air A.M.',
  '65': 'UPS Worldwide Saver',
  '93': 'UPS Sure Post',
};

/** Domain service level → UPS service code (for targeted rate requests) */
const SERVICE_LEVEL_TO_UPS_CODE: Record<string, string> = {
  ground: '03',
  express: '02',
  overnight: '01',
};

/** UPS API path and version for the Rating endpoint */
const RATING_PATH = '/api/rating/v2409/Shop';
const RATING_PATH_SINGLE = '/api/rating/v2409/Rate';

export interface UpsRateOperationConfig {
  baseUrl: string;
  timeoutMs?: number;
}

export class UpsRateOperation implements IRateOperation {
  private readonly auth: UpsAuthClient;
  private readonly http: AxiosInstance;

  constructor(auth: UpsAuthClient, config: UpsRateOperationConfig, httpClient?: AxiosInstance) {
    this.auth = auth;
    this.http =
      httpClient ??
      axios.create({
        baseURL: config.baseUrl,
        timeout: config.timeoutMs ?? 10_000,
      });
  }

  async getRates(request: RateRequest): Promise<RateResponse> {
    const token = await this.auth.getAccessToken();
    const isShop = !request.serviceLevel || request.serviceLevel === 'shop';
    const path = isShop ? RATING_PATH : RATING_PATH_SINGLE;
    const body = this.buildRequestPayload(request);

    try {
      const response = await this.http.post<UpsRateResponse>(path, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'transId': `rate-${Date.now()}`,
          'transactionSrc': 'cybership-integration',
        },
      });

      return this.parseResponse(response.data);
    } catch (err: unknown) {
      throw this.normalizeError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Request builder — domain → UPS wire format
  // ---------------------------------------------------------------------------

  private buildRequestPayload(request: RateRequest): UpsRateRequest {
    const { origin, destination, packages, serviceLevel, shipperAccountNumber } = request;

    const shipment: UpsRateRequest['RateRequest']['Shipment'] = {
      Shipper: {
        Name: 'Shipper',
        ...(shipperAccountNumber && { ShipperNumber: shipperAccountNumber }),
        Address: this.mapAddress(origin),
      },
      ShipTo: {
        Name: 'Recipient',
        Address: this.mapAddress(destination),
      },
      ShipFrom: {
        Name: 'Shipper',
        Address: this.mapAddress(origin),
      },
      Package: packages.map((pkg) => ({
        PackagingType: { Code: '02', Description: 'Customer Supplied Package' },
        PackageWeight: {
          UnitOfMeasurement: { Code: pkg.weight.unit },
          Weight: pkg.weight.value.toString(),
        },
        ...(pkg.dimensions && {
          Dimensions: {
            UnitOfMeasurement: { Code: pkg.dimensions.unit },
            Length: pkg.dimensions.length.toString(),
            Width: pkg.dimensions.width.toString(),
            Height: pkg.dimensions.height.toString(),
          },
        }),
        ...(pkg.description && { Description: pkg.description }),
      })),
    };

    // Targeted service request (non-shop mode)
    if (serviceLevel && serviceLevel !== 'shop') {
      const upsCode = SERVICE_LEVEL_TO_UPS_CODE[serviceLevel];
      if (upsCode) {
        shipment.Service = { Code: upsCode };
      }
    }

    return {
      RateRequest: {
        Request: {
          TransactionReference: { CustomerContext: 'cybership-rate-request' },
        },
        Shipment: shipment,
      },
    };
  }

  private mapAddress(address: RateRequest['origin']): import('../ups.types.js').UpsAddress {
    return {
      AddressLine: address.addressLines,
      City: address.city,
      StateProvinceCode: address.stateProvinceCode,
      PostalCode: address.postalCode,
      CountryCode: address.countryCode,
      ...(address.residential && { ResidentialAddressIndicator: '' }),
    };
  }

  // ---------------------------------------------------------------------------
  // Response mapper — UPS wire format → domain RateResponse
  // ---------------------------------------------------------------------------

  private parseResponse(raw: UpsRateResponse): RateResponse {
    if (!raw.RateResponse?.RatedShipment) {
      throw new ParseError('UPS rate response missing RatedShipment field', {
        details: raw,
      });
    }

    const shipments = Array.isArray(raw.RateResponse.RatedShipment)
      ? raw.RateResponse.RatedShipment
      : [raw.RateResponse.RatedShipment];

    const quotes: RateQuote[] = shipments.map((s) => this.mapRatedShipment(s));

    return {
      carrier: 'UPS',
      quotes,
      ratedAt: new Date().toISOString(),
    };
  }

  private mapRatedShipment(shipment: UpsRatedShipment): RateQuote {
    const serviceCode = shipment.Service?.Code ?? 'UNKNOWN';
    const serviceName =
      shipment.Service?.Description ??
      UPS_SERVICE_NAMES[serviceCode] ??
      `UPS Service ${serviceCode}`;

    // Prefer negotiated rates when available
    const totalMonetary =
      shipment.NegotiatedRateCharges?.TotalCharge ?? shipment.TotalCharges;

    const warnings = this.extractWarnings(shipment);

    // Attempt to extract transit days from TimeInTransit if present
    const estimatedDays = shipment.TimeInTransit?.ServiceSummary?.EstimatedArrival
      ?.BusinessDaysInTransit
      ? parseInt(
          shipment.TimeInTransit.ServiceSummary.EstimatedArrival.BusinessDaysInTransit,
          10,
        )
      : undefined;

    return {
      carrier: 'UPS',
      serviceCode,
      serviceName,
      totalCharge: {
        amount: parseFloat(totalMonetary.MonetaryValue),
        currency: totalMonetary.CurrencyCode,
      },
      baseCharge: {
        amount: parseFloat(shipment.TransportationCharges.MonetaryValue),
        currency: shipment.TransportationCharges.CurrencyCode,
      },
      billingWeight: {
        value: parseFloat(shipment.BillingWeight.Weight),
        unit: shipment.BillingWeight.UnitOfMeasurement.Code as 'LBS' | 'KGS',
      },
      ...(estimatedDays !== undefined && !isNaN(estimatedDays) && { estimatedDays }),
      ...(warnings.length > 0 && { warnings }),
    };
  }

  private extractWarnings(shipment: UpsRatedShipment): string[] {
    if (!shipment.RatedShipmentAlert) return [];
    const alerts = Array.isArray(shipment.RatedShipmentAlert)
      ? shipment.RatedShipmentAlert
      : [shipment.RatedShipmentAlert];
    return alerts.map((a) => `[${a.Code}] ${a.Description}`);
  }

  // ---------------------------------------------------------------------------
  // Error normalisation
  // ---------------------------------------------------------------------------

  private normalizeError(err: unknown): Error {
    if (
      err instanceof AuthError ||
      err instanceof NetworkError ||
      err instanceof ParseError ||
      err instanceof RateLimitError ||
      err instanceof CarrierError
    ) {
      return err;
    }

    if (!axios.isAxiosError(err)) {
      return new CarrierError(`Unexpected error calling UPS Rate API: ${String(err)}`, {
        cause: err,
      });
    }

    // Network/timeout — no response received
    if (!err.response) {
      const isTimeout = err.code === 'ECONNABORTED' || err.message.includes('timeout');
      return new NetworkError(
        isTimeout
          ? 'UPS Rate API request timed out'
          : `Network error calling UPS Rate API: ${err.message}`,
        { cause: err },
      );
    }

    const status = err.response.status;
    const body = err.response.data as Partial<UpsErrorResponse>;
    const carrierErrors = body?.response?.errors ?? [];
    const errorSummary =
      carrierErrors.length > 0
        ? carrierErrors.map((e) => `[${e.code}] ${e.message}`).join('; ')
        : `HTTP ${status}`;

    if (status === 401) {
      this.auth.invalidateToken();
      return new AuthError(`UPS Rate API authentication failed: ${errorSummary}`, {
        httpStatus: status,
        details: body,
        cause: err,
      });
    }

    if (status === 429) {
      const retryAfter = err.response.headers['retry-after'];
      return new RateLimitError(`UPS Rate API rate limit exceeded: ${errorSummary}`, {
        httpStatus: status,
        details: body,
        cause: err,
        retryAfterSeconds: retryAfter ? parseInt(retryAfter, 10) : undefined,
      });
    }

    if (status >= 400 && status < 500) {
      return new CarrierError(`UPS Rate API client error: ${errorSummary}`, {
        httpStatus: status,
        details: body,
        cause: err,
      });
    }

    return new CarrierError(`UPS Rate API server error: ${errorSummary}`, {
      httpStatus: status,
      details: body,
      cause: err,
    });
  }
}
