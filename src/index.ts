/**
 * Public API barrel export.
 *
 * External consumers import from this file only — they should never need to
 * import from deep within src/carriers/ or src/domain/.
 */

// Domain models and types
export type { Address, Package, RateRequest, RateResponse, RateQuote, Money, Weight, ServiceLevel } from './domain/models.js';
export { AddressSchema, PackageSchema, RateRequestSchema, ServiceLevelSchema } from './domain/models.js';

// Error types (callers need these for instanceof checks)
export {
  AppError,
  AuthError,
  ValidationError,
  NetworkError,
  RateLimitError,
  ParseError,
  CarrierError,
  ConfigurationError,
} from './domain/errors.js';
export type { ErrorCode } from './domain/errors.js';

// Interfaces
export type { ICarrierClient, IRateOperation } from './domain/interfaces.js';

// Application service
export { ShippingService } from './services/ShippingService.js';
export type { RateShoppingResult } from './services/ShippingService.js';

// UPS carrier (the concrete implementation provided out of the box)
export { UpsCarrierClient } from './carriers/ups/UpsCarrierClient.js';
export type { UpsCarrierConfig } from './carriers/ups/UpsCarrierClient.js';

// Config helpers
export { getConfig, createConfig, resetConfig } from './config/config.js';
