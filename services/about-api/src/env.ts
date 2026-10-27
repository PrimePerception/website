export interface Env {
  ABOUT_DB: D1Database;
  ENVIRONMENT: 'production' | 'local';
  FIXTURES_ENABLED: string;
  ALLOWED_ORIGINS: string;
  RUNPOD_API_KEY?: string;
  VISITOR_SIGNING_SECRET?: string;
  IP_HASH_SECRET?: string;
  PUBLIC_LIMITER: RateLimit;
  WRITE_LIMITER: RateLimit;
}

export const isLocalFixture = (env: Env): boolean => env.ENVIRONMENT === 'local' && env.FIXTURES_ENABLED === 'true';

export function validConfiguration(env: Env): boolean {
  if (env.ENVIRONMENT === 'production' && env.FIXTURES_ENABLED !== 'false') return false;
  if (env.ENVIRONMENT !== 'production' && !isLocalFixture(env)) return false;
  return Boolean(
    env.VISITOR_SIGNING_SECRET &&
    env.VISITOR_SIGNING_SECRET.length >= 32 &&
    env.IP_HASH_SECRET &&
    env.IP_HASH_SECRET.length >= 32 &&
    env.VISITOR_SIGNING_SECRET !== env.IP_HASH_SECRET &&
    (env.ENVIRONMENT !== 'production' ||
      (!env.VISITOR_SIGNING_SECRET.startsWith('local-') && !env.IP_HASH_SECRET.startsWith('local-')))
  );
}
