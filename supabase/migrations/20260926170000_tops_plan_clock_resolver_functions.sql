-- Tenant Ops Workspace — resolver functions for tops_plan_clock /
-- tops_plan_instalments.
--
-- Per docs/TOPS_RULES.md: new functions only. Nothing existing is touched.
-- These are the only writers of tops_plan_clock / tops_plan_instalments /
-- tops_instalment_settlements (client grants on those tables remain SELECT
-- only). Each function is owned by the same role that owns those tables, so
-- it can write to them despite RLS being enabled; EXECUTE is revoked from
-- PUBLIC, anon and authenticated on every one of them (no user-facing caller
-- — internal engine, driven by the cron job registered at the end of this
-- file). The explicit anon/authenticated revoke matters: this schema has a
-- pre-existing default-privilege rule that grants EXECUTE on every new
-- function straight to those roles at CREATE time (the same mechanism
-- observed on tops_plan_clock's table grants in the prior migration), so
-- revoking FROM PUBLIC alone would leave the SECURITY DEFINER privilege
-- reachable by anon.
--
-- clock_start basis (per docs/TOPS_FINDINGS.md §4): the Kampala date of the
-- landlord receipt event, identified there as landlord_payouts.otp_verified_at
-- — the one field populated on every landlord_payouts row and the only one
-- of the four candidate timestamps that requires the landlord's own phone at
-- the moment of payout. Falls back to rent_requests.funded_at (falling back
-- further to disbursed_at/created_at only so clock_start is never null,
-- mirroring the existing funding-timestamp fallback chain but WITHOUT
-- repayment_starts_on, which FINDINGS documents as a plain, back-datable
-- column — this resolver never reads or writes it, per the explicit
-- instruction for this task.
--
-- cadence basis (per docs/TOPS_FINDINGS.md §3): FINDINGS distinguishes
-- rent_requests.repayment_frequency being merely present (DEFAULT 'daily',
-- true for 100% of rows) from being explicitly confirmed
-- (repayment_frequency_locked = true, true for only 5 of 820 active plans
-- today). "The explicit source" in this task's brief is that locked value —
-- an unlocked column is not treated as explicit, matching this system's
-- deliberately conservative, never-infer stance (rule: "NEVER infer cadence
-- from payment gaps, even though an existing function does"). A locked
-- 'monthly' value also resolves to unknown: tops_plan_clock's own cadence
-- CHECK (from the prior migration) only allows daily/weekly/unknown, and
-- tops_build_plan_instalments below only has a daily/weekly branch — monthly
-- plans are out of scope for this pass of the workspace, not silently
-- miscategorised as one of the other two.

-- ---------------------------------------------------------------------------
-- 1. tops_resolve_plan_clock — upserts tops_plan_clock for one plan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_resolve_plan_clock(p_rent_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_source text;
  v_funded_at timestamptz;
  v_disbursed_at timestamptz;
  v_created_at timestamptz;
  v_locked boolean;
  v_frequency text;
  v_landlord_receipt_at timestamptz;
  v_clock_start date;
  v_clock_source text;
  v_cadence text;
  v_cadence_source text;
  v_dow smallint;
BEGIN
  SELECT clock_source INTO v_existing_source
  FROM public.tops_plan_clock
  WHERE rent_request_id = p_rent_request_id;

  -- An override is a deliberate human correction; never recompute over it.
  IF v_existing_source = 'override' THEN
    RETURN;
  END IF;

  SELECT rr.funded_at, rr.disbursed_at, rr.created_at,
         rr.repayment_frequency_locked, rr.repayment_frequency
  INTO v_funded_at, v_disbursed_at, v_created_at, v_locked, v_frequency
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT MIN(lp.otp_verified_at) INTO v_landlord_receipt_at
  FROM public.landlord_payouts lp
  WHERE lp.rent_request_id = p_rent_request_id;

  IF v_landlord_receipt_at IS NOT NULL THEN
    v_clock_start := (v_landlord_receipt_at AT TIME ZONE 'Africa/Kampala')::date;
    v_clock_source := 'landlord_receipt';
  ELSE
    v_clock_start := (COALESCE(v_funded_at, v_disbursed_at, v_created_at) AT TIME ZONE 'Africa/Kampala')::date;
    v_clock_source := 'funded_at';
  END IF;

  IF v_locked IS TRUE AND v_frequency IN ('daily', 'weekly') THEN
    v_cadence := v_frequency;
    v_cadence_source := 'explicit';
  ELSE
    v_cadence := 'unknown';
    v_cadence_source := 'unknown';
  END IF;

  v_dow := CASE WHEN v_cadence = 'weekly' THEN EXTRACT(DOW FROM v_clock_start)::smallint ELSE NULL END;

  INSERT INTO public.tops_plan_clock (
    rent_request_id, clock_start, clock_source, cadence, cadence_source, weekly_due_dow, updated_at
  ) VALUES (
    p_rent_request_id, v_clock_start, v_clock_source, v_cadence, v_cadence_source, v_dow, now()
  )
  ON CONFLICT (rent_request_id) DO UPDATE SET
    clock_start = EXCLUDED.clock_start,
    clock_source = EXCLUDED.clock_source,
    cadence = EXCLUDED.cadence,
    cadence_source = EXCLUDED.cadence_source,
    weekly_due_dow = EXCLUDED.weekly_due_dow,
    updated_at = now()
  WHERE public.tops_plan_clock.clock_source <> 'override';
END;
$$;

REVOKE ALL ON FUNCTION public.tops_resolve_plan_clock(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_resolve_plan_clock(uuid) IS
'Internal engine only (no EXECUTE grant to anon/authenticated): upserts tops_plan_clock for one plan from rent_requests + landlord_payouts. Never overwrites a row whose clock_source = override.';

-- ---------------------------------------------------------------------------
-- 2. tops_build_plan_instalments — regenerates one plan's instalments from
--    its resolved clock.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_build_plan_instalments(p_rent_request_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clock_start date;
  v_cadence text;
  v_duration_days integer;
  v_daily_repayment numeric(14,2);
  v_total_repayment numeric(14,2);
  v_n integer;
  v_regular numeric(14,2);
BEGIN
  SELECT clock_start, cadence INTO v_clock_start, v_cadence
  FROM public.tops_plan_clock
  WHERE rent_request_id = p_rent_request_id;

  IF NOT FOUND OR v_cadence = 'unknown' THEN
    RETURN 0;
  END IF;

  SELECT duration_days, daily_repayment, total_repayment
  INTO v_duration_days, v_daily_repayment, v_total_repayment
  FROM public.rent_requests
  WHERE id = p_rent_request_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF v_cadence = 'daily' THEN
    v_n := v_duration_days;
    v_regular := v_daily_repayment;

    INSERT INTO public.tops_plan_instalments (rent_request_id, seq, due_date, amount_ugx, updated_at)
    SELECT
      p_rent_request_id,
      s,
      v_clock_start + s,
      CASE WHEN s < v_n THEN v_regular ELSE v_total_repayment - v_regular * (v_n - 1) END,
      now()
    FROM generate_series(1, v_n) AS s
    ON CONFLICT (rent_request_id, seq) DO UPDATE SET
      due_date = EXCLUDED.due_date,
      amount_ugx = EXCLUDED.amount_ugx,
      updated_at = now();

  ELSIF v_cadence = 'weekly' THEN
    v_n := CEIL(v_duration_days::numeric / 7)::integer;
    v_regular := v_daily_repayment * 7;

    INSERT INTO public.tops_plan_instalments (rent_request_id, seq, due_date, amount_ugx, updated_at)
    SELECT
      p_rent_request_id,
      s,
      v_clock_start + (7 * s),
      CASE WHEN s < v_n THEN v_regular ELSE v_total_repayment - v_regular * (v_n - 1) END,
      now()
    FROM generate_series(1, v_n) AS s
    ON CONFLICT (rent_request_id, seq) DO UPDATE SET
      due_date = EXCLUDED.due_date,
      amount_ugx = EXCLUDED.amount_ugx,
      updated_at = now();

  ELSE
    RETURN 0;
  END IF;

  -- Trim stale trailing rows from a previously-longer schedule, but never
  -- one carrying a settlement — a rerun must never orphan settlement history.
  DELETE FROM public.tops_plan_instalments i
  WHERE i.rent_request_id = p_rent_request_id
    AND i.seq > v_n
    AND NOT EXISTS (
      SELECT 1 FROM public.tops_instalment_settlements s WHERE s.instalment_id = i.id
    );

  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_build_plan_instalments(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_build_plan_instalments(uuid) IS
'Internal engine only (no EXECUTE grant to anon/authenticated): regenerates tops_plan_instalments for one plan from its tops_plan_clock row. Writes nothing and returns 0 when cadence is unknown. Idempotent by (rent_request_id, seq); never deletes a settled instalment.';

-- ---------------------------------------------------------------------------
-- 3. tops_build_schedules_batch — the cron entry point.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_build_schedules_batch(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rent_request_id uuid;
  v_count integer := 0;
BEGIN
  FOR v_rent_request_id IN
    SELECT rr.id
    FROM public.rent_requests rr
    LEFT JOIN public.tops_plan_clock c ON c.rent_request_id = rr.id
    WHERE rr.status IN ('funded', 'repaying')
      AND (
        c.rent_request_id IS NULL
        OR rr.updated_at > c.updated_at
        OR NOT EXISTS (
          SELECT 1 FROM public.tops_plan_instalments i WHERE i.rent_request_id = rr.id
        )
      )
    ORDER BY rr.updated_at ASC
    LIMIT p_limit
  LOOP
    PERFORM public.tops_resolve_plan_clock(v_rent_request_id);
    PERFORM public.tops_build_plan_instalments(v_rent_request_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_build_schedules_batch(integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_build_schedules_batch(integer) IS
'Internal engine only (no EXECUTE grant to anon/authenticated): resolves clock + rebuilds instalments for funded/repaying plans with no schedule yet, or whose rent_requests row changed since it was last built. Called by the tops-build-plan-schedules-every-30min cron job.';

-- ---------------------------------------------------------------------------
-- Cron: new job only, does not touch any existing job.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'tops-build-plan-schedules-every-30min',
  '*/30 * * * *',
  $$ SELECT public.tops_build_schedules_batch(500); $$
);
