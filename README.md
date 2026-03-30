# Cybership — Carrier Integration Service

A production-grade TypeScript service that integrates with the **UPS Rating API** to fetch shipping rates. Designed to be extended with additional carriers (FedEx, USPS, DHL) and additional operations (labels, tracking, address validation) without modifying existing code.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your UPS credentials (not required to run tests)

# 3. Run the test suite
npm test

# 4. Type-check
npm run type-check

# 5. Build
npm run build
```

---

## Running the Tests

```bash
npm test              # Run all integration tests (no live API needed)
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

All tests use **nock** to stub HTTP calls with realistic payloads from the UPS documentation. No API key or live network connection is required.

---

## Architecture

The service is built on **Clean Architecture** with the **Strategy/Plugin Pattern**.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Application Layer                           │
│   ShippingService                                               │
│   • Carrier registry                                            │
│   • Input validation (Zod) before any external call            │
│   • Single-carrier dispatch & multi-carrier rate shopping       │
└──────────────────────────┬──────────────────────────────────────┘
                           │ ICarrierClient interface
┌──────────────────────────▼──────────────────────────────────────┐
│                     Domain Layer                                │
│   models.ts     — RateRequest, RateQuote, Address, Package      │
│   errors.ts     — AppError class hierarchy                      │
│   interfaces.ts — ICarrierClient, IRateOperation                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ implemented by
┌──────────────────────────▼──────────────────────────────────────┐
│                   Infrastructure Layer                          │
│   UpsCarrierClient                                              │
│     ├── UpsAuthClient     (OAuth token lifecycle)               │
│     └── UpsRateOperation  (request builder + response mapper)   │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

#### 1. Plugin-based carrier architecture (`ICarrierClient`)

Every carrier implements a single interface:

```typescript
interface ICarrierClient {
  carrierId: string;
  getRates(request: RateRequest): Promise<RateResponse>;
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}
```

Adding FedEx means creating `FedExCarrierClient implements ICarrierClient` and calling `service.registerCarrier(new FedExCarrierClient(config))`. **Zero existing code changes.**

#### 2. Operation-based decomposition within a carrier

Each UPS capability (Rate, Label, Track) is a separate `Operation` class. `UpsCarrierClient` composes them. Adding a UPS label endpoint means creating `UpsLabelOperation` and adding `createLabel()` to the client — the rate operation is untouched.

#### 3. Zod for validation at the domain boundary

Input is validated with Zod *before* any HTTP call is made. Invalid requests throw a `ValidationError` immediately, never consuming an API quota call.

#### 4. Token lifecycle management

`UpsAuthClient` handles the full OAuth 2.0 client-credentials flow:
- **In-memory caching** with a 60-second expiry buffer (prevents race conditions at the token boundary)
- **Transparent refresh** — callers call `getAccessToken()` and never think about expiry
- **Forced invalidation** — a 401 from any API call triggers `invalidateToken()`, ensuring the next call fetches fresh credentials

#### 5. Structured error hierarchy

Every failure mode is a subclass of `AppError` with a typed `.code`:

| Class | Code | When Thrown |
|---|---|---|
| `AuthError` | `AUTH_ERROR` | 401, token acquisition failures |
| `ValidationError` | `VALIDATION_ERROR` | Invalid domain input (before HTTP) |
| `NetworkError` | `NETWORK_ERROR` | Timeouts, connection refused |
| `RateLimitError` | `RATE_LIMIT_ERROR` | HTTP 429, includes `retryAfterSeconds` |
| `ParseError` | `PARSE_ERROR` | Malformed/unexpected response structure |
| `CarrierError` | `CARRIER_ERROR` | Structured 4xx/5xx from carrier |
| `ConfigurationError` | `CONFIGURATION_ERROR` | Missing environment variables |

Callers can `instanceof` check any of these for fine-grained error handling.

#### 6. Multi-carrier rate shopping with graceful partial failures

`ShippingService.shopRates()` uses `Promise.allSettled` — a failure from one carrier never blocks results from others. The caller receives both a `results` map and an `errors` map.

---

## Project Structure

```
src/
├── domain/
│   ├── models.ts        # Domain types + Zod validation schemas
│   ├── errors.ts        # AppError class hierarchy
│   └── interfaces.ts    # ICarrierClient, IRateOperation (plugin contracts)
│
├── config/
│   └── config.ts        # Zod-validated env config with fast-fail on startup
│
├── carriers/
│   └── ups/
│       ├── auth/
│       │   ├── UpsAuthClient.ts        # OAuth 2.0 token lifecycle
│       │   └── UpsAuthClient.types.ts  # Raw auth API shapes
│       ├── operations/
│       │   └── UpsRateOperation.ts     # Request builder + response mapper
│       ├── UpsCarrierClient.ts         # ICarrierClient implementation
│       └── ups.types.ts                # Raw UPS API shapes (internal)
│
├── services/
│   └── ShippingService.ts   # Carrier registry + orchestration
│
└── index.ts                 # Public API barrel export

tests/
├── fixtures/                # Realistic UPS JSON payloads from docs
├── ups/
│   ├── UpsAuthClient.test.ts      # Token lifecycle tests
│   └── UpsRateOperation.test.ts   # Request/response pipeline tests
├── services/
│   └── ShippingService.test.ts    # Orchestration + validation tests
└── setup.ts                       # Disables real HTTP in tests
```

