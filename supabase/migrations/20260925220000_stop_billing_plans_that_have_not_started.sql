-- Stop billing tenants for rent their landlord never received — and undo the
-- days already billed that way.
--
-- THE PROBLEM
--
-- The daily bill (agent_expected_day_plans, pinned at 00:05 EAT) was charging
-- tenants on plans that had not started. Measured across the whole pin table on
-- 25 September 2026:
--
--   plan still `funded`, never started           48 plans   459 days   9,673,523
--   billed before the landlord was paid          85 plans   203 days   6,366,500
--   completed, but billed before it started       4 plans     5 days   2,368,557
--   plan rejected                                 1 plan      1 day       13,967
--                                               ------------------------------
--                                              138 plans   668 days  18,422,547
--
-- 12.5% of everything billed. Every one of those days is a tenant shown as
-- behind on rent their landlord did not have, feeding the arrears SMS, the
-- Trust Score penalty, the agent chase tasks and the call-centre queue.
--
-- Phase 3 fixed WHEN repayment starts. It did not stop a plan that has not
-- started being billed at all, because item 15 shipped additive — the new
-- `status = 'repaying'` test was ADDED to the old payout-evidence clause in
-- v_rent_plan_schedule rather than replacing it.
--
-- WHY THE GATE IS IN THE PIN, NOT THE VIEW
--
-- The spec said to change v_rent_plan_schedule's final clause. Two things it
-- did not know:
--
--   1. That view has NINETEEN consumers — the collections command centre,
--      tenant-ops watchlists, arrears movement, the TPPO period freezes,
--      forecasts. Tightening it to stop the bill would silently restate all of
--      them.
--
--   2. There are THREE writers of the bill, not one. pin_agent_expected_day has
--      a main insert AND a past-term fallback that reads rent_requests
--      directly, bypassing the view; and pin_agent_expected_day_for_plan is a
--      per-plan backstop with no status test at all. Gating only the view would
--      have missed two of the three — as was proved during this work, when the
--      backstop silently re-created 18 of the deleted bills within minutes.
--
-- So the rule lives in one function, rent_plan_billable_from(), and all three
-- writers call it.
--
-- THE BOOKS ARE NOT AFFECTED, AND THAT IS CHECKED, NOT ASSUMED
--
-- Per the chart-of-accounts skill, only `wallet`-scope legs move money and the
-- transaction group is the unit that must balance. A pin is neither — it is an
-- obligation record. Verified before and after:
--
--   * legs in general_ledger with source_table='agent_expected_day_plans'  : 0
--   * legs with source_table='agent_expected_day_corrections'              : 0
--   * triggers on agent_expected_day_plans                                 : none
--
-- Deleting a pin posts nothing, reverses nothing and cannot unbalance a group.
-- The tenant's total obligation is unchanged — it lives in
-- rent_requests.total_repayment, untouched here. Only the SCHEDULE changes:
-- which days the same money was due on.
--
-- Money already collected is untouched. 87 of the 138 affected plans have paid
-- something (8,391,429 between them). Those collections keep their ledger legs
-- and keep reducing the plan's balance. Where a tenant has now paid more than
-- the corrected bill they read as ahead rather than behind, which is the truth.

-- ---------------------------------------------------------------------------
-- 1. One rule, shared by every writer of the bill
--
-- The earliest day a tenant may be billed is the LATER of:
--   * the plan's own declared start date, and
--   * the day after the landlord was actually paid.
--
-- Those two disagree more often than expected. A plan re-funded after an
-- allocation return keeps the first cycle's start date (a7fe92c5 says 16 Sep
-- while its landlord was paid on the 24th). A plan whose payout completed days
-- after funding was stamped from the funding date (a79f9c21 says 19 Sep,
-- landlord paid the 24th). Taking the later of the two is correct in both
-- shapes.
--
-- A plan with NO payout record at all — legacy, landlord paid off-system before
-- the payout flow existed — is unrestricted by the second test. There are 132
-- such plans carrying 19,983,660 of legitimate billing whose tenants have
-- repaid 11.3m between them. Treating "no payout row" as "never paid" would
-- have wiped all of it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rent_plan_billable_from(p_rent_request_id uuid)
RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT GREATEST(
           COALESCE(rr.repayment_starts_on, '-infinity'::date),
           COALESCE(
             (SELECT (min(COALESCE(lp.finops_disbursed_at, lp.disbursed_at))
                        AT TIME ZONE 'Africa/Kampala')::date + 1
                FROM public.landlord_payouts lp
               WHERE lp.rent_request_id = rr.id
                 AND lp.status IN ('awaiting_agent_receipt','disbursed','completed')),
             '-infinity'::date))
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id
$function$;

