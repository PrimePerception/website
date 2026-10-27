import { writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// This script exclusively addresses Wrangler's isolated local database/configuration.
const minute = 60_000;
const latest = Math.floor(Date.now() / minute) * minute;
const start = latest - 2 * 24 * 60 * minute;
const samples = [];
for (let at = start; at <= latest; at += minute) {
  const position = (at - start) / minute;
  const unavailable = position % 337 >= 320 && position % 337 <= 328;
  const percent = unavailable
    ? 'NULL'
    : Math.max(0, Math.min(100, 43 + 31 * Math.sin(position / 58) + 16 * Math.cos(position / 17))).toFixed(1);
  samples.push(`(${at},${percent},${at})`);
}
// D1 limits individual SQL statement size; keep each fixture INSERT well below that bound.
const inserts = [];
for (let offset = 0; offset < samples.length; offset += 200) {
  inserts.push(
    `INSERT INTO workbench_samples(minute, utilization_percent, collected_at) VALUES ${samples.slice(offset, offset + 200).join(',')};`
  );
}
const file = new URL('../local-fixtures.sql', import.meta.url);
await writeFile(
  file,
  `
DELETE FROM workbench_samples;
${inserts.join('\n')}
UPDATE workbench_meta SET tracking_started_at=${start}, last_success_at=${latest}, last_attempt_at=${latest} WHERE singleton=1;
DELETE FROM reaction_events;
UPDATE reaction_totals SET total=CASE kind WHEN 'gg' THEN 42 WHEN 'touch-grass' THEN 7 WHEN 'shower' THEN 3 ELSE 9 END;
`
);
try {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'ABOUT_DB',
      '--local',
      '--config',
      'wrangler.local.jsonc',
      '--file',
      file.pathname,
    ],
    { stdio: 'inherit', cwd: new URL('..', import.meta.url) }
  );
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await unlink(file).catch(() => {});
}
