---
name: agent-float-four-line-split
description: Agent float four-line split migration 20261127120000 and the 2026-11-17 reconcile batch are already live; never re-run or re-apply them
type: constraint
---

The agent float four-line split accounting (CFO decision 17 Nov 2026: agent float = what
agents hold in float wallets) is already in production. Never re-run or re-apply any of it:

- Migration `supabase/migrations/20261127120000_agent_float_four_line_split.sql` (plus its
  rollback `supabase/rollbacks/20261127120000_agent_float_four_line_split.rollback.sql`) is
  ALREADY APPLIED in production.
- Correction batch `docs/finance/corrections/2026-11-17_agent_float_to_reconcile.sql` and its
  `_preview.sql` are ALREADY POSTED.
- Covering test: `src/test/agentFloatSplit.db.test.ts` (runs in PGlite, never against
  production).
- Fixture: `scripts/fixtures/ledger-allowlist-prod-2026-11-17.sql`.

Pushed by the CFO on 16 Nov 2026 (commit 46ccca64a4, accounting only — no edge functions, no
deploys).
