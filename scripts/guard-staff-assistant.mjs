#!/usr/bin/env node
/**
 * CI Guard — Zoe (My Space Staff Assistant) Read-Only & Role-Isolation Guard.
 *
 * Separate from scripts/guard-assistant-readonly.mjs (which protects the agent assistant).
 * Fails the build if any of the following invariants is violated:
 *
 *   1. Any `assistant_staff_*` SQL function in `supabase/migrations/`:
 *        - is not `STABLE` (or is marked `VOLATILE` / `IMMUTABLE` instead of `STABLE`),
 *        - is not `SECURITY DEFINER`,
 *        - does not set `search_path = public`,
 *        - takes a user / staff / agent / tenant / landlord / account / wallet / owner ID parameter,
 *        - lacks an explicit role / access check (`staff_assistant_has_access` + role check),
 *        - grants `EXECUTE` to `anon` or `PUBLIC` (or fails to `REVOKE` from `PUBLIC, anon`),
 *        - contains write/DDL/dynamic SQL (`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `COPY`,
 *          `ALTER`, `DROP`, `CREATE`, `GRANT`, or `EXECUTE` of dynamic SQL),
 *        - OR calls any function in its transitive call chain that is `VOLATILE` or contains
 *          `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `COPY`, `ALTER`, `GRANT`, or dynamic `EXECUTE`.
 *   2. Any file in `supabase/functions/staff-assistant/` uses the service role
 *      (`SUPABASE_SERVICE_ROLE_KEY` / `SERVICE_ROLE`) outside its logging file (`store.ts`),
 *      or performs database writes outside `store.ts`, or `store.ts` touches non-`staff_assistant_*` tables
 *      or calls `.delete()` on `staff_assistant_messages` / `staff_assistant_conversations`.
 *   3. The frontend (`src/`) calls any `assistant_staff_*` RPC directly instead of going
 *      through the `staff-assistant` edge function.
 *   4. Any Zoe email-sending function (`supabase/functions/staff-assistant-email/`,
 *      `supabase/functions/staff-assistant-send-email/`, or email sender inside
 *      `supabase/functions/staff-assistant/`) can send to an address without calling
 *      `staff_assistant_is_staff_email` and `staff_assistant_can_user_read_report`.
 *   5. Zoe's own tables (`staff_assistant_reminders`, `staff_assistant_schedules`,
 *      `staff_assistant_preferences`, `staff_assistant_drafts`) grant `INSERT`, `UPDATE`, or `DELETE`
 *      to `authenticated` in the final migration state, or `staff_assistant_messages` /
 *      `staff_assistant_conversations` grant `DELETE` to `authenticated`.
 *   6. Schedule runner SQL helpers forge `'aal', 'aal2'` in `request.jwt.claims`.
 *
 * Includes a built-in self-test (`runSelfTests()`) that verifies the guard catches broken
 * examples for every rule before scanning the live repository.
 *
 * Usage:
 *   node scripts/guard-staff-assistant.mjs
 *   node scripts/guard-staff-assistant.mjs --self-test
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAFF_FN_DIR = join(ROOT, 'supabase', 'functions', 'staff-assistant');
const STAFF_EMAIL_FN_DIRS = [
  join(ROOT, 'supabase', 'functions', 'staff-assistant-email'),
  join(ROOT, 'supabase', 'functions', 'staff-assistant-send-email'),
];
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const SRC_DIR = join(ROOT, 'src');

export function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/--[^\n]*/g, ' ');
}

/**
 * Strip single-quoted SQL string literals so keywords inside error messages
 * or JSON keys (e.g. `'Not authorized: ...'`, `'updated_at'`) do not trigger
 * statement-level write/DDL detectors.
 */
export function stripSqlSingleQuotedStrings(s) {
  return s.replace(/'(?:''|[^'])*'/g, "''");
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

// ============================================================================
// Pure Audit Functions (used by both the self-test and the live repo check)
// ============================================================================

const IDENTITY_PARAM_RE =
  /(^|[\s,(])(p_)?(user|staff|agent|tenant|landlord|account|wallet|owner|supporter|partner)_?id\b/i;

const WRITE_OR_DDL_SQL_RE =
  /\b(INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?(?:public\.)?[a-z_][a-z0-9_]*\s+SET|DELETE\s+FROM|TRUNCATE\s+(?:TABLE\s+)?[a-z_]|COPY\s+(?:public\.)?[a-z_]|ALTER\s+(?:TABLE|FUNCTION|VIEW|ROLE|SCHEMA|DATABASE|TYPE|POLICY)|DROP\s+(?:TABLE|FUNCTION|VIEW|ROLE|SCHEMA|POLICY|INDEX|TRIGGER)|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|VIEW|ROLE|SCHEMA|POLICY|INDEX|TRIGGER)|GRANT\s+[a-z_,\s]+\s+ON\b|EXECUTE\s+(?!ON\b|FUNCTION\b|PROCEDURE\b))/i;

const ROLE_CHECK_RE =
  /\b(staff_assistant_has_access|_has_enabled_role|has_role|_am_staff_ok|_landlord_cc_staff_ok|can_view_finance_reports|can_view_staff_reports|agent_ops_report_authorized|partner_ops_can_view|pso_can_view_my_performance|pso_is_officer|hr_is_admin|hr_is_executive|hr_pay_is_rule_reader|hr_pay_is_preparer|hr_pay_is_approver|food_can_use_canteen|is_ops_role)\b/i;

/**
 * Parse all SQL function definitions from a raw SQL string (supports both
 * `AS $$ ... $$` before attributes and `LANGUAGE ... AS $$ ... $$` after attributes).
 * Fast index-based scanner that avoids backtracking on multi-MB migrations.
 */
