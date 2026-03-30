/**
 * Global test setup.
 * Configures nock to disallow any real HTTP calls during tests —
 * all network activity must be explicitly stubbed.
 */
import nock from 'nock';

// Disable all real network connections in tests
nock.disableNetConnect();
