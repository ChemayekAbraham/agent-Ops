// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_ACCESS_RULES, toServerRules } from '../dashboardAccessRules';

const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const strings = (source: string) => [...source.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

describe('main dashboard rules match the real route guards', () => {
  for (const rule of DASHBOARD_ACCESS_RULES) {
    it(`${rule.route} has exactly the recorded guard`, () => {
      const line = app.split('\n').find((l) => l.includes(`<Route path="${rule.route}"`));
      expect(line, `Missing route ${rule.route}`).toBeDefined();
      if (!line) return;
      const guard = line.match(/<RoleGuard\s([^>]+)>/)?.[1];
      expect(guard, `${rule.route} has no RoleGuard`).toBeDefined();
      if (!guard) return;
      const allowedRoles = strings(guard.match(/allowedRoles=\{([^}]+)\}/)?.[1] ?? '');
      const permission = guard.match(/requiredPermission=(?:"([^"]+)"|\{([^}]+)\})/);
      const requiredPermission = permission?.[1] ?? (permission?.[2] ? strings(permission[2]) : undefined);
      const skip = guard.match(/\bskipAllowlist(?:=\{(true|false)\})?/);
      const skipAllowlist = !!skip && skip[1] !== 'false';
      for (const [name, actual, recorded] of [
        ['allowedRoles', allowedRoles, rule.allowedRoles],
        ['requiredPermission', requiredPermission, rule.requiredPermission],
        ['skipAllowlist', skipAllowlist, rule.skipAllowlist],
      ]) {
        expect(actual, `${rule.route} ${name}: App.tsx=${JSON.stringify(actual)}, rule=${JSON.stringify(recorded)}`).toEqual(recorded);
      }
    });
  }

  it('platform users requires manager and the platform-user data gate, without an allowlist guard', () => {
    expect(toServerRules().find((r) => r.key === 'platform-users')).toMatchObject({
      list_keys: ['platform-users'], allowlist_applies: false,
      also_requires_role: 'manager', data_gate: 'platform_user_admin',
    });
  });

  it('guarded staff dashboards use their explicit list and require it', () => {
    for (const rule of DASHBOARD_ACCESS_RULES.filter((r) => r.key !== 'platform-users')) {
      expect(toServerRules().find((r) => r.key === rule.key), rule.route).toMatchObject({
        list_keys: [rule.requiredPermission], allowlist_applies: true, allowed_roles: rule.allowedRoles,
      });
    }
  });
});