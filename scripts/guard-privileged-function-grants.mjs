#!/usr/bin/env node
/**
 * CI guard — keeps dangerous EXECUTE grants off the money-moving RPCs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ALTER DEFAULT PRIVILEGES` in this database grants EXECUTE on every newly
 * created function in `public` to BOTH `anon` and `authenticated`:
 *
 *   grantor supabase_admin, objtype f: postgres=X | anon=X | authenticated=X | service_role=X
 *   grantor postgres,       objtype f: postgres=X | anon=X | authenticated=X | service_role=X | sandbox_exec_...=X
 *
 * `CREATE OR REPLACE FUNCTION` preserves an existing ACL, so a revoke survives
 * it. `DROP FUNCTION` followed by `CREATE FUNCTION` does NOT — the new object
 * picks up the default ACL and `anon` silently regains EXECUTE. 179 migrations
 * in this repo use `DROP FUNCTION`, so the path is live.
 *
 * Each protected function below is SECURITY DEFINER, owned by `postgres`, has
 * no auth.uid()/has_role() gate of its own, and writes agent_advances,
 * agent_advance_ledger and the general ledger. Their only protection is the
 * grant, so the grant is what this guard defends.
 *
 * WHAT IT CHECKS (static; no database connection, runs in the Lovable build)
 *   1. The hardening migration for each function still exists and still
 *      contains its REVOKE — nobody can quietly delete the fix.
 *   2. No migration newer than that baseline GRANTs EXECUTE on a protected
 *      function to PUBLIC, anon or authenticated.
 *   3. Any newer migration that DROPs a protected function must re-apply the
 *      REVOKE in the same file. This is the DROP + CREATE regression.
 *
 * WHAT IT CANNOT CATCH
 *   DDL run outside the repo — the Supabase SQL editor, or the Lovable agent
 *   applying SQL directly. Those need a live `has_function_privilege('anon', ...)`
 *   assertion on a schedule; this guard only defends the migration path.
 *
 * Usage: node scripts/guard-privileged-function-grants.mjs [migrationsDir]
 * The optional argument exists so the guard's own fixtures can be tested; the
 * build always calls it with no arguments.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const MIGRATIONS_DIR = process.argv[2]
  ? resolve(process.argv[2])
  : join(REPO_ROOT, 'supabase', 'migrations');

/**
 * Protected functions. `baseline` is the migration that revoked the grant;
 * only migrations strictly newer than it are examined, so the historical
 * migrations that originally created these functions are not flagged.
 */
const PROTECTED = [
  {
    name: 'apply_roi_advance_recovery',
    baseline: '20260926090000',
    baselineFile: '20260926090000_restrict_advance_recovery_rpcs.sql',
    why: 'caller picks the agent AND the claimed ROI amount; nothing verifies a ROI payout occurred',
  },
  {
    name: 'collect_due_agent_advance_installment',
    baseline: '20260926090000',
    baselineFile: '20260926090000_restrict_advance_recovery_rpcs.sql',
    why: 'caller picks any agent and forces an off-schedule wallet collection',
  },
  {
    name: 'sweep_agent_advance_recovery',
    baseline: '20260926090000',
    baselineFile: '20260926090000_restrict_advance_recovery_rpcs.sql',
    why: 'takes no parameters, runs the whole book, and consumes the day’s collection slot for every advance',
  },
  {
    name: 'create_overdraft_recovery_advance',
    baseline: '20260925220000',
    baselineFile: '20260925220000_agent_advances_client_read_only.sql',
    why: 'mints an agent advance against any p_user_id with a 33% access fee, no audit row and no ledger entry',
  },
];

const DANGEROUS_GRANTEES = ['public', 'anon', 'authenticated'];

