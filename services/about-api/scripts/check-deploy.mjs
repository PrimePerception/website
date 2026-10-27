import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function readProductionConfig() {
  const { unstable_readConfig } = await import('wrangler');
  return unstable_readConfig({ config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)) });
}

export function validateProductionConfig(config) {
  const databaseId = config?.d1_databases?.[0]?.database_id;
  if (
    config?.vars?.ENVIRONMENT !== 'production' ||
    config?.vars?.FIXTURES_ENABLED !== 'false' ||
    typeof databaseId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId) ||
    databaseId === '00000000-0000-0000-0000-000000000000'
  ) {
    throw new Error(
      'Configure the dedicated production D1 database before deployment. Local fixtures cannot be deployed.'
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateProductionConfig(await readProductionConfig());
}
