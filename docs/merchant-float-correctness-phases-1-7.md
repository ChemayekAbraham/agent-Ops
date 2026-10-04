# Merchant Float Correctness — Phases 1–7 (implementation record)

Scope: make the merchant float figure single-sourced, self-refreshing, visible when negative,
guarded at the database level on every correcting write, and continuously self-testing.

Explicitly **out of scope** (separate workstreams, not touched here):

- Historical damage — UGX 32,810,000 double reversal, UGX 36,780,000 Bayo Mercy duplicate,
  UGX 374,895,199 `UNKNOWN_NEEDS_REVIEW` queue. Each needs a named, CFO-approved reversing entry,
  one item at a time.
- Wiring `vitest` / `supabase/tests/*.sql` into CI. Real gap (nothing runs on push), orthogonal to
  money correctness.

---

## 1. Tables

| Table | Change | Purpose |
| --- | --- | --- |
| `wallet_balances_projection` | added to the `supabase_realtime` publication (Phase 4) | pushes float changes to both screens instantly |
| `platform_wallet_corrections` | **new** (Phase 6) | evidenced, authorised record required behind any platform-wide wallet correction leg |
| `merchant_float_reconciliations` | guard trigger (earlier phase) | role + non-self + ≥20-char evidence |
| `agent_landlord_float_corrections` | guard trigger **new** (Phase 7) | same gate as above; it was the one uncovered correcting path |
| `finance_anomaly_alert_states` | reused (Phase 7) | one row per acceptance check, `acceptance:<check_key>` |
| `finance_anomaly_alert_config` | reused (Phase 7) | recipient list for regression alerts |

`platform_wallet_corrections` (shape):

```sql
CREATE TABLE public.platform_wallet_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL,
  correction_type text NOT NULL,      -- direct_credit | direct_debit | float_to_withdrawable | ...
  amount numeric NOT NULL CHECK (amount > 0),
  evidence_note text NOT NULL,        -- >= 20 chars, enforced by trigger
  authorized_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.platform_wallet_corrections TO authenticated;
GRANT ALL ON public.platform_wallet_corrections TO service_role;
ALTER TABLE public.platform_wallet_corrections ENABLE ROW LEVEL SECURITY;
```

---

## 2. RPCs / triggers

### `get_merchant_float_positions()` — Phase 3 read-repair backstop

Serving stale projections was the root of "board and phone disagree". The board now repairs before
it reads, mirroring what `get_wallets_batch` already did:

```sql
  -- Backstop read-repair: recompute any merchant desk projection that is
  -- missing or stale (older than the newest wallet ledger leg) before serving.
  FOR v_agent_id IN
    SELECT DISTINCT ca.agent_id FROM public.cashout_agents ca WHERE ca.agent_id IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.wallet_balances_projection w
      WHERE w.user_id = v_agent_id
        AND w.updated_at >= COALESCE((
          SELECT MAX(g.created_at) FROM public.general_ledger g
          WHERE g.user_id = v_agent_id AND g.ledger_scope = 'wallet'
        ), w.updated_at)
    ) THEN
      PERFORM public.refresh_wallet_projection_for(v_agent_id);
    END IF;
  END LOOP;
```

The function was also switched to `VOLATILE` (it now writes during a read) and its staleness flag
is derived from timestamps — the earlier `w.is_dirty` reference was to a column that never existed
and produced *"BOARD COULD NOT LOAD"*.

### `record_merchant_float_delivery(...)` — Phase 2

Synchronous refresh straight after the money moves, instead of waiting for a dirty-flag sweep:

```sql
  PERFORM public.refresh_wallet_projection_for(v_agent_id);
```

Execute privilege restricted to `service_role`.

### `guard_agent_landlord_float_correction()` — Phase 7 (new)

