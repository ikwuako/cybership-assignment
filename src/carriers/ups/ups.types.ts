/**
 * Raw UPS Rating API TypeScript types.
 *
 * These types model the exact JSON structures documented at:
 * https://developer.ups.com/tag/Rating?loc=en_US
 *
 * They are INTERNAL to the UPS carrier module. The normalisation step in
 * UpsRateOperation.ts maps these to our clean domain types (RateQuote).
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export interface UpsCodeDescription {
  Code: string;
  Description?: string;
}

export interface UpsMonetaryValue {
  CurrencyCode: string;
  MonetaryValue: string;
}

export interface UpsUnitOfMeasurement {
  Code: string;
  Description?: string;
}

export interface UpsWeight {
  UnitOfMeasurement: UpsUnitOfMeasurement;
  Weight: string;
}

// ---------------------------------------------------------------------------
// Rate Request
// ---------------------------------------------------------------------------

export interface UpsAddress {
  AddressLine: string[];
  City: string;
  StateProvinceCode: string;
  PostalCode: string;
  CountryCode: string;
  ResidentialAddressIndicator?: string;
}

export interface UpsParty {
  Name: string;
  ShipperNumber?: string;
  Address: UpsAddress;
}

export interface UpsDimensions {
  UnitOfMeasurement: UpsUnitOfMeasurement;
  Length: string;
  Width: string;
  Height: string;
}

export interface UpsPackageRequest {
  /** 02 = customer-supplied package */
  PackagingType: UpsCodeDescription;
  Dimensions?: UpsDimensions;
  PackageWeight: UpsWeight;
  Description?: string;
}

export interface UpsShipmentRequest {
  Shipper: UpsParty;
  ShipTo: UpsParty;
  ShipFrom: UpsParty;
  /** Present only when requesting a specific service (vs. Shop mode) */
  Service?: UpsCodeDescription;
  Package: UpsPackageRequest[];
}

export interface UpsRateRequest {
  RateRequest: {
    Request: {
      TransactionReference?: {
        CustomerContext?: string;
      };
    };
    Shipment: UpsShipmentRequest;
  };
}

// ---------------------------------------------------------------------------
// Rate Response
// ---------------------------------------------------------------------------

export interface UpsRatedShipmentAlert {
  Code: string;
  Description: string;
}

export interface UpsRatedShipment {
  Service: UpsCodeDescription;
  RatedShipmentAlert?: UpsRatedShipmentAlert | UpsRatedShipmentAlert[];
  BillingWeight: UpsWeight;
  TransportationCharges: UpsMonetaryValue;
  ServiceOptionsCharges: UpsMonetaryValue;
  TotalCharges: UpsMonetaryValue;
  /** Present when account has negotiated rates */
  NegotiatedRateCharges?: {
    TotalCharge: UpsMonetaryValue;
  };
  /** Estimated delivery details — present for TimeInTransit variant */
  TimeInTransit?: {
    PickupDate?: string;
    DocumentsOnlyIndicator?: string;
    PackageBillType?: string;
    ServiceSummary?: {
      Service: UpsCodeDescription;
      EstimatedArrival?: {
        Arrival?: { Date?: string; Time?: string };
        BusinessDaysInTransit?: string;
      };
    };
  };
}

export interface UpsRateResponse {
  RateResponse: {
    Response?: {
      ResponseStatus?: UpsCodeDescription;
      TransactionReference?: { CustomerContext?: string };
    };
    RatedShipment: UpsRatedShipment | UpsRatedShipment[];
  };
}

// ---------------------------------------------------------------------------
// Error Response
// ---------------------------------------------------------------------------

export interface UpsApiError {
  code: string;
  message: string;
}

export interface UpsErrorResponse {
  response: {
    errors: UpsApiError[];
  };
}
