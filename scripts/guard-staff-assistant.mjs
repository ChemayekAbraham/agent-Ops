#!/usr/bin/env node
/**
 * CI & Build Guard — Zoe (My Space Staff Assistant) safety, role-gating, and read-only invariants.
 *
 * Fails the build if:
 *   1. Any `assistant_staff_*` SQL function in `supabase/migrations/` is not `STABLE`,
 *      `SECURITY DEFINER`, and `SET search_path = public`.
 *   2. Any `assistant_staff_*` SQL function takes a user/staff/agent/tenant/account ID parameter
 *      (identity must always come from `auth.uid()`).
 *   3. Any `assistant_staff_*` SQL function lacks an access/role check (`staff_assistant_has_access`
 *      plus department role check for non-personal tools, raising `42501`), or contains write SQL.
 *   4. Any `assistant_staff_*` SQL function grants EXECUTE to `anon` or `PUBLIC`, or fails to
 *      REVOKE EXECUTE from `PUBLIC` and `anon`, or fails to GRANT EXECUTE exclusively to `authenticated`.
 *   5. `supabase/functions/staff-assistant/` uses the service role (`SERVICE_ROLE`) or write verbs
 *      (`.insert`, `.update`, `.upsert`, `.delete`) outside its logging file (`store.ts`), or
 *      `store.ts` touches any table outside `staff_assistant_*`.
 *   6. The frontend (`src/`) calls any `assistant_staff_*` RPC directly instead of going through
 *      the `staff-assistant` edge function.
 *   7. Any Zoe send-email function (`supabase/functions/staff-assistant-email` or any email-sending
 *      module in `staff-assistant*`) can send to an address without calling
 *      `staff_assistant_is_staff_email`.
 *   8. Any built-in self-test fails to catch a broken example.
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
  join(ROOT, 'supabase', 'functions', 'staff-assistant-send-email'),
  join(ROOT, 'supabase', 'functions', 'staff-assistant-schedule-runner'),
  join(ROOT, 'supabase', 'functions', 'staff-assistant-email'),
];
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const SRC_DIR = join(ROOT, 'src');

export function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/--[^\n]*/g, ' ');
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

// ============================================================================
// Pure Audit Functions (used for both repository checks and self-tests)
// ============================================================================

