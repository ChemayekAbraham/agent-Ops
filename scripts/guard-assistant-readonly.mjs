#!/usr/bin/env node
/**
 * CI guard — the agent assistant must stay read-only and scoped to the signed-in user.
 *
 * The assistant is a model that requests tools; the only protection that holds even if the
 * model is tricked is structural. This guard keeps the structure from eroding. It is static
 * (no database, runs in the Lovable build) and checks supabase/functions/agent-assistant and
 * the assistant_* migrations:
 *
 *   1. The service-role key appears ONLY in store.ts (the CRM conversation log).
 *   2. No write verbs (.insert/.update/.upsert/.delete) outside store.ts, and store.ts only
 *      writes assistant_* tables.
 *   3. Every tool RPC in tools.ts is an `assistant_agent_*` (agent persona), `assistant_partner_*`
 *      (partner persona) or help-search function, and no tool declares a user / agent / tenant /
 *      account id parameter.
 *   4. Raw SQL execution is never used (no .sql(, no exec_sql / run_sql style RPCs).
 *   5. Every `assistant_*` function in the migrations is STABLE (or the gate helpers), is
 *      SECURITY DEFINER with a pinned search_path, has no identity parameter, and revokes
 *      EXECUTE from PUBLIC/anon.
 *   6. The frontend never calls an assistant_* RPC directly (it goes through the edge
 *      function so the gate, validation and logging cannot be skipped).
 *
 * Usage: node scripts/guard-assistant-readonly.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FN_DIR = join(ROOT, 'supabase', 'functions', 'agent-assistant');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const SRC_DIR = join(ROOT, 'src');

const errors = [];
const fail = (msg) => errors.push(msg);
const seen = { sources: 0, toolRpcs: 0, sqlFunctions: 0 };

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/--[^\n]*/g, ' ');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- edge function sources
if (!existsSync(FN_DIR)) {
  fail('supabase/functions/agent-assistant is missing');
} else {
  const sources = walk(FN_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('_test.ts'));
  seen.sources = sources.length;
  for (const file of sources) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const isStore = file.endsWith('store.ts');
    const isModel = file.endsWith('openai.ts');
    const code = stripComments(readFileSync(file, 'utf8'));

    // Provider API key: read in exactly one place, per call, never dumped or logged.
    if (!isModel && /OPENAI_API_KEY/.test(code)) {
      fail(`${rel}: OPENAI_API_KEY may only be referenced in openai.ts (the single model wrapper).`);
    }
    if (/Deno\.env\.toObject/.test(code)) {
      fail(`${rel}: Deno.env.toObject() dumps every secret; read named variables only.`);
    }
    for (const m of code.matchAll(/Deno\.env\.get\(\s*([^)]*?)\s*\)/g)) {
      if (!/^["'`][A-Z0-9_]+["'`]$/.test(m[1])) fail(`${rel}: Deno.env.get(${m[1]}) must use a literal variable name (no dynamic secret lookup).`);
    }
    if (isModel && /console\.\w+\([^;]*(apiKey|Authorization|headers|config\s*\()/i.test(code)) {
      fail(`${rel}: openai.ts must never log the API key, request headers or config.`);
    }
    if (isModel && /(?:^|[^.\w])(?:const|let|var)\s+\w+\s*=\s*Deno\.env\.get\(\s*["'`]OPENAI_API_KEY/.test(code) && !/function\s+config\s*\(/.test(code)) {
      fail(`${rel}: the API key must be read inside config() on each call, not cached at module load.`);
    }

    if (!isStore && /SERVICE_ROLE/.test(code)) {
      fail(`${rel}: the service-role key may only be used in store.ts (CRM log). Data reads must use the user's JWT.`);
    }
    if (!isStore && /\.(insert|update|upsert|delete)\s*\(/.test(code)) {
      fail(`${rel}: write call outside store.ts. The assistant is read-only; only store.ts logs to assistant_* tables.`);
    }
    if (isStore) {
      for (const m of code.matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
        if (!m[1].startsWith('assistant_')) fail(`${rel}: store.ts touches table "${m[1]}"; it may only touch assistant_* tables.`);
      }
    }
    if (/\.sql\s*\(|exec_sql|run_sql|execute_sql|\bsql\s*`/i.test(code)) {
      fail(`${rel}: raw SQL execution is not allowed in the assistant.`);
    }
    // Any .rpc("name") outside the registry must be the gate.
    if (!file.endsWith('tools.ts')) {
      for (const m of code.matchAll(/\.rpc\(\s*["'`]([^"'`]+)["'`]/g)) {
        if (!['assistant_is_agent', 'assistant_is_partner', 'assistant_has_access'].includes(m[1])) fail(`${rel}: .rpc("${m[1]}") — only the assistant_is_agent / assistant_is_partner / assistant_has_access gates may be called directly; tool RPCs live in tools.ts.`);
      }
    }
  }

  // tools.ts: registry rules
  const toolsPath = join(FN_DIR, 'tools.ts');
  if (existsSync(toolsPath)) {
    const tools = stripComments(readFileSync(toolsPath, 'utf8'));
    const rpcs = [...tools.matchAll(/rpc:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    seen.toolRpcs = rpcs.length;
    if (!rpcs.length) fail('supabase/functions/agent-assistant/tools.ts: no tool RPCs found — the registry looks broken.');
    for (const rpc of rpcs) {
      if (!/^assistant_(agent|partner)_[a-z_]+$/.test(rpc)) fail(`tools.ts: tool RPC "${rpc}" must be an assistant_agent_* or assistant_partner_* function.`);
    }
    const identity = /(["'`])(?:p_)?(?:user|agent|tenant|account|owner)_?id\1\s*:/i;
    if (identity.test(tools)) fail('tools.ts: a tool declares a user/agent/tenant id parameter. Identity must come from auth.uid(), never from the model.');
  }
}

// ---------------------------------------------------------------- migrations
if (existsSync(MIGRATIONS_DIR)) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const GATE_HELPERS = new Set(['assistant_is_agent', 'assistant_require_agent', 'assistant_is_partner', 'assistant_require_partner']);
  const defined = new Map(); // name -> { file, def }

  // Columns that must never leave the database through the assistant: credentials, login and
  // activity data, avatars and photos, government ids, payout destinations, device data, GPS,
  // funder identities, and staff notes/comments/reasons. The assistant sends tool output to a
  // third-party model, so the whitelist is the control; this keeps a later edit from widening it.
  const COMMON_FORBIDDEN = [
    'national_id\\w*', 'avatar\\w*', 'last_active\\w*', 'last_login\\w*', 'last_sign_in\\w*', 'dashboard_\\w+',
    'password\\w*', 'must_change_password', 'signup_device\\w*', 'device_fp', 'ops_note',
    'residence_l(?:at|ng)', 'latitude', 'longitude',
    'selfie\\w*', 'id_image_hash', 'nin_photo\\w*', 'approval_comment', 'tenant_ops_comment', 'landlord_ops_comment',
    'agent_ops_comment', 'service_center_comment', 'rejected_reason', 'frozen_reason', 'deletion_reason',
    'payout_transaction_reference', 'fund_recipient\\w*', 'verification_pin\\w*', 'partial_reason',
    'caretaker\\w*', 'routing_preferences',
  ];
  // Partner persona only: credentials, receipts, staff-written reasons and request metadata never leave.
  const PARTNER_ONLY_FORBIDDEN = [
    'portfolio_pin', 'activation_token', 'return_fields_edit_token', 'receipt_file_url', 'receipt_token',
    'cfo_rejection_reason', 'processing_note', 'review_notes', 'rejection_reason', 'lock_reason', 'release_reason',
    'payout_proof\\w*', 'payout_code', 'request_ip_address', 'request_user_agent', 'kin_name', 'kin_contact',
    // Reversal and correction trail: partners never see it (running_balance is built from every entry, corrections included).
    'running_balance', 'reversed_by', 'reversal_reason', 'solvency_bypass_reason',
  ];
  // Payout destinations, funder identities: forbidden for the agent persona. The partner persona
  // may read its OWN payout destination, but only through assistant_mask_tail() (last 3 digits).
  const AGENT_ONLY_FORBIDDEN = ['mobile_money\\w*', 'account_number', 'bank_\\w+', 'supporter_id', 'funder\\w*', 'momo_\\w+'];
  const toRegex = (list) => new RegExp('\\b(' + list.join('|') + ')\\b', 'i');
  const FORBIDDEN_COLUMNS = toRegex([...COMMON_FORBIDDEN, ...AGENT_ONLY_FORBIDDEN]);
  const FORBIDDEN_COLUMNS_PARTNER = toRegex([...COMMON_FORBIDDEN, ...PARTNER_ONLY_FORBIDDEN]);
  const PAYOUT_NUMBER_COLUMNS = /\b(?:mobile_money_number|account_number|bank_account_number|momo_number)\b/gi;
  const MASKED_PAYOUT_NUMBER = /assistant_mask_tail\(\s*(?:[a-z_]+\.)?(?:mobile_money_number|account_number|bank_account_number|momo_number)\s*\)/gi;
  const FORBIDDEN_FIELD_NOTES = /\b[a-z0-9_]+\.notes\b/i;

  const latestPartnerBodies = new Map(); // the definition that is live once every migration has run
  for (const file of files) {
    const body = stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    for (const m of body.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(assistant_[a-z_]+)\s*\([\s\S]*?\bas\s+(\$[a-z_]*\$)([\s\S]*?)\2/gi)) {
      const isPartnerFn = m[1].startsWith('assistant_partner_');
      if (isPartnerFn) latestPartnerBodies.set(m[1], { file, text: m[3] });
      const hit = m[3].match(isPartnerFn ? FORBIDDEN_COLUMNS_PARTNER : FORBIDDEN_COLUMNS) || m[3].match(FORBIDDEN_FIELD_NOTES);
      if (hit) fail(`${file}: ${m[1]}() references "${hit[0]}", a field that must never leave the database through the assistant (it is sent to a third-party model).`);
      if (isPartnerFn) {
        // A full payout number may only ever appear as the argument of assistant_mask_tail().
        const bare = m[3].replace(MASKED_PAYOUT_NUMBER, ' ').match(PAYOUT_NUMBER_COLUMNS);
        if (bare) fail(`${file}: ${m[1]}() uses "${bare[0]}" outside assistant_mask_tail(); partners only ever see the last three digits of a payout number.`);
      }
    }
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(assistant_[a-z_]+)\s*\(([\s\S]*?)\)\s*returns\s+[\s\S]*?\bas\s+\$[a-z_]*\$/gi;
    for (const m of body.matchAll(re)) {
      const name = m[1];
      const header = m[0];
      const args = m[2];
      defined.set(name, { file, header, args, body });
    }
  }

  // Partner persona, live definitions only: no reversals and no admin corrections reach a partner.
  for (const [name, { file, text }] of latestPartnerBodies) {
    if (/ledger_scope\s*=\s*'wallet'/i.test(text) && !/is_customer_wallet_history_visible\s*\(/i.test(text)) {
      fail(`${file}: ${name}() reads wallet ledger rows without public.is_customer_wallet_history_visible(); admin corrections and reversals must be filtered out.`);
    }
    if (text.replace(/reversed_at\s+is\s+null/gi, ' ').match(/\breversed_at\b/i)) {
      fail(`${file}: ${name}() reads reversed_at other than as "reversed_at is null"; reversed items must be left out, never listed or flagged.`);
    }
  }

  seen.sqlFunctions = defined.size;
  if (existsSync(FN_DIR) && !defined.size) fail('no assistant_* functions found in migrations — the guard cannot verify them.');
  for (const [name, { file, header, args, body }] of defined) {
    const where = `${file}: ${name}()`;
    // Trigger functions are not callable over the API, so the tool-RPC rules do not apply.
    if (/returns\s+trigger/i.test(header)) continue;
    if (!GATE_HELPERS.has(name) && !/\bstable\b/i.test(header)) fail(`${where} must be STABLE (read-only).`);
    if (!/security\s+definer/i.test(header)) fail(`${where} must be SECURITY DEFINER (it reads tables the caller has no direct grant on).`);
    if (!/set\s+search_path\s*=/i.test(header)) fail(`${where} must pin search_path.`);
    if (/(^|[\s,(])(p_)?(user|agent|tenant|account|owner)_?id\b/i.test(args)) {
      fail(`${where} takes an identity parameter. Identity must be auth.uid(), never an argument.`);
    }
    const revoked = new RegExp(`revoke\\s+(?:execute|all)\\s+on\\s+function\\s+(?:public\\.)?${name}\\s*\\([^)]*\\)\\s+from\\s+[^;]*\\banon\\b`, 'i');
    if (!revoked.test(body)) fail(`${where} must REVOKE EXECUTE ... FROM public, anon (new functions are anon-callable by default).`);
  }

  for (const name of GATE_HELPERS) {
    if (existsSync(FN_DIR) && !defined.has(name)) fail(`no migration defines ${name}() — the agent gate is missing.`);
  }
}

// ---------------------------------------------------------------- secrets in source
// A provider key must live only in the Supabase secret store. Scan shipped source for anything
// shaped like an OpenAI key. (.env is deliberately not read: it is hands-off.)
const SECRET_SHAPE = /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{24,}\b/;
const SCAN_DIRS = [SRC_DIR, join(ROOT, 'supabase', 'functions'), join(ROOT, 'scripts')];
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir).filter((f) => /\.(ts|tsx|js|mjs|json|toml)$/.test(f))) {
    if (statSync(file).size > 2_000_000) continue;
    if (SECRET_SHAPE.test(readFileSync(file, 'utf8'))) {
      fail(`${relative(ROOT, file).replace(/\\/g, '/')}: contains something shaped like an API key (sk-...). Keys belong in the Supabase secret store, never in source.`);
    }
  }
}

// ---------------------------------------------------------------- frontend
for (const file of walk(SRC_DIR).filter((f) => /\.(ts|tsx)$/.test(f))) {
  const code = readFileSync(file, 'utf8');
  if (/OPENAI_API_KEY|VITE_OPENAI/.test(code)) {
    fail(`${relative(ROOT, file).replace(/\\/g, '/')}: the provider key must never be referenced in the frontend.`);
  }
  if (/\.rpc\(\s*["'`]assistant_/.test(code)) {
    fail(`${relative(ROOT, file).replace(/\\/g, '/')}: the frontend must not call assistant_* RPCs directly; use the agent-assistant edge function.`);
  }
}

if (errors.length) {
  console.error(`[guard:assistant-readonly] ${errors.length} violation(s):\n`);
  for (const e of errors) console.error(`  - ${e}\n`);
  process.exit(1);
}
console.log(
  `[guard:assistant-readonly] ok — assistant is read-only and user-scoped ` +
    `(${seen.sources} function sources, ${seen.toolRpcs} tool RPCs, ${seen.sqlFunctions} SQL functions checked)`,
);
