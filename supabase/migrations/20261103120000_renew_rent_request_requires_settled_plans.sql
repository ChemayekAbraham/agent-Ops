-- A tenant may only renew once every Rent Plan they hold is settled.
--
-- The rule itself already existed and is working: the trigger
-- `enforce_no_duplicate_rent_request` (20261006090000) blocks the INSERT of a
-- new plan or a renewal while the tenant still owes on a live one. Verified
-- 2026-11-03: trigger attached and enabled, body unchanged, and all 83
-- renewals that went through renew_rent_request replaced a `completed` plan
-- with nothing outstanding.
--
-- What was missing is the check in the renewal path itself. renew_rent_request
-- carried nine guards — authentication, ownership, landlord, amount, duration,
-- explanation and two GPS checks — and none of them looked at the balance. It
-- computes `fully_repaid` through _renewal_plan_stats and surfaces it as
-- advice, never as a condition. So renewals were clean by practice and by a
-- trigger two layers down, not because the renewal path said no.
--
-- Two cases did slip past the trigger since it went live, both funded and
-- genuinely owing — Kilume Robert (UGX 770,000, new plan 2026-10-08) and
-- Mugisha David (UGX 389,000, 2026-10-21) — most likely because the earlier
-- plan only moved into `repaying` after the new row was inserted, so the
-- trigger saw nothing to block at that instant. Checking up front, before any
-- work is done, closes that ordering window for the renewal path.
--
-- The predicate is copied from the trigger verbatim so the two cannot drift
-- into disagreeing: a plan that is `funded` or `repaying`, whose tenancy has
-- not ended, whose schedule is not cancelled, with any balance left. Those are
-- the only statuses where money was actually advanced — measured the same day,
-- `service_center_review` (3,783 plans) and `deleted_by_agent` (175) show a
-- combined UGX 1.1bn of total_repayment but zero landlord payouts and zero
-- collections, so they are price tags on plans that never disbursed, not debt.
--
-- The plan being renewed is deliberately NOT excluded: it is the one most
-- likely to still owe, and "all their plans complete" is the rule.
--
-- ERRCODE stays `unique_violation`, matching the trigger, so any client already
-- branching on that keeps working and the message simply arrives earlier and
-- names the renewal.
DO $patch$
DECLARE
  v_def text;
  v_decl_anchor text := '  v_allowed boolean := false;';
  v_decl_add text :=
    '  v_allowed boolean := false;' || E'\n' ||
    '  v_owing_id uuid;' || E'\n' ||
    '  v_owing_rent numeric;' || E'\n' ||
    '  v_owing_total numeric;' || E'\n' ||
    '  v_owing_balance numeric;';
  v_guard_anchor text := '  IF v_prev.landlord_id IS NULL THEN RAISE EXCEPTION ''LANDLORD_MISSING''; END IF;';
  v_guard text :=
    '  -- Every Rent Plan this tenant holds must be settled before a renewal.' || E'\n' ||
    '  -- Same predicate as enforce_no_duplicate_rent_request, kept identical on' || E'\n' ||
    '  -- purpose; the plan being renewed is included, not excluded.' || E'\n' ||
    '  SELECT id,' || E'\n' ||
    '         COALESCE(rent_amount, 0),' || E'\n' ||
    '         COALESCE(total_repayment, 0),' || E'\n' ||
    '         GREATEST(COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0), 0)' || E'\n' ||
    '    INTO v_owing_id, v_owing_rent, v_owing_total, v_owing_balance' || E'\n' ||
    '  FROM public.rent_requests' || E'\n' ||
    '  WHERE tenant_id = v_prev.tenant_id' || E'\n' ||
    '    AND status IN (''funded'', ''repaying'')' || E'\n' ||
    '    AND COALESCE(tenancy_status, ''active'') <> ''ended''' || E'\n' ||
    '    AND COALESCE(schedule_status, '''') <> ''cancelled''' || E'\n' ||
    '    AND GREATEST(COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0), 0) > 0' || E'\n' ||
    '  ORDER BY created_at DESC' || E'\n' ||
    '  LIMIT 1;' || E'\n\n' ||
    '  IF v_owing_id IS NOT NULL THEN' || E'\n' ||
    '    RAISE EXCEPTION' || E'\n' ||
    '      ''RENEWAL_BLOCKED_BALANCE_OUTSTANDING: this tenant still owes UGX % on an active Rent Plan (UGX % rent, UGX % total repayable). Clear the balance before renewing.'',' || E'\n' ||
    '      to_char(v_owing_balance, ''FM999,999,999''),' || E'\n' ||
    '      to_char(v_owing_rent,    ''FM999,999,999''),' || E'\n' ||
    '      to_char(v_owing_total,   ''FM999,999,999'')' || E'\n' ||
    '      USING ERRCODE = ''unique_violation'';' || E'\n' ||
    '  END IF;' || E'\n\n' ||
    '  IF v_prev.landlord_id IS NULL THEN RAISE EXCEPTION ''LANDLORD_MISSING''; END IF;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'renew_rent_request';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'renew_rent_request not found';
  END IF;

  IF position('RENEWAL_BLOCKED_BALANCE_OUTSTANDING' IN v_def) > 0 THEN
    RAISE NOTICE 'Completion check already present; leaving as is.';
    RETURN;
  END IF;

  IF position(v_decl_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Declaration anchor not found — refusing to patch blind.';
  END IF;
  IF position(v_guard_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Guard anchor not found — refusing to patch blind.';
  END IF;

  v_def := replace(v_def, v_decl_anchor, v_decl_add);
  v_def := replace(v_def, v_guard_anchor, v_guard);

  -- CREATE OR REPLACE keeps existing EXECUTE grants.
  EXECUTE v_def;
  RAISE NOTICE 'Completion check added to renew_rent_request.';
END
$patch$;