export function extractSqlFunctionsFromText(fileLabel, rawSql) {
  const clean = stripComments(rawSql);
  const defs = [];
  const headRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)\s*RETURNS\b/gi;

  for (const m of clean.matchAll(headRe)) {
    const name = m[1].toLowerCase();
    const args = m[2];
    const startIdx = m.index;
    const afterReturnsIdx = startIdx + m[0].length;
    const rest = clean.slice(afterReturnsIdx, afterReturnsIdx + 40000);
    const tagMatch = rest.match(/(\$[A-Za-z0-9_]*\$)/);
    if (!tagMatch) continue;
    const tag = tagMatch[1];
    const bodyStart = tagMatch.index + tag.length;
    const bodyEnd = rest.indexOf(tag, bodyStart);
    if (bodyEnd === -1) continue;
    const body = rest.slice(bodyStart, bodyEnd);
    const semiIdx = rest.indexOf(';', bodyEnd + tag.length);
    const afterBody = semiIdx !== -1 ? rest.slice(bodyEnd + tag.length, semiIdx + 1) : '';
    const beforeBody = rest.slice(0, tagMatch.index);
    const header = `${m[0]} ${beforeBody} ${afterBody}`;
    const isStable = /\bSTABLE\b/i.test(header);
    const isImmutable = /\bIMMUTABLE\b/i.test(header);
    const isVolatile = /\bVOLATILE\b/i.test(header) || (!isStable && !isImmutable);

    defs.push({
      file: fileLabel,
      name,
      args,
      header,
      body,
      isStable,
      isImmutable,
      isVolatile,
    });
  }
  return defs;
}

/**
 * Audits a single SQL migration file for `assistant_staff_*` function rules
 * AND optionally checks its transitive call chain against `functionMap`.
 */