const IDENTITY_ARG_RE =
  /(^|[\s,(])(p_)?(user|staff|agent|tenant|landlord|account|owner|caller|employee|requester)_?id\b/i;

const ROLE_CHECK_HELPER_RE =
  /\b(_has_enabled_role|is_ops_role|_am_staff_ok|_landlord_cc_staff_ok|food_can_use_canteen|cfo_check|is_cfo_or_super_admin|hr_is_admin|hr_is_executive|can_view_finance_reports|can_view_staff_reports|agent_ops_report_authorized|partner_ops_can_view|pso_can_view_my_performance|is_welile_staff|has_role)\s*\(/i;

const WRITE_SQL_RE =
  /\b(insert\s+into|update\s+[a-z0-9_.]+?\s+set|delete\s+from|truncate\s+|alter\s+table|drop\s+table|create\s+table)\b/i;

/**
 * Audit a SQL migration string for `assistant_staff_*` definitions and grants.
 * Returns `{ functionsFound: string[], errors: string[] }`.
 */
export function auditSqlMigration(fileLabel, rawSql) {
  const errors = [];
  const functionsFound = [];
  const body = stripComments(rawSql);

  const fnRegex =
    /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(assistant_staff_[a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns\s+([\s\S]*?)\bas\s+(\$[a-zA-Z0-9_]*\$)([\s\S]*?)\4/gi;

  for (const m of body.matchAll(fnRegex)) {
    const name = m[1];
    const args = m[2];
    const headerTail = m[3];
    const fnBody = m[5];
    const fullHeader = `${m[0].slice(0, m[0].indexOf(m[4]))}`;
    const where = `${fileLabel}: ${name}()`;
    functionsFound.push(name);

    // 1. Must be STABLE
    if (!/\bstable\b/i.test(fullHeader) && !/\bstable\b/i.test(headerTail)) {
      errors.push(`${where} must be declared STABLE.`);
    }

    // 2. Must be SECURITY DEFINER
    if (!/security\s+definer/i.test(fullHeader) && !/security\s+definer/i.test(headerTail)) {
      errors.push(`${where} must be declared SECURITY DEFINER.`);
    }

    // 3. Must pin search_path = public
    if (!/set\s+search_path\s*=\s*public\b/i.test(fullHeader) && !/set\s+search_path\s*=\s*public\b/i.test(headerTail)) {
      errors.push(`${where} must set search_path = public.`);
    }

    // 4. Must NOT have any user/staff/agent/tenant/account identity parameter
    if (IDENTITY_ARG_RE.test(args)) {
      errors.push(
        `${where} declares an identity parameter (${args.trim()}). Identity must always be auth.uid().`,
      );
    }

    // 5. Must contain an explicit access/role check and raise 42501
    const hasAccessGate =
      /\bstaff_assistant_has_access\s*\(\s*\)/i.test(fnBody) ||
      /\bstaff_assistant_require_staff\s*\(\s*\)/i.test(fnBody);
    if (!hasAccessGate) {
      errors.push(`${where} lacks a staff_assistant_has_access() check.`);
    }

    const isPersonalMySpaceTool = /^assistant_staff_my_[a-z0-9_]+$/i.test(name);
    if (!isPersonalMySpaceTool && !ROLE_CHECK_HELPER_RE.test(fnBody)) {
      errors.push(
        `${where} is a department tool and must check the caller's role via an official role helper (e.g. _has_enabled_role, is_ops_role, _am_staff_ok).`,
      );
    }

    const raises42501 =
      /42501/.test(fnBody) || /\bstaff_assistant_require_staff\s*\(\s*\)/i.test(fnBody);
    if (!raises42501) {
      errors.push(`${where} must raise ERRCODE = '42501' when the caller is not authorized.`);
    }

    // 6. Must not contain write SQL inside the function body
    if (WRITE_SQL_RE.test(fnBody)) {
      errors.push(`${where} contains a write/DDL statement; assistant_staff_* functions must be read-only.`);
    }

    // 6b. Cash position tools must source platform cash strictly from get_treasury_cash_position
    if (/(cash_position|treasury_cash)/i.test(name) && !/\bget_treasury_cash_position\s*\(/i.test(fnBody)) {
      errors.push(`${where} must read platform cash exclusively from public.get_treasury_cash_position().`);
    }

    // 7. Must REVOKE EXECUTE/ALL FROM PUBLIC, anon and must NEVER GRANT to anon or PUBLIC
    const revokeRe = new RegExp(
      `revoke\\s+(?:execute|all(?:\\s+privileges)?)\\s+on\\s+function\\s+(?:public\\.)?${name}\\s*\\([^)]*\\)\\s+from\\s+([^;]+);`,
      'gi',
    );
    let revokedPublic = false;
    let revokedAnon = false;
    for (const rm of body.matchAll(revokeRe)) {
      const targets = rm[1].toLowerCase();
      if (/\bpublic\b/.test(targets)) revokedPublic = true;
      if (/\banon\b/.test(targets)) revokedAnon = true;
    }
    if (!revokedPublic || !revokedAnon) {
      errors.push(`${where} must REVOKE EXECUTE (or ALL) FROM PUBLIC, anon.`);
    }

    const grantRe = new RegExp(
      `grant\\s+(?:execute|all(?:\\s+privileges)?)\\s+on\\s+function\\s+(?:public\\.)?${name}\\s*\\([^)]*\\)\\s+to\\s+([^;]+);`,
      'gi',
    );
    let grantedAuthenticated = false;
    for (const gm of body.matchAll(grantRe)) {
      const targets = gm[1].toLowerCase();
      if (/\b(anon|public|service_role)\b/.test(targets)) {
        errors.push(`${where} grants EXECUTE to forbidden role (${gm[1].trim()}); grant to authenticated only.`);
      }
      if (/\bauthenticated\b/.test(targets)) {
        grantedAuthenticated = true;
      }
    }
    if (!grantedAuthenticated) {
      errors.push(`${where} must GRANT EXECUTE ON FUNCTION ... TO authenticated.`);
    }
  }

  return { functionsFound, errors };
}

/**
 * Audit a single TypeScript file inside `supabase/functions/staff-assistant/`.
 */
export function auditStaffAssistantEdgeFile(relPath, rawCode) {
  const errors = [];
  const isStore = relPath.endsWith('/store.ts') || relPath === 'store.ts';
  const isModel = relPath.endsWith('/openai.ts') || relPath === 'openai.ts';
  const isTools = relPath.endsWith('/tools.ts') || relPath === 'tools.ts';
  const code = stripComments(rawCode);

  // 1. Service role key may ONLY appear in store.ts
  if (!isStore && /SERVICE_ROLE/.test(code)) {
    errors.push(
      `${relPath}: SERVICE_ROLE may only be used in store.ts (logging/config). All assistant_staff_* calls must use the caller's JWT.`,
    );
  }

  // 2. Write calls (.insert/.update/.upsert/.delete) may ONLY appear in store.ts
  if (!isStore && /\.(insert|update|upsert|delete)\s*\(/.test(code)) {
    errors.push(
      `${relPath}: database write call (.insert/.update/.upsert/.delete) outside store.ts. Zoe is read-only.`,
    );
  }

  // 3. store.ts may only access staff_assistant_* tables
  if (isStore) {
    for (const m of code.matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      if (!m[1].startsWith('staff_assistant_')) {
        errors.push(
          `${relPath}: store.ts touches table "${m[1]}"; it may only access staff_assistant_* tables.`,
        );
      }
    }
    for (const m of code.matchAll(/\.rpc\(\s*["'`]([^"'`]+)["'`]/g)) {
      if (m[1].startsWith('assistant_staff_')) {
        errors.push(
          `${relPath}: store.ts must never call "${m[1]}" with the service role; tool RPCs must be called with userClient in index.ts.`,
        );
      }
    }
  }

  // 4. Provider API key isolation
  if (!isModel && /\b(LOVABLE_API_KEY|OPENAI_API_KEY)\b/.test(code)) {
    errors.push(`${relPath}: API key may only be read in openai.ts.`);
  }
  if (/Deno\.env\.toObject/.test(code)) {
    errors.push(`${relPath}: Deno.env.toObject() is forbidden.`);
  }

  // 5. Raw SQL execution is never allowed
  if (/\.sql\s*\(|exec_sql|run_sql|execute_sql|\bsql\s*`/i.test(code)) {
    errors.push(`${relPath}: raw SQL execution is forbidden in staff-assistant.`);
  }

  // 6. Direct .rpc("...") calls outside tools.ts must only be the access gate or profile role fallback
  if (!isTools) {
    for (const m of code.matchAll(/\.rpc\(\s*["'`]([^"'`]+)["'`]/g)) {
      const allowedDirectRpcs = new Set([
        'staff_assistant_has_access',
        'assistant_staff_my_profile',
        'staff_assistant_is_staff_email',
        'staff_assistant_email_recipients',
      ]);
      if (!allowedDirectRpcs.has(m[1])) {
        errors.push(
          `${relPath}: direct .rpc("${m[1]}") call outside tools.ts; tool RPCs must be registered in tools.ts.`,
        );
      }
    }
  }

  return errors;
}

/**
 * Audit `supabase/functions/staff-assistant/tools.ts`.
 */
export function auditStaffAssistantTools(relPath, rawCode) {
  const errors = [];
  const code = stripComments(rawCode);
  const rpcs = [...code.matchAll(/rpc:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  if (rpcs.length === 0) {
    errors.push(`${relPath}: no tool RPCs found in STAFF_TOOLS registry.`);
  }
  for (const rpc of rpcs) {
    if (!/^assistant_staff_[a-z0-9_]+$/.test(rpc)) {
      errors.push(`${relPath}: tool RPC "${rpc}" must be named assistant_staff_*.`);
    }
  }
  const identityParam =
    /(["'`])(?:p_)?(?:user|staff|agent|tenant|landlord|account|owner|caller)_?id\1\s*:/i;
  if (identityParam.test(code)) {
    errors.push(
      `${relPath}: a tool declares a user/staff/agent/tenant/account ID parameter. Identity must come from auth.uid().`,
    );
  }
  return { rpcs, errors };
}

/**
 * Audit a frontend file (`src/**\/*.{ts,tsx}`) to ensure it never calls `assistant_staff_*` directly.
 */
export function auditFrontendFile(relPath, rawCode) {
  const errors = [];
  const code = stripComments(rawCode);
  if (/\.rpc\(\s*["'`]assistant_staff_[a-z0-9_]*/i.test(code)) {
    errors.push(
      `${relPath}: frontend must not call assistant_staff_* RPCs directly; route requests through the staff-assistant edge function.`,
    );
  }
  return errors;
}

/**
 * Audit an email-sending edge function or module for Zoe to ensure it cannot send to an
 * address without calling `staff_assistant_is_staff_email`.
 */
export function auditStaffEmailFunction(relPath, rawCode) {
  const errors = [];
  const code = stripComments(rawCode);

  const sendsEmail =
    /\b(send-transactional-email|enqueue_transactional_email|resend|sendEmail|send_email|staff_assistant_email)\b/i.test(
      code,
    );

  if (sendsEmail) {
    const checksStaffEmail =
      /\.rpc\(\s*["'`]staff_assistant_is_staff_email["'`]/.test(code) ||
      /\bstaff_assistant_is_staff_email\b/.test(code);
    if (!checksStaffEmail) {
      errors.push(
        `${relPath}: sends or enqueues email without calling staff_assistant_is_staff_email to verify the recipient is an active staff email.`,
      );
    }
  }

  return errors;
}

// ============================================================================
// Self-Test Suite (verifies the guard catches every broken example)
// ============================================================================

export function runSelfTests() {
  const failures = [];
  const expectError = (label, errs, pattern) => {
    if (!errs.some((e) => pattern.test(e))) {
      failures.push(
        `Self-test "${label}" FAILED: expected error matching ${pattern}, got: ${JSON.stringify(errs)}`,
      );
    }
  };

  // Valid baseline SQL function
  const validSql = `
    CREATE OR REPLACE FUNCTION public.assistant_staff_tops_demo(p_limit integer DEFAULT 50)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
    BEGIN
      IF auth.uid() IS NULL
         OR NOT public.staff_assistant_has_access()
         OR NOT public._has_enabled_role(auth.uid(), ARRAY['tenant_ops'])
      THEN
        RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
      END IF;
      RETURN jsonb_build_object('source', 'demo', 'period', 'today', 'rows', '[]'::jsonb);
    END;
    $$;
    REVOKE ALL ON FUNCTION public.assistant_staff_tops_demo(integer) FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_demo(integer) TO authenticated;
  `;
  const validCheck = auditSqlMigration('self-test-valid.sql', validSql);
  if (validCheck.errors.length > 0) {
    failures.push(`Self-test baseline valid SQL had unexpected errors: ${validCheck.errors.join('; ')}`);
  }

  // Broken 1: Missing STABLE (e.g. VOLATILE)
  expectError(
    'missing STABLE',
    auditSqlMigration('broken-volatile.sql', validSql.replace('STABLE', 'VOLATILE')).errors,
    /must be declared STABLE/i,
  );

  // Broken 2: Missing SECURITY DEFINER
  expectError(
    'missing SECURITY DEFINER',
    auditSqlMigration('broken-invoker.sql', validSql.replace('SECURITY DEFINER', 'SECURITY INVOKER')).errors,
    /must be declared SECURITY DEFINER/i,
  );

  // Broken 3: Missing SET search_path = public
  expectError(
    'missing search_path=public',
    auditSqlMigration('broken-search-path.sql', validSql.replace('SET search_path = public', '')).errors,
    /must set search_path = public/i,
  );

  // Broken 4: Has a user-id parameter
  expectError(
    'user_id parameter',
    auditSqlMigration(
      'broken-userid.sql',
      validSql.replace('p_limit integer DEFAULT 50', 'p_user_id uuid, p_limit integer DEFAULT 50'),
    ).errors,
    /declares an identity parameter/i,
  );

  // Broken 5: Lacks a role check
  expectError(
    'missing role check',
    auditSqlMigration(
      'broken-no-role.sql',
      validSql.replace("OR NOT public._has_enabled_role(auth.uid(), ARRAY['tenant_ops'])", ''),
    ).errors,
    /must check the caller's role/i,
  );

  // Broken 6: Grants EXECUTE to anon / PUBLIC
  expectError(
    'grants execute to anon',
    auditSqlMigration(
      'broken-grant-anon.sql',
      validSql + '\nGRANT EXECUTE ON FUNCTION public.assistant_staff_tops_demo(integer) TO anon;',
    ).errors,
    /grants EXECUTE to forbidden role/i,
  );

  // Broken 7: Missing REVOKE FROM PUBLIC, anon
  expectError(
    'missing revoke from anon/PUBLIC',
    auditSqlMigration(
      'broken-no-revoke.sql',
      validSql.replace(
        'REVOKE ALL ON FUNCTION public.assistant_staff_tops_demo(integer) FROM PUBLIC, anon, service_role;',
        '',
      ),
    ).errors,
    /must REVOKE EXECUTE/i,
  );

  // Broken 8: Service role used outside store.ts in staff-assistant
  expectError(
    'service role outside store.ts',
    auditStaffAssistantEdgeFile(
      'supabase/functions/staff-assistant/index.ts',
      `const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");`,
    ),
    /SERVICE_ROLE may only be used in store\.ts/i,
  );

  // Broken 9: Frontend calls assistant_staff_* directly
  expectError(
    'frontend calls assistant_staff_* directly',
    auditFrontendFile(
      'src/components/ZoeBadCall.tsx',
      `const { data } = await supabase.rpc("assistant_staff_my_tasks", { p_status: "pending" });`,
    ),
    /frontend must not call assistant_staff_\* RPCs directly/i,
  );

  // Broken 10: Send-email function sends email without calling staff_assistant_is_staff_email
  expectError(
    'send-email without staff_assistant_is_staff_email',
    auditStaffEmailFunction(
      'supabase/functions/staff-assistant-email/index.ts',
      `await supabase.functions.invoke("send-transactional-email", { body: { to: recipientEmail } });`,
    ),
    /without calling staff_assistant_is_staff_email/i,
  );

  // Broken 11: Cash position tool that does not call get_treasury_cash_position
  expectError(
    'cash tool without get_treasury_cash_position',
    auditSqlMigration(
      'broken-cash.sql',
      validSql.replaceAll('assistant_staff_tops_demo', 'assistant_staff_cfo_treasury_cash_position'),
    ).errors,
    /get_treasury_cash_position/i,
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
  selfTests: 11,
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
      // Only enforce per-file staff_assistant_is_staff_email if the directory as a whole lacks it
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

// 4. Check all assistant_staff_* SQL functions across supabase/migrations
if (existsSync(MIGRATIONS_DIR)) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const allFound = new Set();

  for (const file of files) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (!/assistant_staff_/i.test(raw)) continue;
    const { functionsFound, errors: sqlErrs } = auditSqlMigration(file, raw);
    for (const fn of functionsFound) allFound.add(fn);
    for (const err of sqlErrs) fail(err);
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
  `[guard:staff-assistant] ok — Zoe is read-only, role-gated, and staff-email-scoped ` +
    `(${seen.edgeSources} function sources, ${seen.toolRpcs} tool RPCs, ${seen.sqlFunctions} assistant_staff_* SQL functions, ${seen.selfTests} self-tests checked)`,
);