COMMENT ON FUNCTION public.rent_plan_billable_from(uuid) IS
  'The earliest day a tenant may be billed: the later of the plan''s declared '
  'start date and the day after the landlord was actually paid. A plan with no '
  'payout record (legacy, landlord paid off-system) is unrestricted by the '
  'second test.';

-- ---------------------------------------------------------------------------
-- 2. The audit trail
--
-- "An expectation once pinned never changes" is a deliberate property of this
-- table and this migration breaks it on purpose, once. Nothing is deleted
-- without a copy and a reason — which earned its keep immediately: a first
-- attempt at the backfill removed 338 days of legitimate history from
-- `completed` plans, and every row was restored from here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_expected_day_corrections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day             date        NOT NULL,
  rent_request_id uuid        NOT NULL,
  agent_id        uuid,
  tenant_id       uuid,
  expected_ugx    numeric     NOT NULL,
  captured_at     timestamptz,
  reason          text        NOT NULL,
  plan_status     text,
  landlord_paid_at timestamptz,
  repayment_starts_on date,
  removed_at      timestamptz NOT NULL DEFAULT now(),
  removed_by      text        NOT NULL DEFAULT 'migration:20260925220000',
  CONSTRAINT agent_expected_day_corrections_day_plan_key UNIQUE (day, rent_request_id)
);

ALTER TABLE public.agent_expected_day_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_expected_day_corrections FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_aedc_plan ON public.agent_expected_day_corrections (rent_request_id);
CREATE INDEX IF NOT EXISTS idx_aedc_day  ON public.agent_expected_day_corrections (day);

COMMENT ON TABLE public.agent_expected_day_corrections IS
  'Daily-bill rows removed because the plan had not started — the landlord had '
  'not been paid, or the plan was still funded/rejected. Keeps the original row '
  'and the reason. Nothing here touched the ledger: a pin is an obligation '
  'record, not a posting.';

-- ---------------------------------------------------------------------------
-- 3. The backfill
--
-- Only days that were never owed. NOT a blanket "status <> repaying" sweep —
-- a completed plan's pins are legitimate history and must survive.
-- ---------------------------------------------------------------------------
WITH classified AS (
  SELECT e.day, e.rent_request_id, e.agent_id, e.tenant_id, e.expected_ugx, e.captured_at,
         rr.status AS plan_status, rr.repayment_starts_on, p.paid_at AS landlord_paid_at,
         CASE
           WHEN rr.status = 'funded'
             THEN 'plan still funded — the landlord had not been paid, so repayment had not started'
           WHEN rr.status IN ('rejected','cancelled')
             THEN 'plan '||rr.status||' — must never have been billed'
           WHEN e.day < public.rent_plan_billable_from(e.rent_request_id)
             THEN 'billed before the later of its declared start and the landlord being paid'
           ELSE NULL
         END AS reason
  FROM public.agent_expected_day_plans e
  JOIN public.rent_requests rr ON rr.id = e.rent_request_id
  LEFT JOIN LATERAL (
    SELECT min(COALESCE(lp.finops_disbursed_at, lp.disbursed_at)) AS paid_at
    FROM public.landlord_payouts lp
    WHERE lp.rent_request_id = e.rent_request_id
      AND lp.status IN ('awaiting_agent_receipt','disbursed','completed')
  ) p ON TRUE
),
doomed AS (SELECT * FROM classified WHERE reason IS NOT NULL),
del AS (
  DELETE FROM public.agent_expected_day_plans e
  USING doomed d WHERE e.day = d.day AND e.rent_request_id = d.rent_request_id
  RETURNING e.day, e.rent_request_id
)
INSERT INTO public.agent_expected_day_corrections (
  day, rent_request_id, agent_id, tenant_id, expected_ugx, captured_at,
  reason, plan_status, landlord_paid_at, repayment_starts_on)
SELECT d.day, d.rent_request_id, d.agent_id, d.tenant_id, d.expected_ugx, d.captured_at,
       d.reason, d.plan_status, d.landlord_paid_at, d.repayment_starts_on
