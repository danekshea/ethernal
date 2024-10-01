module.exports = {
    getAppDomain: () => process.env.APP_DOMAIN,
    getApiEndpoint:() => process.env.API_ENDPOINT,
    getDefaultPlanSlug: () => process.env.DEFAULT_PLAN_SLUG,
    getAppUrl: () => process.env.APP_URL,
    getScannerKey: (scanner) => process.env[`${scanner}_API_TOKEN`],
    getNodeEnv: () => process.env.NODE_ENV,
    getGhostApiKey: () => process.env.GHOST_API_KEY,
    getGhostEndpoint: () => process.env.GHOST_ENDPOINT,
    getMixpanelApiToken: () => process.env.MIXPANEL_API_TOKEN,
    getPm2Host: () => process.env.PM2_HOST,
    getPm2Secret: () => process.env.PM2_SECRET,
    getDemoUserId: () => process.env.DEMO_USER_ID,
    getDemoTrialSlug: () => process.env.DEMO_TRIAL_SLUG,
    getStripeSecretKey: () => process.env.STRIPE_SECRET_KEY,
    getStripeWebhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET,
    getDefaultExplorerTrialDays: () => process.env.DEFAULT_EXPLORER_TRIAL_DAYS || 7,
    getPostHogApiKey: () => process.env.POST_HOG_API_KEY,
    getPostHogApiHost: () => process.env.POST_HOG_API_HOST,
    getMaxBlockForSyncReset: () => parseInt(process.env.MAX_BLOCK_FOR_SYNC_RESET) || 10,
    getMaxContractForReset: () => parseInt(process.env.MAX_CONTRACT_FOR_RESET) || 5,
    getEncryptionKey: () => process.env.ENCRYPTION_KEY,
    getEncryptionJwtSecret: () => process.env.ENCRYPTION_JWT_SECRET,
    getQuicknodeCredentials: () => process.env.QUICKNODE_CREDENTIALS,
    getSoketiDefaultAppId: () => process.env.SOKETI_DEFAULT_APP_ID,
    getSoketiDefaultAppKey: () => process.env.SOKETI_DEFAULT_APP_KEY,
    getSoketiDefaultAppSecret: () => process.env.SOKETI_DEFAULT_APP_SECRET,
    getSoketiHost: () => process.env.SOKETI_HOST,
    getSoketiPort: () => process.env.SOKETI_PORT,
    getSoketiScheme: () => process.env.SOKETI_SCHEME,
    getSoketiUseTLS: () => process.env.SOKETI_USE_TLS,
    getDiscordFeedbackChannelWebhook: () => process.env.DISCORD_FEEDBACK_CHANNEL_WEBHOOK,
    getMaxV2DexPairsForTrial: () => process.env.MAX_V2_DEX_PAIRS_FOR_TRIAL || 20,
    getSentryDsn: () => process.env.SENTRY_DSN,
    getVersion: () => process.env.VERSION,
    getRedisUrl: () => process.env.REDIS_URL,
    getRedisFamily: () => process.env.REDIS_FAMILY,
};