```sql
CREATE OR REPLACE FUNCTION public.guard_agent_landlord_float_correction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT (public.has_role(auth.uid(), 'cfo')
         OR public.has_role(auth.uid(), 'financial_ops')
         OR public.has_role(auth.uid(), 'super_admin')) THEN
      RAISE EXCEPTION 'Only CFO, Financial Ops or Super Admin may correct agent landlord float';
    END IF;
    IF NEW.agent_id = auth.uid() THEN
      RAISE EXCEPTION 'You cannot author a float correction on your own account';
    END IF;
  END IF;
  IF char_length(btrim(COALESCE(NEW.reason, ''))) < 20 THEN
    RAISE EXCEPTION 'A correction needs at least 20 characters of evidence';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_guard_agent_landlord_float_correction
BEFORE INSERT ON public.agent_landlord_float_corrections
FOR EACH ROW EXECUTE FUNCTION public.guard_agent_landlord_float_correction();
```

### `run_payout_acceptance_checks(p_window_days int default 7)` — 23 checks

Extended with the four structural invariants (P4) plus the incident-specific check. Added rows:

```sql
  -- (i) No reporting RPC may emit the same expression under two output names
  RETURN QUERY SELECT 'no_duplicate_money_columns', ...

  -- (ii) A reconciliation row and a ledger leg may never both feed one total
  RETURN QUERY SELECT 'no_double_counted_correction', ...

  -- (iii) Every correcting insert path is role-checked and non-self-authored
  SELECT count(*) INTO v_n
  FROM (VALUES ('merchant_float_reconciliations'),
               ('platform_wallet_corrections'),
               ('agent_landlord_float_corrections')) tbls(tbl)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_proc pr ON pr.oid = tg.tgfoid
    WHERE c.relname = tbls.tbl
      AND NOT tg.tgisinternal
      AND (tg.tgtype & 2) > 0   -- BEFORE
      AND (tg.tgtype & 4) > 0   -- INSERT
      AND pr.prosrc ILIKE '%has_role%'
      AND pr.prosrc ILIKE '%auth.uid()%');
  RETURN QUERY SELECT 'correction_paths_gated', ...

  -- (iv) Every create_ledger_transaction group nets to zero
  SELECT count(*), coalesce(sum(abs(t.net)), 0) INTO v_n, v_amt
  FROM (SELECT g.transaction_group_id,
               sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) AS net
        FROM general_ledger g
        WHERE g.created_at >= v_since AND g.transaction_group_id IS NOT NULL
        GROUP BY g.transaction_group_id HAVING count(*) > 1) t
  WHERE round(t.net, 2) <> 0;
  RETURN QUERY SELECT 'ledger_groups_net_zero', ...
```

**Incident-specific check (new, this turn).** The board reads
`wallet_balances_projection.float_balance`; the merchant's own card reads `wallets.float_balance`
through `get_merchant_float_position()`. After Phases 1–4 these are identical by construction, so
divergence is a regression and now fails within the hour:

```sql
  -- (v) Ops board figure == the desk agent's own figure, for every active desk
  SELECT count(*), COALESCE(SUM(abs(t.diff)), 0) INTO v_n, v_amt
  FROM (
    SELECT ca.id AS desk_id,
           GREATEST(COALESCE(wp.float_balance, 0), 0)
             - GREATEST(COALESCE(w.float_balance, 0), 0) AS diff
    FROM cashout_agents ca
    LEFT JOIN wallet_balances_projection wp ON wp.user_id = ca.agent_id
    LEFT JOIN wallets w ON w.user_id = ca.agent_id
    WHERE ca.is_active IS TRUE AND ca.agent_id IS NOT NULL
  ) t
  WHERE abs(t.diff) > 0.5;
  RETURN QUERY SELECT
    'merchant_board_matches_agent_view',
    'Every active desk shows the same float on the ops board and on the agent phone',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s active desk(s) disagree between the ops board and the agent view (UGX %s total gap)', v_n, round(v_amt));
```

### `run_payout_acceptance_scan(p_trigger_source text, p_window_days int)` — new

Runs the checks, upserts one `finance_anomaly_alert_states` row per check
(`acceptance:<check_key>`, fails as `financial_integrity` / `email` / `high`), emits a
`report_generation_failed` system event when anything fails, and returns the full report.
`EXECUTE` granted to `service_role` only.

---

## 3. Edge functions

### `supabase/functions/approve-withdrawal/index.ts` — Phase 2

