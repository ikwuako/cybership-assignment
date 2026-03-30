/**
 * Application configuration.
 *
 * All secrets and environment-specific values are sourced from environment
 * variables. This module validates the env at startup using Zod — if any
 * required variable is missing the application fails fast with a clear error.
 *
 * Usage:
 *   import { config } from './config/config.js';
 *   const token = await auth.getAccessToken(config.ups);
 */

import { z } from 'zod';
import { ConfigurationError } from '../domain/errors.js';

const ConfigSchema = z.object({
  ups: z.object({
    /** UPS OAuth 2.0 Client ID */
    clientId: z.string().min(1, 'UPS_CLIENT_ID is required'),
    /** UPS OAuth 2.0 Client Secret */
    clientSecret: z.string().min(1, 'UPS_CLIENT_SECRET is required'),
    /**
     * 6-digit UPS shipper account number (used in x-merchant-id header).
     * Optional — anonymous rate requests are supported by UPS.
     */
    shipperNumber: z.string().optional(),
    /**
     * Base URL for UPS APIs.
     * - Production: https://onlinetools.ups.com
     * - CIE (sandbox): https://wwwcie.ups.com  (default for non-prod environments)
     */
    baseUrl: z
      .string()
      .url()
      .default(
        process.env.NODE_ENV === 'production'
          ? 'https://onlinetools.ups.com'
          : 'https://wwwcie.ups.com',
      ),
    /** Request timeout in milliseconds. Default: 10 000 ms */
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(10_000),
  }),
  /** Runtime environment */
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Parse and validate configuration from environment variables.
 * Throws ConfigurationError if required variables are missing or invalid.
 */
function loadConfig(): AppConfig {
  const raw = {
    ups: {
      clientId: process.env['UPS_CLIENT_ID'],
      clientSecret: process.env['UPS_CLIENT_SECRET'],
      shipperNumber: process.env['UPS_SHIPPER_NUMBER'],
      baseUrl: process.env['UPS_BASE_URL'],
      timeoutMs: process.env['UPS_TIMEOUT_MS']
        ? parseInt(process.env['UPS_TIMEOUT_MS'], 10)
        : undefined,
    },
    nodeEnv: process.env['NODE_ENV'],
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigurationError(
      `Invalid configuration — check your environment variables:\n${issues}`,
      { details: result.error.issues },
    );
  }

  return result.data;
}

/**
 * Validated application configuration singleton.
 *
 * Exported as a lazy getter so tests can manipulate process.env before
 * importing this module, or use the `createConfig()` factory directly.
 */
let _config: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/** For testing — create a config from explicit values instead of process.env */
export function createConfig(overrides: Partial<AppConfig>): AppConfig {
  const base = ConfigSchema.parse({
    ups: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      baseUrl: 'https://wwwcie.ups.com',
      timeoutMs: 5000,
    },
    nodeEnv: 'test',
  });
  return { ...base, ...overrides };
}

/** Reset the config singleton — useful in tests that mutate process.env */
export function resetConfig(): void {
  _config = undefined;
}