FROM del JOIN doomed d ON d.day = del.day AND d.rent_request_id = del.rent_request_id
ON CONFLICT (day, rent_request_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Writer one and two — the nightly pin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pin_agent_expected_day(p_day date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_rows int := 0; v_fallback int := 0;
begin
  if p_day is null
     or p_day > (now() at time zone 'Africa/Kampala')::date
     or p_day < public.rent_arrears_go_live() then
    return 0;
  end if;

  insert into public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  select p_day, g.rent_request_id, s.agent_id, s.tenant_id, g.amount
  from public.rent_plan_schedule_days(p_day, p_day) g
  join public.v_rent_plan_schedule s on s.rent_request_id = g.rent_request_id
  join public.rent_requests rr on rr.id = g.rent_request_id
  where rr.status = 'repaying'
    and p_day >= public.rent_plan_billable_from(rr.id)
  on conflict (day, rent_request_id) do nothing;

  get diagnostics v_rows = row_count;

  -- Past-term fallback, scoped to agents with nothing scheduled for the day.
  -- `funded` dropped from the status list: a plan whose term ended but which
  -- never started repaying is not a collection target, it is an unpaid
  -- landlord, and it belongs on the idle-float queue.
  with agents_with_bill as (
    select distinct agent_id
    from public.agent_expected_day_plans
    where day = p_day and agent_id is not null
  ), past_term as (
    select coalesce(rr.assigned_agent_id, rr.agent_id) as agent_id,
           rr.id as rent_request_id,
           rr.tenant_id,
           least(rr.daily_repayment,
                 coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0)) as expected_ugx
    from public.rent_requests rr
    where rr.status = 'repaying'
      and coalesce(rr.agent_payment_status, 'paying') <> 'not_paying'
      and lower(coalesce(rr.repayment_frequency, 'daily')) <> 'weekly'
      and coalesce(rr.daily_repayment, 0) > 0
      and coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0) > 0
      and p_day >= public.rent_plan_billable_from(rr.id)
      and (coalesce(rr.repayment_starts_on, (rr.funded_at at time zone 'Africa/Kampala')::date)
           + coalesce(rr.duration_days, 0) - 1) < p_day
      and coalesce(rr.assigned_agent_id, rr.agent_id) is not null
      and not exists (
        select 1 from agents_with_bill a
        where a.agent_id = coalesce(rr.assigned_agent_id, rr.agent_id)
      )
  )
  insert into public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  select p_day, pt.rent_request_id, pt.agent_id, pt.tenant_id, pt.expected_ugx
  from past_term pt
  where pt.expected_ugx > 0
  on conflict (day, rent_request_id) do nothing;

  get diagnostics v_fallback = row_count;

  return v_rows + v_fallback;
end;
$function$;

COMMENT ON FUNCTION public.pin_agent_expected_day(date) IS
  'Writes the daily rent bill at 00:05 EAT. Only bills plans that are actually '
  'repaying — which since Phase 3 means the landlord has the money — and only '
  'from rent_plan_billable_from(). A funded plan is not a collection target; it '
  'is an unpaid landlord.';

-- ---------------------------------------------------------------------------
-- 5. Writer three — the per-plan backstop
--
-- This one had NO status test whatsoever and pinned every day from term_start
-- to today for anything the view admitted. It is what silently re-created 18 of
-- the deleted bills minutes after the first backfill pass.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pin_agent_expected_day_for_plan(p_rent_request_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from date;
  v_rows int := 0;
  v_status text;
BEGIN
  IF p_rent_request_id IS NULL THEN RETURN 0; END IF;

  SELECT rr.status INTO v_status FROM public.rent_requests rr WHERE rr.id = p_rent_request_id;
  IF v_status IS DISTINCT FROM 'repaying' THEN RETURN 0; END IF;

  SELECT GREATEST(s.term_start,
                  public.rent_arrears_go_live(),
                  public.rent_plan_billable_from(p_rent_request_id))
    INTO v_from
  FROM public.v_rent_plan_schedule s
  WHERE s.rent_request_id = p_rent_request_id;

  IF v_from IS NULL OR v_from > v_today THEN RETURN 0; END IF;

  INSERT INTO public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  SELECT g.due_on, g.rent_request_id, s.agent_id, s.tenant_id, g.amount
  FROM public.rent_plan_schedule_days(v_from, v_today) g
  JOIN public.v_rent_plan_schedule s ON s.rent_request_id = g.rent_request_id
  WHERE g.rent_request_id = p_rent_request_id
  ON CONFLICT (day, rent_request_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

COMMENT ON FUNCTION public.pin_agent_expected_day_for_plan(uuid) IS
  'Per-plan backstop for the daily bill. Gated exactly like '
  'pin_agent_expected_day. Without this gate it silently re-created bills for '
  'funded plans within minutes of them being removed.';
