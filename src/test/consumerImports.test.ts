/**
 * Every named import of the Partner Returns browser modules must exist (design v2 §10.2).
 * The build runs no tsc, and a missing named export only shows up as `undefined` at runtime, so
 * this reads each importer's source and checks every value it imports against the real module.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), auth: {}, functions: {} } }));

import * as partnerReturnPolicy from '@/lib/partnerReturnPolicy';
import * as usePartnerReturnPolicy from '@/hooks/usePartnerReturnPolicy';
import * as usePartnerQuoteRate from '@/hooks/usePartnerQuoteRate';
import * as planShareLink from '@/lib/planShareLink';
import * as funderEarnings from '@/lib/funderEarnings';
import * as supportPlanExample from '@/lib/supportPlanExample';
import * as houseSupportShare from '@/lib/houseSupportShare';
import * as nexaSalesEngine from '@/lib/nexaSalesEngine';
import * as publicPartnerRate from '@/lib/publicPartnerRate';
import * as staffPortfolioRate from '@/lib/staffPortfolioRate';
import * as useStaffPortfolioRate from '@/hooks/useStaffPortfolioRate';
import * as promissoryNoteActivation from '@/lib/promissoryNoteActivation';

const MODULES: Record<string, Record<string, unknown>> = {
  'lib/staffPortfolioRate': staffPortfolioRate,
  'hooks/useStaffPortfolioRate': useStaffPortfolioRate,
  'lib/promissoryNoteActivation': promissoryNoteActivation,
  'lib/partnerReturnPolicy': partnerReturnPolicy,
  'hooks/usePartnerReturnPolicy': usePartnerReturnPolicy,
  'hooks/usePartnerQuoteRate': usePartnerQuoteRate,
  'lib/planShareLink': planShareLink,
  'lib/funderEarnings': funderEarnings,
  'lib/supportPlanExample': supportPlanExample,
  'lib/houseSupportShare': houseSupportShare,
  'lib/nexaSalesEngine': nexaSalesEngine,
  'lib/publicPartnerRate': publicPartnerRate,
};

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__snapshots__') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Resolve an import specifier from `file` to a MODULES key, or null. */
function moduleKey(file: string, spec: string): string | null {
  let target: string;
  if (spec.startsWith('@/')) target = spec.slice(2);
  else if (spec.startsWith('.')) target = relative(SRC, join(file, '..', spec)).split(sep).join('/');
  else return null;
  target = target.replace(/\.(ts|tsx)$/, '');
  return target in MODULES ? target : null;
}

// Also matches `import Default, { a, b } from '…'` (the default name is not checked).
const IMPORT_RE = /import\s+(type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /export\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;

function namedValues(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('type '))
    .map((s) => s.split(/\s+as\s+/)[0].trim());
}

describe('Partner Returns browser modules: every named import exists', () => {
  const problems: string[] = [];
  let checked = 0;
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const re of [IMPORT_RE, EXPORT_FROM_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (m[1]) continue; // `import type { ... }`
        const key = moduleKey(file, m[3]);
        if (!key) continue;
        for (const name of namedValues(m[2])) {
          checked++;
          if (!(name in MODULES[key])) problems.push(`${relative(SRC, file)} imports missing '${name}' from ${key}`);
        }
      }
    }
  }

  it('finds the importers', () => {
    expect(checked).toBeGreaterThan(5);
  });

  it('has no import of a name the module does not export', () => {
    expect(problems).toEqual([]);
  });
});