/** Strip `--` line comments and block comments so prose cannot trip the rules. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function migrationVersion(filename) {
  const m = /^(\d{14})_/.exec(filename);
  return m ? m[1] : null;
}

const errors = [];

// ---------------------------------------------------------------------------
// Rule 1 — the hardening migrations must still be present and still revoke.
// ---------------------------------------------------------------------------
for (const fn of PROTECTED) {
  const path = join(MIGRATIONS_DIR, fn.baselineFile);
  if (!existsSync(path)) {
    errors.push(
      `${fn.baselineFile} is missing — it is the migration that revokes EXECUTE on ${fn.name}() from PUBLIC/anon/authenticated. Restore it.`,
    );
    continue;
  }
  const body = stripComments(readFileSync(path, 'utf8'));
  const hasRevoke = new RegExp(
    `REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn.name}\\s*\\(`,
    'i',
  ).test(body);
  if (!hasRevoke) {
    errors.push(
      `${fn.baselineFile} no longer contains "REVOKE EXECUTE ON FUNCTION ${fn.name}(...)". That revoke is the only thing standing between an anonymous caller and this function.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rules 2 and 3 — scan every migration newer than each baseline.
// ---------------------------------------------------------------------------
const files = existsSync(MIGRATIONS_DIR)
  ? readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
  : [];

if (!files.length) {
  console.error(`[guard:function-grants] no migrations found in ${MIGRATIONS_DIR}`);
  process.exit(1);
}

for (const file of files) {
  const version = migrationVersion(file);
  if (!version) continue;

  const relevant = PROTECTED.filter((fn) => version > fn.baseline);
  if (!relevant.length) continue;

  const body = stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));

  for (const fn of relevant) {
    // Rule 2 — an explicit GRANT back to a dangerous grantee.
    const grantRe = new RegExp(
      `GRANT\\s+(?:ALL[^;]*?|EXECUTE)\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn.name}\\s*\\([^)]*\\)\\s*TO\\s+([^;]+);`,
      'gi',
    );
    for (const match of body.matchAll(grantRe)) {
      const grantees = match[1].split(',').map((g) => g.trim().toLowerCase().replace(/"/g, ''));
      const bad = grantees.filter((g) => DANGEROUS_GRANTEES.includes(g));
      if (bad.length) {
        errors.push(
          `${file} grants EXECUTE on ${fn.name}() to ${bad.join(', ')}. ` +
            `Reason it is protected: ${fn.why}. Only service_role and postgres may hold EXECUTE.`,
        );
      }
    }

    // Rule 3 — DROP FUNCTION resets the ACL to the permissive default, so the
    // same migration must re-apply the revoke.
    const dropRe = new RegExp(
      `DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?${fn.name}\\b`,
      'i',
    );
    if (dropRe.test(body)) {
      const revokeRe = new RegExp(
        `REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn.name}\\s*\\([^)]*\\)\\s*FROM\\s+([^;]+);`,
        'gi',
      );
      const covered = [...body.matchAll(revokeRe)].some((match) => {
        const from = match[1].split(',').map((g) => g.trim().toLowerCase().replace(/"/g, ''));
        return DANGEROUS_GRANTEES.every((g) => from.includes(g));
      });
      if (!covered) {
        errors.push(
          `${file} drops ${fn.name}() without re-applying the revoke. ` +
            `DROP FUNCTION resets the ACL to the schema default, which grants EXECUTE to anon AND authenticated — ` +
            `so the recreated function would be callable unauthenticated over PostgREST. ` +
            `Add to the same migration:\n` +
            `      REVOKE EXECUTE ON FUNCTION public.${fn.name}(<args>) FROM PUBLIC, anon, authenticated;`,
        );
      }
    }
  }
}

if (errors.length) {
  console.error(`[guard:function-grants] ${errors.length} violation(s):\n`);
  for (const e of errors) console.error(`  - ${e}\n`);
  console.error(
    'These functions are SECURITY DEFINER with no internal auth check. The EXECUTE grant is their only gate.',
  );
  process.exit(1);
}

console.log(
  `[guard:function-grants] ok — ${PROTECTED.length} protected functions, ${files.length} migrations scanned, no dangerous grants`,
);
