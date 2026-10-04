#!/usr/bin/env node
/**
 * CI guard — fails the build when a Ugandan administrative location field
 * (region / district / county / sub-county / parish / village / cell / ward)
 * is CAPTURED through a raw <Input> or <Textarea> instead of the shared,
 * dataset-backed pickers (`UgLocationPicker`, `UgDistrictSelect`,
 * `Lc1ChairpersonPicker`) built on the `ug_*` reference tables.
 *
 * Why: free-typed administrative names are the root cause of duplicate
 * landlords, "Unmapped" geo buckets and listings that vanish from district
 * filters. Every NEW capture surface must resolve to an official unit id.
 *
 * What is NOT a violation (auto-detected):
 *   - search / filter / query boxes (they read, never write)
 *   - readOnly / disabled inputs (echoes of a picker selection)
 *   - free-text address & landmark fields (no administrative meaning)
 *
 * Everything else must either use a picker or carry an explicit, commented
 * entry in ALLOWLIST below.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..', 'src');

/** Administrative levels the ug_* dataset owns. */
const ADMIN_FIELD = /(sub_?county|subcounty|district|county|parish|village|cell|ward|region)/i;

/** Free-text by design — no administrative meaning, never resolved to a unit. */
const FREE_TEXT_FIELD = /(property_?address|address|landmark|street|plot|zone_?note|directions|city|town|country)/i;

/** Read-only surfaces: searching/filtering never writes a location. */
const READ_ONLY_HINT = /(search|query|filter|term|keyword|lookup|needle|q\b)/i;

/**
 * Explicit allowlist. Key = `<path under src/>:<bound identifier>`.
 * EVERY entry must carry a reason. Add one only when the field genuinely
 * cannot resolve to a Ugandan administrative unit.
 */
const ALLOWLIST = new Map([
  // Statutory: hr_pay_lst_bands.district is a Local Service Tax band label
  // published by URA, not an administrative unit — must stay free-text.
  ['components/hr/PayLstBandsPanel.tsx:district', 'statutory LST band label (URA), not an admin unit'],
  ['components/hr/PayrollRulesPanel.tsx:district', 'statutory LST band label (URA), not an admin unit'],
  // Urban-tier exception: KCCA/municipal captures use Division/Ward/Cell naming
  // that has no 1:1 ug_* row for informal zones; the district itself is still
  // picked from the dataset via DistrictCombobox in the same form.
  ['components/agent/AgentContactLocationGate.tsx:region', 'urban-tier: derived from picked district; kept for non-UG fallback'],
  ['components/agent/AgentContactLocationGate.tsx:subCounty', 'urban-tier: KCCA ward naming, no 1:1 ug_ row'],
  ['components/agent/AgentContactLocationGate.tsx:parish', 'urban-tier: KCCA cell naming, no 1:1 ug_ row'],
  ['components/agent/AgentContactLocationGate.tsx:village', 'urban-tier: informal zone naming, no 1:1 ug_ row'],
  ['components/agent/AgentContactLocationGate.tsx:district', 'non-Uganda branch (District / County) — outside the ug_* dataset'],
  // Legacy admin correction surfaces: ops staff repairing historical rows must
  // be able to reproduce the exact stored string. Net-new capture happens in
  // the picker-backed dialogs, never here.
  ['components/executive/landlord-ops/EditLandlordDialog.tsx:form', 'ops legacy-string correction on historical landlord rows'],
  ['components/cfo/CashoutAgentManager.tsx:c', 'merchant-agent operating area free note (legacy ops field)'],
  ['components/executive/AgentBulkOpsConsole.tsx:region', 'bulk-ops target filter, not a capture'],
  ['components/executive/AgentBulkOpsConsole.tsx:district', 'bulk-ops target filter, not a capture'],
  ['components/agent/Lc1ChairpersonPicker.tsx:value', 'cell/zone note beneath a dataset-picked village'],
  // Non-Uganda residence branch: "Region / State" and "District / County" are
  // outside the ug_* dataset entirely (the Uganda branch uses UgLocationPicker).
  ['components/onboarding/ProfileCompletionGate.tsx:region', 'non-Uganda residence branch — outside the ug_* dataset'],
  ['components/onboarding/ProfileCompletionGate.tsx:district', 'non-Uganda residence branch — outside the ug_* dataset'],
  // CSV bulk import review grid: shows the raw uploaded cell so ops can see and
  // correct exactly what the file contained before it is resolved server-side.
  ['components/executive/landlord-ops/BulkImportLC1Dialog.tsx:r', 'raw CSV cell shown for review before server-side resolution'],
  ['components/agent/CreateUserInviteDialog.tsx:supporterData', 'invite pre-fill hint (district/city), not a stored admin unit'],
]);