---

## Environment Variables

See [`.env.example`](.env.example) for all configurable values.

| Variable | Required | Description |
|---|---|---|
| `UPS_CLIENT_ID` | ✅ | UPS OAuth 2.0 Client ID |
| `UPS_CLIENT_SECRET` | ✅ | UPS OAuth 2.0 Client Secret |
| `UPS_SHIPPER_NUMBER` | ❌ | UPS 6-digit account number (enables negotiated rates) |
| `UPS_BASE_URL` | ❌ | API base URL (defaults to CIE sandbox in non-prod) |
| `UPS_TIMEOUT_MS` | ❌ | HTTP timeout in ms (default: 10 000) |
| `NODE_ENV` | ❌ | `development` / `test` / `production` |

---

## Usage Example

```typescript
import { ShippingService, UpsCarrierClient } from './src/index.js';

// 1. Configure and register the carrier
const service = new ShippingService();
service.registerCarrier(new UpsCarrierClient({
  clientId: process.env.UPS_CLIENT_ID!,
  clientSecret: process.env.UPS_CLIENT_SECRET!,
  baseUrl: 'https://onlinetools.ups.com',
}));

// 2. Build a domain rate request — no UPS concepts needed
const request = {
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
    { weight: { value: 10, unit: 'LBS' }, dimensions: { length: 12, width: 10, height: 8, unit: 'IN' } },
  ],
  serviceLevel: 'shop', // returns all available services
};

// 3. Get rates — auth is handled transparently
const response = await service.getRates('UPS', request);

for (const quote of response.quotes) {
  console.log(`${quote.serviceName}: $${quote.totalCharge.amount} ${quote.totalCharge.currency}`);
}
// UPS Ground: $14.22 USD
// UPS 3 Day Select: $22.85 USD
// UPS 2nd Day Air: $32.15 USD  ← negotiated rate applied
// UPS Next Day Air: $70.90 USD

// 4. Handle errors
import { ValidationError, RateLimitError, AuthError } from './src/index.js';

try {
  await service.getRates('UPS', request);
} catch (err) {
  if (err instanceof ValidationError) {
    console.error('Bad request:', err.details);
  } else if (err instanceof RateLimitError) {
    console.error(`Rate limited — retry after ${err.retryAfterSeconds}s`);
  } else if (err instanceof AuthError) {
    console.error('Check UPS credentials:', err.message);
  }
}
```

---

## What I Would Add Given More Time

### Additional UPS Operations
- **Label Purchase** (`UpsLabelOperation`) — POST /api/shipments/v2409/ship
- **Void Label** (`UpsVoidOperation`) — DELETE /api/shipments/v2409/void
- **Address Validation** (`UpsAddressValidationOperation`)
- **Tracking** (`UpsTrackOperation`) — GET /api/track/v1/details/{inquiryNumber}

All would follow the same operation pattern — zero changes to existing rate code.

### Additional Carriers
- `FedExCarrierClient` implementing `ICarrierClient`
- `UspsCarrierClient` implementing `ICarrierClient`

The registry pattern means this is literally `service.registerCarrier(new FedExCarrierClient(...))`.

### Production Hardening
- **Retry with exponential backoff** — automatically retry on `NetworkError` and `RateLimitError` (respecting `retry-after`)
- **Circuit breaker** — stop hammering a carrier that's repeatedly failing, fail-fast for a cool-down period
- **Request/response logging** — structured JSON logs (with sensitive data redacted) for every carrier call
- **Metrics** — latency, error rate, and cache-hit counters per carrier
- **Distributed token caching** — Redis-backed token cache to share across multiple service instances
- **Webhook normalization** — standardized tracking event types across carriers

### Developer Experience
- OpenAPI/JSON Schema generation from Zod schemas
- CLI demo script with dry-run output
- Docker Compose with a mock carrier server for local development

---

## Test Coverage

| Test File | What's Covered |
|---|---|
| `UpsAuthClient.test.ts` | Token acquisition, Basic Auth header, x-merchant-id header, in-memory caching (single HTTP call), token refresh after expiry, force-invalidation, 401/500/timeout errors |
| `UpsRateOperation.test.ts` | Shop vs. Rate path selection, request body structure, package dimensions, service code mapping, residential indicator, Bearer header, single/multi RatedShipment parsing, negotiated rates, warnings extraction, service name lookup, 400/401/429/500/timeout/ParseError |
| `ShippingService.test.ts` | Carrier registry CRUD, input validation (empty packages, invalid countryCode, negative weight), validation before HTTP, single-carrier dispatch, multi-carrier allSettled with partial failures, no-carriers error |
