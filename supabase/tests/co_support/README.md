# Co-support Phase 1: local rehearsal kit

Throwaway-Postgres tests for `migrations/20261115090000_co_support_phase1.sql`
and `rollbacks/20261115090000_co_support_phase1.rollback.sql`.

- `template.sql`, `rollback_template.sql` + `build.js`: the migration and rollback are
  generated. `build.js` inserts the live bodies of `psm_disburse_landlord_float`,
  `psm_activate_line_on_disbursement` and the fundable-plans view, after checking their
  md5 against production (2026-11-11). Edit the templates, never the generated files.
- `stub_base.sql` + `build_base.js`: a minimal stand-in for production. The five money
  functions co-support calls are the live bodies, byte for byte.
- `reset.sh`: rebuilds db `cosup_test` on localhost:55432 and applies the migration
  (`NOMIG=1` skips the migration).
- `test.sql`: functional walk-through (T1–T8).
- `test2.sql`: 25 independent scenarios (security, money edges, eligibility, lifecycle, chaos).
- `race.sh`: 4 concurrency races × ROUNDS.
- `sre.sh`: lock inventory, lock_timeout, apply/rollback timing at volume, rollback
  fidelity, re-apply, real role checks, latency.

The scripts still point at the scratchpad copy (`S=` / `MIG=` at the top). Change
those paths before running them from this folder.
