/**
 * Domain models for the shipping carrier integration service.
 *
 * These types form the clean boundary between the application and any
 * carrier-specific implementation. Callers should only ever import from
 * this module — never from a carrier-specific module.
 *
 * Each domain type has a corresponding Zod schema for runtime validation.
 * The schemas are used to validate input BEFORE any external HTTP call is made.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

export const AddressSchema = z.object({
  /** Street lines, e.g. ['123 Main St', 'Suite 4'] */
  addressLines: z.array(z.string().min(1)).min(1).max(3),
  city: z.string().min(1),
  /** Two-letter state/province code, e.g. "CA", "ON" */
  stateProvinceCode: z.string().min(2).max(3),
  postalCode: z.string().min(1),
  /** ISO 3166-1 alpha-2 country code, e.g. "US", "CA" */
  countryCode: z.string().length(2),
  /** Optional residential flag — affects carrier surcharges */
  residential: z.boolean().optional(),
});

export type Address = z.infer<typeof AddressSchema>;

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

export const WeightUnitSchema = z.enum(['LBS', 'KGS']);
export const DimensionUnitSchema = z.enum(['IN', 'CM']);

export const PackageSchema = z.object({
  /** Weight of the package */
  weight: z.object({
    value: z.number().positive(),
    unit: WeightUnitSchema,
  }),
  /** Physical dimensions (all three required if any dimension is provided) */
  dimensions: z
    .object({
      length: z.number().positive(),
      width: z.number().positive(),
      height: z.number().positive(),
      unit: DimensionUnitSchema,
    })
    .optional(),
  /** Optional description used for logging/debugging */
  description: z.string().optional(),
});

export type Package = z.infer<typeof PackageSchema>;
export type WeightUnit = z.infer<typeof WeightUnitSchema>;
export type DimensionUnit = z.infer<typeof DimensionUnitSchema>;

// ---------------------------------------------------------------------------
// Service Level
// ---------------------------------------------------------------------------

/**
 * Normalised service level that abstracts over carrier-specific service codes.
 * - 'shop'      → return all available services (carrier's "shop" mode)
 * - 'ground'    → standard ground delivery
 * - 'express'   → 2–3 day air
 * - 'overnight' → next day air
 */
export const ServiceLevelSchema = z.enum(['shop', 'ground', 'express', 'overnight']);
export type ServiceLevel = z.infer<typeof ServiceLevelSchema>;

// ---------------------------------------------------------------------------
// Rate Request
// ---------------------------------------------------------------------------

export const RateRequestSchema = z.object({
  origin: AddressSchema,
  destination: AddressSchema,
  packages: z.array(PackageSchema).min(1),
  /**
   * Optional service level filter. Defaults to 'shop' (returns all services).
   */
  serviceLevel: ServiceLevelSchema.optional().default('shop'),
  /**
   * Carrier-specific shipper account number (e.g. UPS shipper number).
   * Optional — some carriers allow anonymous rate requests.
   */
  shipperAccountNumber: z.string().optional(),
});

export type RateRequest = z.infer<typeof RateRequestSchema>;

// ---------------------------------------------------------------------------
// Rate Quote (output domain model)
// ---------------------------------------------------------------------------

export interface Money {
  /** Decimal amount, e.g. 15.42 */
  amount: number;
  /** ISO 4217 currency code, e.g. "USD" */
  currency: string;
}

export interface Weight {
  value: number;
  unit: WeightUnit;
}

/**
 * A normalised rate quote returned to the caller.
 * All carrier-specific concepts (UPS service codes, raw charges, etc.) are
 * translated into this common shape before leaving the infrastructure layer.
 */
export interface RateQuote {
  /** Carrier identifier, e.g. "UPS", "FEDEX" */
  carrier: string;
  /** Carrier's raw service code, e.g. "03" for UPS Ground */
  serviceCode: string;
  /** Human-readable service name, e.g. "UPS Ground" */
  serviceName: string;
  /** Final total charge including all surcharges */
  totalCharge: Money;
  /** Base transportation charge before surcharges */
  baseCharge: Money;
  /** Billable weight used by the carrier for pricing */
  billingWeight: Weight;
  /** Estimated transit days, if available */
  estimatedDays?: number;
  /** Non-fatal informational alerts from the carrier */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Rate Response (the collection returned to callers)
// ---------------------------------------------------------------------------

export interface RateResponse {
  quotes: RateQuote[];
  /** Carrier that fulfilled this response */
  carrier: string;
  /** ISO 8601 timestamp of when the rates were fetched */
  ratedAt: string;
}