The settlement path did **not** refresh the projection; it relied on the trigger's O(1) dirty flag.
Added a synchronous refresh for the merchant agent's `user_id` only, at both money-moving points:

```ts
// after merchant float consumption
try {
  await admin.rpc("refresh_wallet_projection_for", { p_user_id: user.id });
} catch (refreshErr) {
  console.error("[approve-withdrawal] refresh_wallet_projection_for failed after merchant float consume:", refreshErr);
}

// after the merchant telecom charge leg
try {
  await admin.rpc("refresh_wallet_projection_for", { p_user_id: user.id });
} catch (refreshErr) {
  console.error("[approve-withdrawal] refresh_wallet_projection_for failed after merchant telecom charge:", refreshErr);
}
```

### `supabase/functions/payout-acceptance-scan/index.ts` — Phase 7 (new)

```ts
const { data, error } = await admin.rpc("run_payout_acceptance_scan", {
  p_trigger_source: triggerSource,
  p_window_days: windowDays,
});
if (error) throw new Error(`acceptance scan failed: ${error.message}`);

const checks = (data.checks ?? []) as CheckRow[];
const failing = checks.filter((c) => c.status === "fail");
if (failing.length > 0 && data.alerts_enabled) {
  // recipients come from finance_anomaly_alert_config.notify_emails
  await sendEmail(recipients, subject, buildHtml(data, checks));
}
```

Deployed and verified live: `total_checks: 23`, all five new invariants `pass`, alert email
`queued` to the configured finance recipient.

### `cfo-direct-credit`, `admin-float-to-withdrawable`, `admin-withdrawable-to-float` — Phase 6

Each now records an authorised `platform_wallet_corrections` row before posting ledger legs, and
requires ≥20 characters of evidence. Roles narrowed to `cfo`, `financial_ops`, `super_admin`
(`manager` and `cto` excluded).

---

## 4. Scheduling

```sql
SELECT cron.schedule(
  'run-payout-acceptance-checks',
  '10 5 * * *',                     -- 08:10 Nairobi, daily
  $$ SELECT net.http_post(
       url := '<project>/functions/v1/payout-acceptance-scan',
       headers := '{"Content-Type":"application/json","apikey":"<anon>"}'::jsonb,
       body := jsonb_build_object('trigger_source','cron_daily','window_days',7)
     ); $$
);
```

Same registration pattern as `detect-merchant-float-variances`.

---

## 5. Frontend files changed

`src/hooks/useMerchantFloat.ts` — Phase 4 ref-counted realtime channels per visible `user_id`:

```ts
supabase
  .channel(`merchant-float-projection-${userId}`)
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'wallet_balances_projection', filter: `user_id=eq.${userId}` },
    () => {
      qc.invalidateQueries({ queryKey: ['merchant-float-positions'] });
      qc.invalidateQueries({ queryKey: ['merchant-payout-float'] });
    })
```

`src/components/agent/MerchantFloatAvailableCard.tsx` — Phase 5, merchant-side hidden deficit:

```tsx
{mine?.clampedShortfall > 0 && (
  <div className="mt-3 rounded-2xl border-2 border-dashed border-destructive/60 bg-destructive/10 p-3">
    <p className="text-[11px] font-semibold uppercase tracking-wider text-destructive">Hidden deficit on your desk</p>
    <p className="mt-1 font-mono text-lg font-bold tabular-nums text-destructive">{formatUGX(mine.clampedShortfall)}</p>
    <p className="mt-1 text-[10px] text-muted-foreground">
      Your true position is negative by this much — it can't show as a negative number, but this is real, not spendable float.
    </p>
  </div>
)}
```

`src/components/financial-ops/MoneyWithAgentsCard.tsx` — Phase 5, identical block aggregated
across desks (`deficitTotal`, `deficitRows.length`).

---

## 6. Current state

- 23 acceptance checks run daily and on demand.
- Only failing row is the pre-existing data finding `no_stranded_claims` (plus 2 warnings) — a real
  queue condition, not a structural regression.
- Board vs agent-phone float agreement is now asserted for every active desk.