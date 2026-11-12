import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('service-only funder float RPC callers', () => {
  for (const [name, client] of [
    ['create-portfolio-invite', 'admin'],
    ['approve-pending-portfolio', 'admin'],
    ['approve-portfolio-topup', 'supabase'],
    ['portfolio-topup', 'supabase'],
  ]) {
    it(`${name} uses a session-isolated service client for arbitrary-user float`, () => {
      const source = readFileSync(`supabase/functions/${name}/index.ts`, 'utf8');
      const setup = new RegExp(`const ${client} = createClient\\(supabaseUrl, serviceKey, \\{([\\s\\S]*?)\\n    \\}\\);`).exec(source);
      expect(setup).not.toBeNull();
      expect(setup?.[1]).toMatch(/persistSession:\s*false/);
      expect(setup?.[1]).toMatch(/autoRefreshToken:\s*false/);
      expect(setup?.[1]).toMatch(/detectSessionInUrl:\s*false/);
      expect(setup?.[1]).not.toMatch(/Authorization/);
      expect(source).toMatch(new RegExp(`${client}\\.rpc\\(\\s*"funder_float_available"`));
      expect(source).not.toMatch(/userClient\.rpc\(\s*"funder_float_available"/);
    });
  }
});