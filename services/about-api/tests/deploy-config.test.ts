import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readProductionConfig, validateProductionConfig } from '../scripts/check-deploy.mjs';

test('committed deployment configuration parses and fails for its deliberate production placeholder', async () => {
  const config = await readProductionConfig();
  assert.throws(() => validateProductionConfig(config), /dedicated production D1 database/);
});

test('deployment CLI rejects the placeholder with its actionable guard rather than a parsing failure', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-deploy.mjs', import.meta.url))], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Configure the dedicated production D1 database/);
  assert.doesNotMatch(result.stderr, /SyntaxError/);
});

test('a configured production database passes; local fixture and malformed configurations remain blocked', async () => {
  const config = await readProductionConfig();
  config.d1_databases[0].database_id = '12345678-1234-1234-1234-123456789abc';
  assert.doesNotThrow(() => validateProductionConfig(config));
  for (const change of [
    { vars: { ...config.vars, ENVIRONMENT: 'local' } },
    { vars: { ...config.vars, FIXTURES_ENABLED: 'true' } },
    { d1_databases: [{ database_id: '00000000-0000-0000-0000-000000000000' }] },
    { d1_databases: [{ database_id: '12345678----------------------------' }] },
    { d1_databases: [] },
  ]) {
    assert.throws(() => validateProductionConfig({ ...config, ...change }), /dedicated production D1 database/);
  }
});
