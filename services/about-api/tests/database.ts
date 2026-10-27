import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** A real SQLite adapter for exercising the same SQL and transactional semantics as D1. */
export function testDatabase(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_workbench_reactions.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_sample_ordering_retention.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string, values: (string | number | null)[] = []) => ({
    bind: (...bindings: (string | number | null)[]) => prepare(sql, bindings),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values), success: true }),
    run: async () => {
      const result = sqlite.prepare(sql).run(...values);
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
    _execute: () => {
      const statement = sqlite.prepare(sql);
      if (/^\s*SELECT/i.test(sql)) return { results: statement.all(...values), success: true, meta: { changes: 0 } };
      const result = statement.run(...values);
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
  });
  type Statement = ReturnType<typeof prepare>;
  return {
    sqlite,
    db: {
      prepare,
      batch: async (statements: Statement[]) => {
        sqlite.exec('BEGIN');
        try {
          const results = statements.map((statement) => statement._execute());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    } as unknown as D1Database,
  };
}
