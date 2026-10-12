import { describe, it, expect } from 'vitest';
import { hostRefusal, PRODUCTION_PROJECT_REF } from './foodDbTestGate';

/**
 * The Food database harness writes auth.users, profiles and orders. These
 * cases prove it refuses every endpoint that is not a deliberately chosen
 * disposable database — above all, the live project. No connection is made.
 */
describe('Food DB harness never reaches a live database', () => {
  it('allows a local disposable cluster', () => {
    expect(hostRefusal({ PGHOST: '127.0.0.1' })).toBeNull();
    expect(hostRefusal({ PGHOST: 'localhost' })).toBeNull();
  });

  it('refuses the production project in any connection field, with no override', () => {
    const prodHost = `db.${PRODUCTION_PROJECT_REF}.supabase.co`;
    expect(hostRefusal({ PGHOST: prodHost })).toMatch(/PRODUCTION/);
    expect(hostRefusal({ PGHOST: prodHost, FOOD_DB_ALLOW_HOST: prodHost })).toMatch(/PRODUCTION/);
    expect(hostRefusal({ PGHOST: 'aws-0-eu.pooler.supabase.com', PGUSER: `postgres.${PRODUCTION_PROJECT_REF}` }))
      .toMatch(/PRODUCTION/);
    expect(hostRefusal({ PGHOST: '127.0.0.1', DATABASE_URL: `postgres://x@db.${PRODUCTION_PROJECT_REF}.supabase.co/postgres` }))
      .toMatch(/PRODUCTION/);
  });

  it('refuses any other remote host unless that exact host is allow-listed', () => {
    expect(hostRefusal({ PGHOST: 'db.someproject.supabase.co' })).toMatch(/not a local cluster/);
    expect(hostRefusal({ PGHOST: 'db.someproject.supabase.co', FOOD_DB_ALLOW_HOST: 'db.other.supabase.co' }))
      .toMatch(/not a local cluster/);
    expect(hostRefusal({ PGHOST: 'db.someproject.supabase.co', FOOD_DB_ALLOW_HOST: 'db.someproject.supabase.co' }))
      .toBeNull();
  });

  it('refuses settings that could redirect the driver behind PGHOST', () => {
    expect(hostRefusal({ PGHOST: '127.0.0.1', PGHOSTADDR: '10.0.0.5' })).toMatch(/redirect/);
    expect(hostRefusal({ PGHOST: '127.0.0.1', PGSERVICE: 'prod' })).toMatch(/redirect/);
    expect(hostRefusal({ PGHOST: '127.0.0.1', DATABASE_URL: 'postgres://x@elsewhere/db' })).toMatch(/redirect/);
  });
});
