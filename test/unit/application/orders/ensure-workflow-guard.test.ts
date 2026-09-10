/**
 * Audit F-D guard: `WorkflowAdminEngine.ensureWorkflow` is UNGATED by design.
 *
 * It is the bootstrap path (creates the tenant's initial workflow) with zero
 * production callers — the F-D report flags it as a residual gap, and this
 * file is the structural tripwire that keeps it visible:
 *
 *   1. the signature lock below documents that `ensureWorkflow` takes NO
 *      authorization-bearing parameter today;
 *   2. the production call-site scan fails LOUDLY if any file under `src/`
 *      ever calls `.ensureWorkflow(` — i.e. the first future production
 *      caller is caught at test time, not in review.
 *
 * If you are ADDING the gate (the intended future): extend the signature with
 * the actor, call `authorization.check('order:workflow:admin', ...)` FIRST,
 * then update the signature lock below and the F-D follow-ups in
 * docs/backlog.md. Do NOT delete this guard — repoint it at the new shape.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const SRC_ROOT = join(REPO_ROOT, 'src');
const ADMIN_ENGINE = join(SRC_ROOT, 'application/engines/orders/workflow-admin-engine.ts');

// The exact ungated signature, locked verbatim (tenant + definition only).
const UNGATED_SIGNATURE_PARAMS =
  'tenantId: string, topLevelKinds: readonly { kindCode: string; position: number; label: LocalizedText }[]';

function listTsFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('F-D ensureWorkflow guard (structural, not just runtime)', () => {
  it('locks the current signature: ensureWorkflow takes NO authorization parameter', () => {
    const source = readFileSync(ADMIN_ENGINE, 'utf8');
    const match = /async ensureWorkflow\(([^)]*)\)/.exec(source);
    expect(match, 'ensureWorkflow declaration not found in workflow-admin-engine.ts').not.toBeNull();
    expect(match?.[1]).toBe(UNGATED_SIGNATURE_PARAMS);
  });

  it('fails if ANY production file under src/ calls .ensureWorkflow(', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('.ensureWorkflow(')) offenders.push(file);
    }
    expect(
      offenders,
      'F-D GUARD TRIPPED: a production caller of the UNGATED ensureWorkflow bootstrap path was added. ' +
        'Any production use requires FIRST adding authorization.check(\'order:workflow:admin\', ...) as the first ' +
        'executable line (actorUserId + tokenSecV, sensitive context, exactly like addState/disableState/enableState/' +
        'reorderState/deleteState) — then update this guard and docs/backlog.md. Offending files listed above.',
    ).toEqual([]);
  });
});