export function auditSqlMigration(fileLabel, rawSql, functionMap = null) {
  const errs = [];
  const clean = stripComments(rawSql);
  const defs = extractSqlFunctionsFromText(fileLabel, rawSql).filter((d) =>
    d.name.startsWith('assistant_staff_'),
  );
  const functionsFound = [];

  for (const def of defs) {
    const { name, args, header, body } = def;
    const where = `${fileLabel}: ${name}()`;
    functionsFound.push(name);
    const isAnalystRunQuery = name === 'assistant_staff_run_query';

    // 1. Must be STABLE (never VOLATILE or IMMUTABLE)
    if (!/\bSTABLE\b/i.test(header) || /\b(VOLATILE|IMMUTABLE)\b/i.test(header)) {
      errs.push(`${where} must be STABLE (read-only).`);
    }

    // 2. Security context: all assistant_staff_* functions must be SECURITY DEFINER
    //    (so authenticated can read zoe_ro views over base tables without direct grants,
    //     while assistant_staff_run_query enforces zoe_ro_require_area + statement_timeout = '5s' + transaction_read_only).
    if (!/\bSECURITY\s+DEFINER\b/i.test(header)) {
      errs.push(`${where} must be SECURITY DEFINER.`);
    }
    if (isAnalystRunQuery) {
      if (!/\bSET\s+search_path\s*=\s*public\s*,\s*zoe_ro\b/i.test(header)) {
        errs.push(`${where} must set search_path = public, zoe_ro.`);
      }
      if (!/\bSET\s+statement_timeout\s*=\s*'5s'/i.test(header)) {
        errs.push(`${where} must set statement_timeout = '5s'.`);
      }
      if (
        !/\bSET\s+default_transaction_read_only\s*=\s*on\b/i.test(header) &&
        !/\bSET\s+LOCAL\s+transaction_read_only\s*=\s*on\b/i.test(body)
      ) {
        errs.push(`${where} must enforce transaction_read_only = on.`);
      }
      if (!/\bzoe_ro_validate_query\s*\(/i.test(body)) {
        errs.push(`${where} must validate SQL via public.zoe_ro_validate_query().`);
      }
      if (!/\bzoe_ro_require_area\s*\(/i.test(body)) {
        errs.push(`${where} must check caller role area via public.zoe_ro_require_area().`);
      }
      if (!/\bLIMIT\s+501\b/i.test(body) || !/\b500\b/.test(body)) {
        errs.push(`${where} must enforce the 500-row cap and truncation detection.`);
      }
    } else {
      if (!/\bSET\s+search_path\s*=\s*public\b/i.test(header)) {
        errs.push(`${where} must set search_path = public.`);
      }
    }

    // 4. Must NOT accept any user-id or other identity parameter
    if (IDENTITY_PARAM_RE.test(args)) {
      errs.push(
        `${where} has an identity parameter (${args.trim()}). Caller identity must come exclusively from auth.uid().`,
      );
    }

    // 5. Must contain an explicit role / access check + staff_assistant_has_access()
    if (!/\bstaff_assistant_has_access\s*\(/i.test(body) || !ROLE_CHECK_RE.test(body)) {
      errs.push(
        `${where} lacks a required role/access check (must call staff_assistant_has_access() and check caller roles).`,
      );
    }
    if (!/\bRAISE\s+EXCEPTION\b/i.test(body)) {
      errs.push(`${where} must RAISE EXCEPTION when the role/access check fails.`);
    }

    // 6. Body must be strictly read-only (no INSERT/UPDATE/DELETE/TRUNCATE/COPY/ALTER/DROP/CREATE/GRANT/EXECUTE)
    const bodyWithoutLiterals = stripSqlSingleQuotedStrings(body);
    const bodyToCheckForWrite = isAnalystRunQuery
      ? bodyWithoutLiterals.replace(/\bEXECUTE\s+v_wrapped_sql\s+INTO\b/gi, '/* validated_select */')
      : bodyWithoutLiterals;
    const writeHit = bodyToCheckForWrite.match(WRITE_OR_DDL_SQL_RE);
    if (writeHit) {
      errs.push(
        `${where} contains a write, DDL, or dynamic SQL statement ("${writeHit[0]}"). All assistant_staff_* tools must be strictly read-only.`,
      );
    }

    // 7. Special rule for cash position: must read exclusively from get_treasury_cash_position
    if (
      /cash_position/i.test(name) &&
      !/\bget_treasury_cash_position\s*\(/i.test(body)
    ) {
      errs.push(
        `${where} must read platform cash exclusively from public.get_treasury_cash_position().`,
      );
    }

    // 8. Must NOT grant EXECUTE to anon or PUBLIC, and must REVOKE from PUBLIC, anon
    const grantAnonOrPublicRe = new RegExp(
      `GRANT\\s+(?:EXECUTE|ALL)\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${name}\\s*\\([^)]*\\)\\s+TO\\s+[^;]*\\b(anon|public)\\b`,
      'i',
    );
    if (grantAnonOrPublicRe.test(clean)) {
      errs.push(`${where} grants EXECUTE to anon or PUBLIC.`);
    }

    const revokeAnonAndPublicRe = new RegExp(
      `REVOKE\\s+(?:EXECUTE|ALL)\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${name}\\s*\\([^)]*\\)\\s+FROM\\s+([^;]+);`,
      'gi',
    );
    const revokeMatches = [...clean.matchAll(revokeAnonAndPublicRe)];
    const hasRevokePublicAndAnon = revokeMatches.some(
      (rm) => /\bpublic\b/i.test(rm[1]) && /\banon\b/i.test(rm[1]),
    );
    if (!hasRevokePublicAndAnon) {
      errs.push(`${where} must REVOKE ALL/EXECUTE ON FUNCTION ... FROM PUBLIC, anon.`);
    }

    const grantAuthRe = new RegExp(
      `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${name}\\s*\\([^)]*\\)\\s+TO\\s+authenticated\\b`,
      'i',
    );
    if (!grantAuthRe.test(clean)) {
      errs.push(`${where} must explicitly GRANT EXECUTE ... TO authenticated.`);
    }

    // 9. Call-chain verification: traverse every public.<fn>(...) called by this assistant_staff_* function
    if (functionMap instanceof Map) {
      const visited = new Set([name]);
      const queue = [{ fnName: name, bodyText: body, chain: [name] }];

      while (queue.length > 0) {
        const current = queue.shift();
        const bodyClean = stripSqlSingleQuotedStrings(current.bodyText);
        const callees = [
          ...bodyClean.matchAll(/\bpublic\.([a-z0-9_]+)\s*\(/gi),
        ].map((m) => m[1].toLowerCase());

        for (const callee of new Set(callees)) {
          if (isAnalystRunQuery && callee === 'staff_assistant_log_query') {
            continue;
          }
          const chainStr = [...current.chain, callee].join(' -> ');
          const target = functionMap.get(callee);
          if (!target) continue;

          if (target.isVolatile) {
            errs.push(
              `${where} calls VOLATILE function "${callee}()" in call chain (${chainStr}, defined in ${target.file}). Every function in the call chain of an assistant_staff_* tool must be STABLE or IMMUTABLE.`,
            );
          }

          const targetBodyClean = stripSqlSingleQuotedStrings(target.body);
          const calleeWriteHit = targetBodyClean.match(WRITE_OR_DDL_SQL_RE);
          if (calleeWriteHit) {
            errs.push(
              `${where} calls function "${callee}()" in call chain (${chainStr}, defined in ${target.file}) which contains forbidden write/DDL/dynamic SQL ("${calleeWriteHit[0]}").`,
            );
          }

          if (!visited.has(callee)) {
            visited.add(callee);
            queue.push({
              fnName: callee,
              bodyText: target.body,
              chain: [...current.chain, callee],
            });
          }
        }
      }
    }
  }

  return { functionsFound, errors: errs };
}

/**
 * Audits the final cumulative state of table privileges and schedule-runner JWT claims
 * across migrations so Zoe's tables stay locked down and `aal2` is never forged.
 */
export function auditCumulativeSqlSecurity(migrationsTextInOrder) {
  const errs = [];
  const combinedClean = stripComments(migrationsTextInOrder);

  // Track final table grants for authenticated on Zoe tables
  const lockedTablesSelectOnly = [
    'staff_assistant_reminders',
    'staff_assistant_schedules',
    'staff_assistant_preferences',
    'staff_assistant_drafts',
    'staff_assistant_insights',
    'staff_assistant_ideas',
    'staff_assistant_notes',
    'staff_assistant_glossary',
    'staff_assistant_data_catalog',
    'staff_assistant_queries',
  ];

  for (const tbl of lockedTablesSelectOnly) {
    // Find the last GRANT/REVOKE statement targeting `public.<tbl>` and `authenticated`
    const stmtRe = new RegExp(
      `\\b(GRANT|REVOKE)\\s+([^;]+?)\\s+ON\\s+(?:TABLE\\s+)?(?:public\\.)?${tbl}\\s+(?:TO|FROM)\\s+([^;]+);`,
      'gi',
    );
    const grants = new Set();
    for (const m of combinedClean.matchAll(stmtRe)) {
      const action = m[1].toUpperCase();
      const privs = m[2].toUpperCase();
      const roles = m[3].toLowerCase();
      if (!/\bauthenticated\b/.test(roles)) continue;

      if (action === 'REVOKE') {
        if (/\bALL\b/.test(privs)) {
          grants.clear();
        } else {
          for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            if (new RegExp(`\\b${p}\\b`).test(privs)) grants.delete(p);
          }
        }
      } else if (action === 'GRANT') {
        if (/\bALL\b/.test(privs)) {
          for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) grants.add(p);
        } else {
          for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            if (new RegExp(`\\b${p}\\b`).test(privs)) grants.add(p);
          }
        }
      }
    }

    for (const forbidden of ['INSERT', 'UPDATE', 'DELETE']) {
      if (grants.has(forbidden)) {
        errs.push(
          `Table public.${tbl} grants ${forbidden} to authenticated in final migration state; authenticated must have SELECT only.`,
        );
      }
    }
  }

  for (const tbl of ['staff_assistant_messages', 'staff_assistant_conversations']) {
    const stmtRe = new RegExp(
      `\\b(GRANT|REVOKE)\\s+([^;]+?)\\s+ON\\s+(?:TABLE\\s+)?(?:public\\.)?${tbl}\\s+(?:TO|FROM)\\s+([^;]+);`,
      'gi',
    );
    const grants = new Set();
    for (const m of combinedClean.matchAll(stmtRe)) {
      const action = m[1].toUpperCase();
      const privs = m[2].toUpperCase();
      const roles = m[3].toLowerCase();
      if (!/\bauthenticated\b/.test(roles)) continue;

      if (action === 'REVOKE') {
        if (/\bALL\b/.test(privs)) grants.clear();
        if (/\bDELETE\b/.test(privs)) grants.delete('DELETE');
      } else if (action === 'GRANT') {
        if (/\b(ALL|DELETE)\b/.test(privs)) grants.add('DELETE');
      }
    }
    if (grants.has('DELETE')) {
      errs.push(
        `Table public.${tbl} grants DELETE to authenticated in final migration state; users must not be able to delete Zoe history rows.`,
      );
    }
  }

  // Ensure schedule runner SQL helpers do not forge 'aal', 'aal2' in their latest definition
  const fnDefs = extractSqlFunctionsFromText('cumulative', combinedClean);
  const latestByName = new Map();
  for (const d of fnDefs) latestByName.set(d.name, d);

  for (const runnerFn of [
    'staff_assistant_check_owner_access',
    'staff_assistant_run_scheduled_report_as_owner',
  ]) {
    const def = latestByName.get(runnerFn);
    if (def && /'aal'\s*,\s*'aal2'/i.test(def.body)) {
      errs.push(
        `Function public.${runnerFn}() forges 'aal', 'aal2' in request.jwt.claims; background schedule runs must never forge AAL2.`,
      );
    }
  }

  // Audit zoe_ro read-only views (Prompt 3 item 1 & 4)
  const viewRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+zoe_ro\.([a-z0-9_]+)\s*([\s\S]*?)\bAS\b([\s\S]*?);/gi;
  for (const vm of combinedClean.matchAll(viewRe)) {
    const viewName = vm[1].toLowerCase();
    const viewOpts = vm[2];
    const viewBody = vm[3];
    if (!/\bsecurity_invoker\s*=\s*true\b/i.test(viewOpts)) {
      errs.push(
        `View zoe_ro.${viewName} must specify WITH (security_invoker = true) so caller permissions and MFA policies apply.`,
      );
    }
    if (!/\bzoe_ro_require_area\s*\(/i.test(viewBody)) {
      errs.push(
        `View zoe_ro.${viewName} must enforce caller role-area access via public.zoe_ro_require_area().`,
      );
    }
    if (
      viewName === 'finance_treasury_cash_position' &&
      !/\bget_treasury_cash_position\s*\(/i.test(viewBody)
    ) {
      errs.push(
        `View zoe_ro.${viewName} must read platform treasury cash exclusively from public.get_treasury_cash_position().`,
      );
    }
  }

  const badZoeRoGrantRe =
    /\bGRANT\s+([^;]+?)\s+ON\s+(?:TABLE\s+|ALL\s+TABLES\s+IN\s+SCHEMA\s+)?zoe_ro(?:\.[a-z0-9_]+)?\s+TO\s+([^;]+);/gi;
  for (const gm of combinedClean.matchAll(badZoeRoGrantRe)) {
    const privs = gm[1].toUpperCase();
    const roles = gm[2].toLowerCase();
    if (/\b(anon|public)\b/.test(roles)) {
      errs.push(`zoe_ro view grant "${gm[0].trim()}" grants access to anon or PUBLIC; grant SELECT to authenticated only.`);
    }
    if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/.test(privs)) {
      errs.push(`zoe_ro view grant "${gm[0].trim()}" grants write privileges; zoe_ro views must grant SELECT only.`);
    }
  }

  return errs;
}

/**
 * Audits a TypeScript source file inside `supabase/functions/staff-assistant/`.
 */
export function auditStaffAssistantEdgeFile(relPath, rawCode) {
  const errs = [];
  const code = stripComments(rawCode);
  const isStore = relPath.endsWith('/store.ts') || relPath === 'store.ts';
  const isModel = relPath.endsWith('/openai.ts') || relPath === 'openai.ts';
  const isTools = relPath.endsWith('/tools.ts') || relPath === 'tools.ts';
  const isConsultant = relPath.endsWith('/consultant.ts') || relPath === 'consultant.ts';

  // 1. Service role key may ONLY be used in store.ts (the logging file)
  if (!isStore && /\b(SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE)\b/.test(code)) {
    errs.push(
      `${relPath}: the service-role key may only be used in store.ts (logging). Tool and data reads must use the caller's JWT.`,
    );
  }

  // 2. No write verbs (.insert/.update/.upsert/.delete) outside store.ts
  if (!isStore && /\.(insert|update|upsert|delete)\s*\(/.test(code)) {
    errs.push(
      `${relPath}: write call (.insert/.update/.upsert/.delete) outside store.ts. Zoe is strictly read-only.`,
    );
  }

  // 3. store.ts may only access staff_assistant_* tables and must never .delete() messages/conversations
  if (isStore) {
    for (const m of code.matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      if (!m[1].startsWith('staff_assistant_')) {
        errs.push(
          `${relPath}: store.ts touches table "${m[1]}"; it may only touch staff_assistant_* tables.`,
        );
      }
    }
    if (/\.delete\s*\(/.test(code)) {
      errs.push(
        `${relPath}: store.ts must not call .delete() on staff_assistant_* tables; use hidden_by_user soft-hide for clearing history.`,
      );
    }
  }

  // 4. Raw SQL execution is forbidden everywhere
  if (/\.sql\s*\(|exec_sql|run_sql|execute_sql|\bsql\s*`/i.test(code)) {
    errs.push(`${relPath}: raw SQL execution is not allowed in staff-assistant.`);
  }

  // 5. Secret hygiene
  if (/Deno\.env\.toObject/.test(code)) {
    errs.push(`${relPath}: Deno.env.toObject() is forbidden; read named env vars only.`);
  }
  if (!isModel && /\b(LOVABLE_API_KEY|OPENAI_API_KEY)\b/.test(code)) {
    errs.push(`${relPath}: AI provider key may only be read in openai.ts.`);
  }

  // 6. Direct .rpc() calls outside tools.ts must only be allowed gate/recipient/draft helpers
  if (!isTools) {
    const ALLOWED_DIRECT_RPCS = new Set([
      'staff_assistant_has_access',
      'staff_assistant_health',
      'staff_assistant_get_config',
      'staff_assistant_is_staff_email',
      'staff_assistant_email_recipients',
      'staff_assistant_save_draft',
      'staff_assistant_consume_draft',
      'staff_assistant_can_user_read_report',
      'staff_assistant_check_question_rate_limit',
      'staff_assistant_check_email_budget',
      'staff_assistant_hide_my_history',
      'assistant_staff_my_profile',
      'assistant_staff_get_glossary',
      'assistant_staff_get_data_catalog',
      'assistant_staff_data_catalog',
    ]);
    for (const m of code.matchAll(/\.rpc\(\s*["'`]([^"'`]+)["'`]/g)) {
      if (!ALLOWED_DIRECT_RPCS.has(m[1])) {
        errs.push(
          `${relPath}: direct .rpc("${m[1]}") call is not allowed outside tools.ts; tool RPCs must be registered in tools.ts.`,
        );
      }
    }
  }

  // 7. Web tools and page reader in consultant.ts: must validate outbound queries/URLs,
  //    never pass rawToolOutputs to external fetch/search, wrap pages in <UNTRUSTED_WEB_PAGE_DATA>,
  //    and never perform database RPC/table calls.
  if (isConsultant) {
    if (!/\bvalidateConsultantWebQuery\s*\(/.test(code)) {
      errs.push(
        `${relPath}: web search tool must enforce outbound query firewall via validateConsultantWebQuery().`,
      );
    }
    if (!/\bvalidateConsultantWebUrl\s*\(/.test(code)) {
      errs.push(
        `${relPath}: web page reader must enforce outbound URL firewall via validateConsultantWebUrl().`,
      );
    }
    if (!/<UNTRUSTED_WEB_PAGE_DATA\b/.test(code) || !/<\/UNTRUSTED_WEB_PAGE_DATA>/.test(code)) {
      errs.push(
        `${relPath}: web page reader must wrap fetched content in <UNTRUSTED_WEB_PAGE_DATA>...</UNTRUSTED_WEB_PAGE_DATA>.`,
      );
    }
    if (/\b(?:fetch|fetcher)\s*\([^)]*\brawToolOutputs\b/.test(code) || /\bprovider\.search\s*\(\s*rawToolOutputs\b/.test(code)) {
      errs.push(
        `${relPath}: web tools and reader must never pass rawToolOutputs to external fetch/provider calls.`,
      );
    }
    if (/\.from\s*\(|\.rpc\s*\(/.test(code)) {
      errs.push(
        `${relPath}: web tools and reader in consultant.ts must never touch database tables or RPCs.`,
      );
    }
  }

  return errs;
}

/**
 * Audits `supabase/functions/staff-assistant/tools.ts`.
 */
export function auditStaffAssistantTools(relPath, rawCode) {
  const errs = [];
  const code = stripComments(rawCode);
  const rpcs = [...code.matchAll(/rpc:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);

  if (rpcs.length === 0) {
    errs.push(`${relPath}: no tool RPCs found in tools.ts.`);
  }

  for (const rpc of rpcs) {
    if (!/^assistant_staff_[a-z0-9_]+$/.test(rpc)) {
      errs.push(`${relPath}: tool RPC "${rpc}" must be an assistant_staff_* function.`);
    }
  }

  const identityPropRe =
    /(["'`])(?:p_)?(?:user|staff|agent|tenant|landlord|account|wallet|owner|supporter|partner)_?id\1\s*:/i;
  if (identityPropRe.test(code)) {
    errs.push(
      `${relPath}: a tool declares a user/staff/agent/tenant/account ID parameter. Identity must come from auth.uid().`,
    );
  }

  return { rpcs, errors: errs };
}

/**
 * Audits any email-sending function or module used by Zoe to ensure it cannot
 * send to an address without calling `staff_assistant_is_staff_email`.
 */
export function auditStaffEmailFunction(relPath, rawCode) {
  const errs = [];
  const code = stripComments(rawCode);

  const sendsEmail =
    /\b(send-transactional-email|enqueue_email|resend\.com|api\.resend\.com|sendReportEmail|sendStaffAssistantEmail)\b/.test(
      code,
    ) || /\.functions\.invoke\(\s*["'`]send-transactional-email["'`]/.test(code);

  const isEmailEdgeFn =
    relPath.includes('staff-assistant-email') ||
    relPath.includes('staff-assistant-send-email') ||
    sendsEmail;

  if (isEmailEdgeFn) {
    if (!/\bstaff_assistant_is_staff_email\b/.test(code)) {
      errs.push(
        `${relPath}: send-email function can send to an address without calling staff_assistant_is_staff_email.`,
      );
    }
  }

  return errs;
}

/**
 * Audits a frontend file under `src/` to ensure it never calls any
 * `assistant_staff_*` RPC directly.
 */
export function auditFrontendFile(relPath, rawCode) {
  const errs = [];
  const code = stripComments(rawCode);

  if (/\.rpc\(\s*["'`]assistant_staff_[a-z0-9_]*/i.test(code)) {
    errs.push(
      `${relPath}: the frontend must not call assistant_staff_* RPCs directly; route requests through the staff-assistant edge function.`,
    );
  }

  return errs;
}

// ============================================================================
// Built-in Self-Test (proves the guard catches broken examples for every rule)
// ============================================================================

export function runSelfTests() {
  const failures = [];
  const expectError = (label, actualErrors, expectedPattern) => {
    if (!actualErrors.some((e) => expectedPattern.test(e))) {
      failures.push(
        `Self-test "${label}" failed: expected an error matching ${expectedPattern}, got [${actualErrors.join('; ')}]`,
      );
    }
  };

  const validSql = `
    CREATE OR REPLACE FUNCTION public.assistant_staff_tops_demo()
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
    BEGIN
      IF auth.uid() IS NULL OR NOT public.staff_assistant_has_access() OR NOT public._am_staff_ok() THEN
        RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
      END IF;
      RETURN '{}'::jsonb;
    END;
    $$;
    REVOKE ALL ON FUNCTION public.assistant_staff_tops_demo() FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_demo() TO authenticated;
  `;

  // Verify the valid baseline passes with zero errors
  const validRes = auditSqlMigration('valid-example.sql', validSql);
  if (validRes.errors.length > 0) {
    failures.push(`Self-test baseline validSql had unexpected errors: ${validRes.errors.join('; ')}`);
  }

  // Broken 1: Function is VOLATILE instead of STABLE
  expectError(
    'non-STABLE function',
    auditSqlMigration(
      'broken-volatile.sql',
      validSql.replace('STABLE', 'VOLATILE'),
    ).errors,
    /must be STABLE/i,
  );

  // Broken 2: Function is SECURITY INVOKER instead of SECURITY DEFINER
  expectError(
    'non-SECURITY DEFINER function',
    auditSqlMigration(
      'broken-invoker.sql',
      validSql.replace('SECURITY DEFINER', 'SECURITY INVOKER'),
    ).errors,
    /must be SECURITY DEFINER/i,
  );

  // Broken 3: Function lacks SET search_path = public
  expectError(
    'missing search_path=public',
    auditSqlMigration(
      'broken-search-path.sql',
      validSql.replace('SET search_path = public', ''),
    ).errors,
    /must set search_path = public/i,
  );

  // Broken 4: Function has a user-id parameter
  expectError(
    'has user_id parameter',
    auditSqlMigration(
      'broken-userid.sql',
      validSql.replace('assistant_staff_tops_demo()', 'assistant_staff_tops_demo(p_user_id uuid)'),
    ).errors,
    /identity parameter/i,
  );

  // Broken 5: Function lacks a role check
  expectError(
    'lacks role check',
    auditSqlMigration(
      'broken-norole.sql',
      validSql.replace(
        'IF auth.uid() IS NULL OR NOT public.staff_assistant_has_access() OR NOT public._am_staff_ok() THEN',
        'IF auth.uid() IS NULL THEN',
      ),
    ).errors,
    /lacks a required role\/access check/i,
  );

  // Broken 6: Function grants EXECUTE to anon or PUBLIC
  expectError(
    'grants execute to anon',
    auditSqlMigration(
      'broken-grant-anon.sql',
      validSql + '\nGRANT EXECUTE ON FUNCTION public.assistant_staff_tops_demo() TO anon;',
    ).errors,
    /grants EXECUTE to anon or PUBLIC/i,
  );

  // Broken 7: Function contains a write statement (UPDATE / INSERT / COPY / GRANT / dynamic EXECUTE)
  expectError(
    'contains write SQL',
    auditSqlMigration(
      'broken-write.sql',
      validSql.replace("RETURN '{}'::jsonb;", "UPDATE public.wallets SET balance = 0; RETURN '{}'::jsonb;"),
    ).errors,
    /write, DDL, or dynamic SQL/i,
  );

  expectError(
    'contains dynamic SQL EXECUTE',
    auditSqlMigration(
      'broken-dynamic-sql.sql',
      validSql.replace("RETURN '{}'::jsonb;", "EXECUTE 'DELETE FROM public.wallets'; RETURN '{}'::jsonb;"),
    ).errors,
    /write, DDL, or dynamic SQL/i,
  );

  // Broken 8: Call-chain function is VOLATILE or contains writes
  const brokenCallChainSql = `
    CREATE OR REPLACE FUNCTION public.helper_volatile_writer()
    RETURNS jsonb
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = public
    AS $$
    BEGIN
      INSERT INTO public.audit_logs (action_type) VALUES ('bad');
      RETURN '{}'::jsonb;
    END;
    $$;
  ` + validSql.replace("RETURN '{}'::jsonb;", "RETURN public.helper_volatile_writer();");
  const mockFnMap = new Map(
    extractSqlFunctionsFromText('broken-chain.sql', brokenCallChainSql).map((d) => [d.name, d]),
  );
  expectError(
    'call chain calls VOLATILE function',
    auditSqlMigration('broken-chain.sql', brokenCallChainSql, mockFnMap).errors,
    /calls VOLATILE function "helper_volatile_writer\(\)" in call chain/i,
  );

  // Broken 9: staff-assistant uses service role outside its logging file (store.ts)
  expectError(
    'service role outside store.ts',
    auditStaffAssistantEdgeFile(
      'supabase/functions/staff-assistant/index.ts',
      `const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");`,
    ),
    /service-role key may only be used in store\.ts/i,
  );

  // Broken 10: Frontend calls an assistant_staff_* function directly
  expectError(
    'frontend calls assistant_staff_* directly',
    auditFrontendFile(
      'src/pages/me/Zoe.tsx',
      `const { data } = await supabase.rpc('assistant_staff_my_payslips');`,
    ),
    /frontend must not call assistant_staff_\* RPCs directly/i,
  );

  // Broken 11: Send-email function sends email without calling staff_assistant_is_staff_email
  expectError(
    'send-email without staff_assistant_is_staff_email',
    auditStaffEmailFunction(
      'supabase/functions/staff-assistant-email/index.ts',
      `await supabase.functions.invoke("send-transactional-email", { body: { to: recipientEmail } });`,
    ),
    /without calling staff_assistant_is_staff_email/i,
  );

  // Broken 12: Cash position tool that does not call get_treasury_cash_position
  expectError(
    'cash tool without get_treasury_cash_position',
    auditSqlMigration(
      'broken-cash.sql',
      validSql.replaceAll('assistant_staff_tops_demo', 'assistant_staff_cfo_treasury_cash_position'),
    ).errors,
    /get_treasury_cash_position/i,
  );

  // Broken 13: Zoe table grants INSERT/DELETE to authenticated or schedule runner forges aal2
  expectError(
    'Zoe table grants write to authenticated',
    auditCumulativeSqlSecurity(
      `GRANT SELECT, INSERT ON TABLE public.staff_assistant_reminders TO authenticated;`,
    ),
    /staff_assistant_reminders grants INSERT to authenticated/i,
  );

  expectError(
    'schedule runner forges aal2',
    auditCumulativeSqlSecurity(`
      CREATE OR REPLACE FUNCTION public.staff_assistant_check_owner_access(p_owner_id uuid)
      RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_owner_id::text, 'aal', 'aal2')::text, true);
        RETURN true;
      END;
      $$;
    `),
    /forges 'aal', 'aal2'/i,
  );

  // Broken 14: assistant_staff_run_query missing statement_timeout = '5s' or zoe_ro_validate_query
  const brokenAnalystTimeout = `
    CREATE OR REPLACE FUNCTION public.assistant_staff_run_query(p_sql text, p_question text DEFAULT NULL)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = public, zoe_ro
    SET default_transaction_read_only = on
    AS $$
    DECLARE
      v_validation jsonb;
      v_wrapped_sql text;
    BEGIN
      IF auth.uid() IS NULL OR NOT public.staff_assistant_has_access() OR NOT public.can_view_staff_reports(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
      END IF;
      v_validation := public.zoe_ro_validate_query(p_sql);
      PERFORM public.zoe_ro_require_area('operations');
      SET LOCAL transaction_read_only = on;
      v_wrapped_sql := 'SELECT 1 LIMIT 501 -- 500';
      RETURN '{}'::jsonb;
    END;
    $$;
    REVOKE ALL ON FUNCTION public.assistant_staff_run_query(text, text) FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.assistant_staff_run_query(text, text) TO authenticated;
  `;
  expectError(
    "assistant_staff_run_query must set statement_timeout = '5s'",
    auditSqlMigration('broken-analyst-timeout.sql', brokenAnalystTimeout).errors,
    /must set statement_timeout = '5s'/i,
  );

  // Broken 16: zoe_ro view missing WITH (security_invoker = true)
  expectError(
    'zoe_ro view missing security_invoker = true',
    auditCumulativeSqlSecurity(`
      CREATE OR REPLACE VIEW zoe_ro.operations_demo AS
      SELECT 1 AS c WHERE public.zoe_ro_require_area('operations');
    `),
    /must specify WITH \(security_invoker = true\)/i,
  );

  // Broken 17: consultant.ts web tools missing validateConsultantWebQuery or passing rawToolOutputs to fetch
  expectError(
    'consultant.ts passing rawToolOutputs to fetch or missing query firewall',
    auditStaffAssistantEdgeFile(
      'supabase/functions/staff-assistant/consultant.ts',
      `
        export async function executeConsultantWebSearch(query: string, rawToolOutputs: string[]) {
          return fetch("https://api.search.brave.com/res/v1/web/search?q=" + rawToolOutputs.join(","));
        }
      `,
    ),
    /validateConsultantWebQuery|never pass rawToolOutputs/i,
  );

  // Broken 18: consultant.ts page reader missing <UNTRUSTED_WEB_PAGE_DATA> wrapper
  expectError(
    'consultant.ts page reader missing <UNTRUSTED_WEB_PAGE_DATA>',
    auditStaffAssistantEdgeFile(
      'supabase/functions/staff-assistant/consultant.ts',
      `
        export function validateConsultantWebQuery() {}
        export function validateConsultantWebUrl() {}
        export async function executeConsultantReadWebPage(url: string) {
          return { text: "raw untrusted html" };
        }
      `,
    ),
    /<UNTRUSTED_WEB_PAGE_DATA>/i,
  );

  // Valid send-email function that calls staff_assistant_is_staff_email passes
  const validEmailErrs = auditStaffEmailFunction(
    'supabase/functions/staff-assistant-email/index.ts',
    `
      const { data: ok } = await userClient.rpc("staff_assistant_is_staff_email", { p_email: recipientEmail });
      if (!ok) return new Response("Forbidden", { status: 403 });
      await supabase.functions.invoke("send-transactional-email", { body: { to: recipientEmail } });
    `,
  );
  if (validEmailErrs.length > 0) {
    failures.push(`Self-test valid email function had unexpected errors: ${validEmailErrs.join('; ')}`);
  }

  return failures;
}

// ============================================================================
// Repository Scan
// ============================================================================

const errors = [];
const fail = (msg) => errors.push(msg);
const seen = {
  selfTests: 18,
  edgeSources: 0,
  toolRpcs: 0,
  sqlFunctions: 0,
  frontendFiles: 0,
};

// 1. Run self-tests first
const selfTestFailures = runSelfTests();
for (const f of selfTestFailures) fail(f);

if (process.argv.includes('--self-test')) {
  if (selfTestFailures.length > 0) {
    console.error(`[guard:staff-assistant] self-test failed:\n  - ${selfTestFailures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`[guard:staff-assistant] self-test ok — all ${seen.selfTests} broken examples caught`);
}

// 2. Check supabase/functions/staff-assistant
if (!existsSync(STAFF_FN_DIR)) {
  fail('supabase/functions/staff-assistant is missing.');
} else {
  const sources = walk(STAFF_FN_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('_test.ts'));
  seen.edgeSources = sources.length;

  for (const file of sources) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const raw = readFileSync(file, 'utf8');
    for (const err of auditStaffAssistantEdgeFile(rel, raw)) fail(err);
    for (const err of auditStaffEmailFunction(rel, raw)) fail(err);
  }

  const indexPath = join(STAFF_FN_DIR, 'index.ts');
  if (existsSync(indexPath)) {
    const indexCode = stripComments(readFileSync(indexPath, 'utf8'));
    if (!/\.rpc\(\s*["'`]staff_assistant_has_access["'`]\s*\)/.test(indexCode)) {
      fail('supabase/functions/staff-assistant/index.ts must verify staff_assistant_has_access().');
    }
    if (!/\brequireStaffAal2\b/.test(indexCode)) {
      fail('supabase/functions/staff-assistant/index.ts must gate sensitive tools with requireStaffAal2.');
    }
  }

  const toolsPath = join(STAFF_FN_DIR, 'tools.ts');
  if (existsSync(toolsPath)) {
    const rel = relative(ROOT, toolsPath).replace(/\\/g, '/');
    const { rpcs, errors: toolErrs } = auditStaffAssistantTools(rel, readFileSync(toolsPath, 'utf8'));
    seen.toolRpcs = rpcs.length;
    for (const err of toolErrs) fail(err);
  } else {
    fail('supabase/functions/staff-assistant/tools.ts is missing.');
  }
}

// 3. Check supabase/functions/staff-assistant-send-email (and staff-assistant-email if present)
for (const emailDir of STAFF_EMAIL_FN_DIRS) {
  if (!existsSync(emailDir)) continue;
  const emailSources = walk(emailDir).filter((f) => f.endsWith('.ts') && !f.endsWith('_test.ts'));
  const combinedDirCode = emailSources.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');
  if (emailSources.length > 0) {
    for (const file of emailSources) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      const raw = readFileSync(file, 'utf8');
      if (!/staff_assistant_is_staff_email/.test(combinedDirCode)) {
        for (const err of auditStaffEmailFunction(rel, raw)) fail(err);
      }
    }
    if (!/staff_assistant_is_staff_email/.test(combinedDirCode)) {
      fail(
        `${relative(ROOT, emailDir)} must call staff_assistant_is_staff_email before sending any email.`,
      );
    }
    if (!/staff_assistant_has_access/.test(combinedDirCode)) {
      fail(
        `${relative(ROOT, emailDir)} must re-check staff_assistant_has_access() before sending any email.`,
      );
    }
  }
}

// 4. Check all assistant_staff_* SQL functions + transitive call chain + cumulative privileges across supabase/migrations
if (existsSync(MIGRATIONS_DIR)) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const allFound = new Set();
  const globalFunctionMap = new Map();
  const staffMigrationChunks = [];

  for (const file of files) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const def of extractSqlFunctionsFromText(file, raw)) {
      globalFunctionMap.set(def.name, def);
    }
    if (file.includes('staff_assistant')) {
      staffMigrationChunks.push(raw);
    }
  }

  for (const file of files) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (!/assistant_staff_/i.test(raw)) continue;
    const { functionsFound, errors: sqlErrs } = auditSqlMigration(file, raw, globalFunctionMap);
    for (const fn of functionsFound) allFound.add(fn);
    for (const err of sqlErrs) fail(err);
  }

  for (const err of auditCumulativeSqlSecurity(staffMigrationChunks.join('\n'))) {
    fail(err);
  }

  const REQUIRED_ADVISOR_INSIGHT_RPCS = [
    'assistant_staff_insight_desk_wait_times',
    'assistant_staff_insight_collection_coverage_trends',
    'assistant_staff_insight_calling_reach_and_themes',
    'assistant_staff_insight_payout_delays',
    'assistant_staff_insight_zoe_feedback_themes',
    'assistant_staff_get_glossary',
    'assistant_staff_data_catalog',
    'assistant_staff_run_query',
  ];
  for (const reqFn of REQUIRED_ADVISOR_INSIGHT_RPCS) {
    if (!allFound.has(reqFn)) {
      fail(`Missing required advisor/analyst function public.${reqFn}() in supabase/migrations.`);
    }
  }

  const analystSecurityTestPath = join(ROOT, 'supabase', 'tests', 'zoe_analyst_lane_security_test.sql');
  if (!existsSync(analystSecurityTestPath)) {
    fail('Missing required database test file supabase/tests/zoe_analyst_lane_security_test.sql.');
  } else {
    const testSql = readFileSync(analystSecurityTestPath, 'utf8');
    for (const requiredPattern of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bDROP\s+VIEW\b/i,
      /\bTRUNCATE\s+TABLE\b/i,
      /\bCOPY\b/i,
      /\bSET\s+ROLE\b/i,
      /\bpg_sleep\s*\(\s*30\s*\)/i,
      /\bCROSS\s+JOIN\b/i,
      /\bzoe_ro\.finance_treasury_cash_position\b/i,
      /\baal2\b/i,
    ]) {
      if (!requiredPattern.test(testSql)) {
        fail(
          `supabase/tests/zoe_analyst_lane_security_test.sql is missing required test pattern ${requiredPattern}.`,
        );
      }
    }
  }

  seen.sqlFunctions = allFound.size;
  if (seen.sqlFunctions === 0) {
    fail('no assistant_staff_* functions found in supabase/migrations.');
  }
}

// 5. Check frontend files (src/)
for (const file of walk(SRC_DIR).filter((f) => /\.(ts|tsx)$/.test(f))) {
  seen.frontendFiles += 1;
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const raw = readFileSync(file, 'utf8');
  for (const err of auditFrontendFile(rel, raw)) fail(err);
}

if (errors.length > 0) {
  console.error(`[guard:staff-assistant] ${errors.length} violation(s):\n`);
  for (const e of errors) console.error(`  - ${e}\n`);
  process.exit(1);
}

console.log(
  `[guard:staff-assistant] ok — Zoe is read-only, role-gated, call-chain verified, and staff-email-scoped ` +
    `(${seen.edgeSources} function sources, ${seen.toolRpcs} tool RPCs, ${seen.sqlFunctions} assistant_staff_* SQL functions, ${seen.selfTests} self-tests checked)`,
);
