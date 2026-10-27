export function readProductionConfig(): Promise<{
  vars: Record<string, unknown>;
  d1_databases: { database_id?: string }[];
}>;
export function validateProductionConfig(config: unknown): void;