const PICKER = /(UgLocationPicker|UgDistrictSelect|DistrictCombobox|Lc1ChairpersonPicker|Lc1VillagePicker)/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      yield* walk(full);
    } else if (/\.tsx$/.test(entry)) {
      yield full;
    }
  }
}

/** Collect `<Input .../>` and `<Textarea .../>` elements with their start line. */
function elements(src) {
  const out = [];
  const re = /<(Input|Textarea)\b/g;
  let m;
  while ((m = re.exec(src))) {
    // Scan forward to the end of the opening tag, ignoring `>` inside braces.
    let depth = 0;
    let i = re.lastIndex;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    const text = src.slice(m.index, i + 1);
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ text, line, tag: m[1] });
  }
  return out;
}

const violations = [];
const skipped = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (rel.startsWith('components/location/')) continue; // the pickers themselves
  const src = readFileSync(file, 'utf8');

  for (const el of elements(src)) {
    const value = el.text.match(/\bvalue=\{([^}]*)\}/)?.[1] ?? '';
    const name = el.text.match(/\b(?:name|id|aria-label)=\{?["']([^"'}]+)/)?.[1] ?? '';
    const bound = `${value} ${name}`;
    if (!ADMIN_FIELD.test(bound) && !ADMIN_FIELD.test(el.text)) continue;
    // Auto-exempt: read-only / search / disabled / free-text-by-design.
    if (READ_ONLY_HINT.test(el.text)) { skipped.push(`${rel}:${el.line} (search/filter)`); continue; }
    if (/\b(readOnly|disabled)\b/.test(el.text)) { skipped.push(`${rel}:${el.line} (read-only)`); continue; }
    if (!ADMIN_FIELD.test(bound)) { skipped.push(`${rel}:${el.line} (label-only mention)`); continue; }
    if (FREE_TEXT_FIELD.test(bound) && !ADMIN_FIELD.test(bound.replace(FREE_TEXT_FIELD, ''))) {
      skipped.push(`${rel}:${el.line} (free-text by design)`);
      continue;
    }
    // Identify the bound state identifier, e.g. `region`, `form.district`, `c.ops.district`.
    const ident = (value.trim().match(/^[A-Za-z_$][\w$]*/)?.[0]) ?? value.trim();
    const key = `${rel}:${ident}`;
    if (ALLOWLIST.has(key)) { skipped.push(`${rel}:${el.line} (allowlisted: ${ALLOWLIST.get(key)})`); continue; }
    if (PICKER.test(src) && !ADMIN_FIELD.test(ident)) { skipped.push(`${rel}:${el.line} (picker-backed form)`); continue; }
    violations.push(`${rel}:${el.line}  <${el.tag} value={${value.trim()}}>  → key "${key}"`);
  }
}

if (violations.length > 0) {
  console.error('\n❌ guard-location-freetext: administrative location field(s) captured as free text:');
  for (const v of violations) console.error('  ' + v);
  console.error('\nFix by binding the field to the shared dataset-backed picker:');
  console.error('  import UgLocationPicker from "@/components/location/UgLocationPicker";  // region→village');
  console.error('  import UgDistrictSelect from "@/components/location/UgDistrictSelect";  // district only');
  console.error('\nIf the field genuinely cannot resolve to a ug_* unit (statutory label, urban-tier');
  console.error('naming, non-Uganda address), add a COMMENTED entry to ALLOWLIST in');
  console.error('scripts/guard-location-freetext.mjs explaining why.');
  process.exit(1);
}

console.log(`✓ guard-location-freetext: no free-text admin location capture (${skipped.length} exempt binding(s) checked)`);
