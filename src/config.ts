export interface AppConfig {
  port: number;
  redisUrl: string;
  instanceId: string;
  logLevel: string;
  keyHmacSecret: string;
  demoAuthToken: string;
  redisTimeoutMs: number;
}

function integer(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const keyHmacSecret = env.KEY_HMAC_SECRET ?? 'local-development-secret-change-me';
  if (keyHmacSecret.length < 16) throw new Error('KEY_HMAC_SECRET must be at least 16 characters');

  return {
    port: integer('PORT', env.PORT, 3000),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    instanceId: env.INSTANCE_ID ?? 'local',
    logLevel: env.LOG_LEVEL ?? 'info',
    keyHmacSecret,
    demoAuthToken: env.DEMO_AUTH_TOKEN ?? 'demo-payment-support-token',
    redisTimeoutMs: integer('REDIS_TIMEOUT_MS', env.REDIS_TIMEOUT_MS, 250),
  };
}
