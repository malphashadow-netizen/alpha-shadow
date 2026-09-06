/**
 * Migration security guard (single source of truth for `tools/check-migrations.ts`
 * and `tools/migrate.ts`).
 *
 * Rules (fail closed):
 *   1. NO `DROP … CASCADE` in tracked migrations for production safety — the
 *      destructive variant is only allowed when the migration file is listed
 *      in `migrations/.cascade-approvals.json` with a human-readable reason
 *      (the tracking system). Dropping without CASCADE is still a reviewed
 *      action; this guard only protects against the recursive delete.
 *   2. Mandatory RLS template: every migration that creates a table with a
 *      `tenant_id` column MUST also contain (same file):
 *        - ALTER TABLE … ENABLE ROW LEVEL SECURITY;
 *        - ALTER TABLE … FORCE ROW LEVEL SECURITY;
 *        - CREATE POLICY tenant_isolation … FOR ALL USING (tenant_id = …) WITH CHECK (…);
 *      This mirrors test/contract/rls-coverage.test.ts and keeps the contract
 *      green from the very first PR review, not just at CI time.
 *
 * The template itself lives in migrations/README.md.
 */

export interface CascadeApproval {
  readonly file: string;
  readonly reason: string;
}

export interface MigrationViolation {
  readonly file: string;
  readonly message: string;
  readonly statement?: string;
}

const CASCACE_RE = /\bcascade\b/i;
const DROP_RE = /\bdrop\b/i;
const TENANT_ID_RE = /\btenant_id\b/i;
const CREATE_TABLE_RE = /\bcreate\s+table\b/i;
const ENABLE_RLS_RE = /\benable\s+row\s+level\s+security\b/i;
const FORCE_RLS_RE = /\bforce\s+row\s+level\s+security\b/i;
const POLICY_RE = /\bcreate\s+policy\b[\s\S]*?\btenant_isolation\b/i;

/** Removes SQL comments so doc text mentioning CASCADE/RLS never trips the guard. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function splitStatements(sql: string): string[] {
  return stripSqlComments(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function findCascadeDrops(sql: string): string[] {
  const hits: string[] = [];
  for (const statement of splitStatements(sql)) {
    if (DROP_RE.test(statement) && CASCACE_RE.test(statement)) {
      hits.push(statement);
    }
  }
  return hits;
}

export function findRlsTemplateViolations(sql: string): string[] {
  const violations: string[] = [];
  // Only a CREATE TABLE whose column list actually contains `tenant_id`
  // triggers the RLS contract — mentions in comments or other tables don't.
  const createsTenantTable = splitStatements(sql).some(
    (statement) => CREATE_TABLE_RE.test(statement) && TENANT_ID_RE.test(statement),
  );
  if (createsTenantTable) {
    const cleaned = stripSqlComments(sql);
    if (!ENABLE_RLS_RE.test(cleaned)) violations.push('table with tenant_id must ENABLE ROW LEVEL SECURITY');
    if (!FORCE_RLS_RE.test(cleaned)) violations.push('table with tenant_id must FORCE ROW LEVEL SECURITY');
    if (!POLICY_RE.test(cleaned)) violations.push('table with tenant_id must define a `tenant_isolation` FOR ALL policy');
  }
  return violations;
}

export interface ApprovalFile {
  readonly approvals: Record<string, string>;
}

export function parseApprovals(raw: string): ApprovalFile {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('migrations/.cascade-approvals.json must be a JSON object');
  }
  const record = (parsed as Record<string, unknown>)['approvals'];
  if (typeof record !== 'object' || record === null) {
    throw new Error('migrations/.cascade-approvals.json must contain an "approvals" object');
  }
  const approvals: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`migrations/.cascade-approvals.json: approval for "${key}" must be a non-empty reason string`);
    }
    approvals[key] = value;
  }
  return { approvals };
}

export interface MigrationFileCheck {
  readonly fileName: string;
  readonly sql: string;
  readonly approvals: Record<string, string>;
}

export function checkMigrationFile({ fileName, sql, approvals }: MigrationFileCheck): MigrationViolation[] {
  const violations: MigrationViolation[] = [];

  const cascadeDrops = findCascadeDrops(sql);
  if (cascadeDrops.length > 0) {
    const approvedReason = approvals[fileName];
    if (approvedReason === undefined) {
      for (const statement of cascadeDrops) {
        violations.push({
          file: fileName,
          message:
            'DROP … CASCADE is forbidden in tracked migrations without an approval. Add the file to migrations/.cascade-approvals.json with a reason (destructive + recursive delete).',
          statement,
        });
      }
    }
  }

  for (const message of findRlsTemplateViolations(sql)) {
    violations.push({ file: fileName, message });
  }

  return violations;
}
