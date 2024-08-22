jest.mock('../../../lib/env', () => ({
    getNodeEnv: jest.fn(() => 'test'),
    getAppDomain: jest.fn(() => 'ethernal.com'),
    getAppUrl: jest.fn(() => 'ethernal.com'),
    getDefaultPlanSlug: jest.fn(() => 'selfhosted'),
    getApiEndpoint: jest.fn(() => 'a'),
    getScannerKey: jest.fn(() => 'key'),
    getGhostApiKey: jest.fn(),
    getGhostEndpoint: jest.fn(),
    getMixpanelApiToken: jest.fn(),
    getDemoUserId: jest.fn(() => 1),
    getStripeSecretKey: jest.fn(() => 'x'),
    getStripeWebhookSecret: jest.fn(() => '123'),
    getDemoTrialSlug: jest.fn(() => 'slug'),
    getDefaultExplorerTrialDays: jest.fn(() => 7),
    getPostHogApiKey: jest.fn(() => 'x'),
    getPostHogApiHost: jest.fn(() => 'x'),
    getMaxBlockForSyncReset: jest.fn(() => 1),
    getMaxContractForReset: jest.fn(() => 1),
    getEncryptionKey: jest.fn(() => '382A5C31A96D38E3DF430E5101E8D07D'),
    getEncryptionJwtSecret: jest.fn(() => '26F95488BA7D7E545B1B8669990739BB21A0A6D3EFB4910C0460B068BDDD3E1C'),
    getQuicknodeCredentials: jest.fn(() => 'qn'),
    getSoketiDefaultAppId: jest.fn(() => 'a'),
    getSoketiDefaultAppKey: jest.fn(() => 'a'),
    getSoketiDefaultAppSecret: jest.fn(() => 'a'),
    getSoketiHost: jest.fn(() => 'a'),
    getSoketiPort: jest.fn(() => 'a'),
    getSoketiUseTLS: jest.fn(() => 'a'),
    getSoketiScheme: jest.fn(() => 'a'),
    getRedisHost: jest.fn(() => 'a'),
    getRedisPort: jest.fn(() => 'a'),
    getRedisUsername: jest.fn(() => 'a'),
    getRedisPassword: jest.fn(() => 'a'),
    getRedisTls: jest.fn(() => 'a'),
    getRedisTlsSentinel: jest.fn(() => 'a'),
    getMaxV2DexPairsForTrial: jest.fn(() => 100),
    getSentryDsn: jest.fn(() => 'a'),
    getVersion: jest.fn(() => 'a')
}));
