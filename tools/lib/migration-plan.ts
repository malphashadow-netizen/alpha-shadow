/** Explicit expand/backfill/contract deployment controls; never infer countries. */
export const BRANCH_COUNTRY_CONTRACT_MIGRATION = '0013_phase6_branch_country_not_null.sql';
export const BRANCH_COUNTRY_CONFIRMATION_SETTING = 'app.phase6_branch_country_backfill_confirmed';
export interface MigrationPlanEnvironment {
  readonly MIGRATION_THROUGH?: string | undefined;
  readonly PHASE6_BRANCH_COUNTRY_BACKFILL_CONFIRMED?: string | undefined;
}

export function planMigrations(files: readonly string[], env: MigrationPlanEnvironment): string[] {
  const through = env.MIGRATION_THROUGH?.trim();
  if (through === undefined || through === '') return [...files];
  const matches = files.filter((file) => file === through || file.slice(0, 4) === through);
  if (matches.length !== 1) throw new Error('MIGRATION_THROUGH must identify exactly one existing migration');
  const last = matches[0];
  if (last === undefined) throw new Error('Migration target not found');
  return files.filter((file) => file <= last);
}

export function assertBackfillConfirmed(file: string, env: MigrationPlanEnvironment): void {
  if (file === BRANCH_COUNTRY_CONTRACT_MIGRATION && env.PHASE6_BRANCH_COUNTRY_BACKFILL_CONFIRMED !== 'true') {
    throw new Error(
      '0013 requires PHASE6_BRANCH_COUNTRY_BACKFILL_CONFIRMED=true after a verified manual branch-country backfill. ' +
      'Use MIGRATION_THROUGH=0012 for the expand deployment. No country will be inferred.',
    );
  }
}
