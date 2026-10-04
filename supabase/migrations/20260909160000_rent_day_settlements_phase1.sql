-- Arrears, phase 1: attribute every collection to the day it settles.
--
-- WHAT THIS IS
-- The daily pin (`agent_expected_day_plans`, PK (day, rent_request_id)) already
-- records ONE OBLIGATION PER PLAN PER SCHEDULED DAY. It is written once at
-- 00:05 EAT and never changes. That is the queue of debts.
--
-- What has been missing is the other half: how much of each day has been
-- settled. Until now a collection only decremented `rent_requests.amount_repaid`
-- as a single running total, so nothing could say "Monday closed, Tuesday is
-- still 500 short".
--
-- This migration adds that settlement side and nothing else. It is deliberately
-- BEHAVIOUR-NEUTRAL: no existing figure changes. Targets, the daily eligibility
-- gate, every report and the collect screen all read exactly what they read
-- before. All this does is start writing attribution rows.
--
-- THE RULE IT IMPLEMENTS
-- A payment settles the OLDEST open day first, then the next, and only what
-- survives lands on today. If the older days swallow the whole payment then
-- today receives nothing — the money is not lost, it landed on an earlier day.
-- Surplus beyond all open days stays unapplied and pre-pays future days as soon
-- as the pin creates them.
--
-- This never changes how much a tenant owes in total. `total_repayment` minus
-- `amount_repaid` remains the balance. This is attribution, not extra charges.
--
-- NO BACKFILL
-- `rent_arrears_go_live()` is the floor. Days before it are never open and never
-- enter the queue, so none of the pre-existing shortfall (12,874,625 recorded on
-- past receipts) and none of the 427 post-cycle plans (129,037,935) are pulled
-- in. The queue starts empty and fills only from the floor forward.
--
-- The floor is 2026-09-10, the start of the next Kampala day. It is deliberately
-- NOT 2026-09-09: collections had already been recorded today before this
-- shipped, so a floor of today would leave day one partly attributed unless
-- those were written retroactively — which is the backfill we are avoiding. A
-- floor at the start of a day that has not begun gives a first day that is
-- complete from its first minute.
--
-- TRACEABILITY
-- Every settlement row names the collection that provided the money and the day
-- it settled, so every shilling is traceable in both directions. Readable by
-- CFO, agent ops, tenant ops, financial ops and the other staff roles via
-- `rent_arrears_read_authorized()`, and by the owning agent for their own
-- tenants only.

-- ---------------------------------------------------------------- go-live floor

CREATE OR REPLACE FUNCTION public.rent_arrears_go_live()
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT '2026-09-10'::date $function$;

COMMENT ON FUNCTION public.rent_arrears_go_live() IS
  'First Kampala day the arrears day-queue considers. Days before it are never open, so no historical shortfall enters the queue. Single source of truth - every view and function here derives its floor from this.';

-- ------------------------------------------------------------------- the table

CREATE TABLE IF NOT EXISTS public.rent_day_settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id  uuid NOT NULL,
  day              date NOT NULL,
  collection_id    uuid NOT NULL REFERENCES public.agent_collections(id) ON DELETE CASCADE,
  amount           numeric(20,2) NOT NULL CHECK (amount > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- A settlement may only exist against a REAL pinned obligation. This is the
  -- integrity guarantee that keeps the pin authoritative: you cannot settle a
  -- day that was never billed, and you cannot pre-pay a day before it is
  -- pinned (surplus waits as unapplied instead).
  CONSTRAINT rent_day_settlements_obligation_fkey
    FOREIGN KEY (day, rent_request_id)
    REFERENCES public.agent_expected_day_plans(day, rent_request_id)
    ON DELETE CASCADE,

  -- One row per (payment, day). Re-applying tops the row up rather than
  -- duplicating it, which is what makes the allocator idempotent.
  CONSTRAINT rent_day_settlements_collection_day_key UNIQUE (collection_id, day)
);

COMMENT ON TABLE public.rent_day_settlements IS
  'How much of each pinned day obligation a given collection settled. Oldest day first. Attribution only - never changes what a tenant owes in total.';
COMMENT ON COLUMN public.rent_day_settlements.day IS 'The Kampala day being settled, matching agent_expected_day_plans.day.';
COMMENT ON COLUMN public.rent_day_settlements.collection_id IS 'The agent_collections row that provided this money.';
COMMENT ON COLUMN public.rent_day_settlements.amount IS 'How much of that collection landed on that day.';

CREATE INDEX IF NOT EXISTS idx_rent_day_settle_plan_day
  ON public.rent_day_settlements (rent_request_id, day);
CREATE INDEX IF NOT EXISTS idx_rent_day_settle_collection
  ON public.rent_day_settlements (collection_id);
CREATE INDEX IF NOT EXISTS idx_rent_day_settle_day
  ON public.rent_day_settlements (day);

-- Locked down: all reads and writes go through the functions below.
ALTER TABLE public.rent_day_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rent_day_settlements FROM anon, authenticated;

-- --------------------------------------------------------------- authorization

CREATE OR REPLACE FUNCTION public.rent_arrears_read_authorized()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Reuses the existing staff gate, then adds the ops roles it does not cover.
  -- `is_ops_role()` (which that gate calls) only matches
  -- manager/super_admin/coo/operations, so tenant_ops, financial_ops,
  -- landlord_ops and partner_ops must be named explicitly.
  SELECT public.agent_ops_report_authorized()
      OR public.has_role(auth.uid(), 'tenant_ops')
      OR public.has_role(auth.uid(), 'financial_ops')
      OR public.has_role(auth.uid(), 'landlord_ops')
      OR public.has_role(auth.uid(), 'partner_ops');
$function$;

COMMENT ON FUNCTION public.rent_arrears_read_authorized() IS
  'Staff read gate for the arrears day-queue: CFO, agent ops, tenant ops, financial ops, landlord ops, partner ops, plus the roles agent_ops_report_authorized() already covers.';

-- ------------------------------------------------------------------- the views

-- Day grain: the agent-facing checklist. One row per pinned day from the floor
-- forward, with what was expected, what has been settled and what remains.
CREATE OR REPLACE VIEW public.v_rent_day_ledger AS
SELECT ep.rent_request_id,
       ep.day,
       ep.agent_id,
       ep.tenant_id,
       ep.expected_ugx,
       COALESCE(s.settled_ugx, 0::numeric)                                  AS settled_ugx,
       GREATEST(ep.expected_ugx - COALESCE(s.settled_ugx, 0::numeric), 0)   AS remaining_ugx,
       (COALESCE(s.settled_ugx, 0::numeric) >= ep.expected_ugx)             AS is_settled
FROM public.agent_expected_day_plans ep
LEFT JOIN (
  SELECT rds.rent_request_id, rds.day, SUM(rds.amount) AS settled_ugx
  FROM public.rent_day_settlements rds
  GROUP BY rds.rent_request_id, rds.day
) s ON s.rent_request_id = ep.rent_request_id AND s.day = ep.day
WHERE ep.day >= public.rent_arrears_go_live();

COMMENT ON VIEW public.v_rent_day_ledger IS
  'Per plan per day from the arrears go-live floor: expected, settled, remaining. The queue of open days.';

-- Plan grain: the summary line. Derived from the day ledger so the two can
-- never disagree.
-- The agent here is the CURRENT owner from `rent_requests`, not the agent the
-- day was pinned to. The pin snapshots `agent_id` per day, so a reassigned plan
-- would otherwise split into several summary rows — and an arrears list should
-- show whoever is responsible now. (This is also why the aggregate cannot be
-- `max(agent_id)`: Postgres has no max() for uuid.)
CREATE OR REPLACE VIEW public.v_rent_plan_arrears AS
SELECT l.rent_request_id,
       COALESCE(rr.assigned_agent_id, rr.agent_id)                          AS agent_id,
       rr.tenant_id,
       count(*)                                                             AS days_billed,
       count(*) FILTER (WHERE l.remaining_ugx > 0
                          AND l.day < (now() AT TIME ZONE 'Africa/Kampala')::date) AS days_behind,
       COALESCE(SUM(l.remaining_ugx) FILTER (WHERE l.day < (now() AT TIME ZONE 'Africa/Kampala')::date), 0) AS arrears_ugx,
       COALESCE(SUM(l.remaining_ugx) FILTER (WHERE l.day = (now() AT TIME ZONE 'Africa/Kampala')::date), 0) AS due_today_ugx,
       COALESCE(SUM(l.expected_ugx), 0)                                     AS billed_to_date_ugx,
       COALESCE(SUM(l.settled_ugx), 0)                                      AS settled_to_date_ugx,
       min(l.day) FILTER (WHERE l.remaining_ugx > 0
                            AND l.day < (now() AT TIME ZONE 'Africa/Kampala')::date) AS oldest_open_day
FROM public.v_rent_day_ledger l
JOIN public.rent_requests rr ON rr.id = l.rent_request_id
GROUP BY l.rent_request_id, COALESCE(rr.assigned_agent_id, rr.agent_id), rr.tenant_id;

COMMENT ON VIEW public.v_rent_plan_arrears IS
  'Per Rent Plan arrears summary derived from v_rent_day_ledger: days behind, arrears amount, still due today, and the oldest open day. Agent is the CURRENT owner (assigned_agent_id falling back to agent_id), not the agent the day was pinned to, because a plan can be reassigned. Arrears excludes today, which is not yet late.';

-- Money received since the floor that has not yet been attributed to a day.
-- This is what pre-pays future days once the pin creates them. Derived, not
-- stored, so it cannot drift from the settlement rows.
CREATE OR REPLACE VIEW public.v_rent_collection_unapplied AS
SELECT ac.id                                        AS collection_id,
       ac.rent_request_id,
       ac.agent_id,
       ac.created_at,
       ac.amount                                    AS collected_ugx,
       COALESCE(a.applied_ugx, 0::numeric)          AS applied_ugx,
       GREATEST(ac.amount - COALESCE(a.applied_ugx, 0::numeric), 0) AS unapplied_ugx
FROM public.agent_collections ac
LEFT JOIN (
  SELECT rds.collection_id, SUM(rds.amount) AS applied_ugx
  FROM public.rent_day_settlements rds
  GROUP BY rds.collection_id
) a ON a.collection_id = ac.id
WHERE ac.amount > 0
  AND ac.rent_request_id IS NOT NULL
  AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= public.rent_arrears_go_live()
  AND COALESCE(ac.notes, '') NOT ILIKE '%[REVERSED:%';

COMMENT ON VIEW public.v_rent_collection_unapplied IS
  'Collections since the arrears go-live floor and how much of each has been attributed to a day. Unapplied money pre-pays future days when they are pinned. Reversed collections are excluded.';

-- ---------------------------------------------------------------- the allocator

CREATE OR REPLACE FUNCTION public.rent_apply_collections_to_days(p_rent_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows int := 0;
  v_amount numeric := 0;
BEGIN
  IF p_rent_request_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_plan');
  END IF;

  -- Serialise per plan so two concurrent collections cannot both claim the same
  -- open day. Plan-scoped, so it never blocks other agents.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_rent_request_id::text, 0));

  -- FIFO allocation as a single set operation, no loop and no per-day queries.
  --
  -- Both sides are laid out as cumulative UGX ranges in the same units:
  --   a fund  covers [running money before it, + its unapplied amount)
  --   a day   needs  [running need before it,  + its remaining amount)
  -- The overlap between a fund's range and a day's range is exactly how much of
  -- that collection lands on that day. Oldest day and oldest money first falls
  -- out of the ordering.
  WITH funds AS (
    SELECT u.collection_id,
           u.unapplied_ugx,
           COALESCE(SUM(u.unapplied_ugx) OVER (ORDER BY u.created_at, u.collection_id
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS f_start
    FROM public.v_rent_collection_unapplied u
    WHERE u.rent_request_id = p_rent_request_id
      AND u.unapplied_ugx > 0
  ), open_days AS (
    SELECT l.day,
           l.remaining_ugx,
           COALESCE(SUM(l.remaining_ugx) OVER (ORDER BY l.day
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS d_start
    FROM public.v_rent_day_ledger l
    WHERE l.rent_request_id = p_rent_request_id
      AND l.remaining_ugx > 0
  ), matched AS (
    SELECT d.day,
           f.collection_id,
           LEAST(f.f_start + f.unapplied_ugx, d.d_start + d.remaining_ugx)
             - GREATEST(f.f_start, d.d_start) AS amount
    FROM funds f
    JOIN open_days d
      ON LEAST(f.f_start + f.unapplied_ugx, d.d_start + d.remaining_ugx)
         > GREATEST(f.f_start, d.d_start)
  ), ins AS (
    INSERT INTO public.rent_day_settlements (rent_request_id, day, collection_id, amount)
    SELECT p_rent_request_id, m.day, m.collection_id, m.amount
    FROM matched m
    WHERE m.amount > 0
    ON CONFLICT (collection_id, day)
      DO UPDATE SET amount = public.rent_day_settlements.amount + EXCLUDED.amount
    RETURNING amount
  )
  SELECT count(*)::int, COALESCE(SUM(amount), 0) INTO v_rows, v_amount FROM ins;

  RETURN jsonb_build_object(
    'status', 'applied',
    'rent_request_id', p_rent_request_id,
    'rows', v_rows,
    'amount_applied', v_amount
  );
END;
$function$;

COMMENT ON FUNCTION public.rent_apply_collections_to_days(uuid) IS
  'Attributes any unapplied collection money on a Rent Plan to its open pinned days, oldest day and oldest money first. Idempotent: it only ever moves unapplied money onto still-open days, so re-running is a no-op. Safe to call after a collection and after the daily pin.';

REVOKE ALL ON FUNCTION public.rent_apply_collections_to_days(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rent_apply_collections_to_days(uuid) TO service_role;

-- Sweep every plan that is holding unapplied money. Intended to run right after
-- the 00:05 pin so pre-paid surplus lands on the day it just created.
CREATE OR REPLACE FUNCTION public.rent_sweep_unapplied_collections()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plans int := 0;
  v_amount numeric := 0;
  r record;
  v jsonb;
BEGIN
  FOR r IN
    SELECT DISTINCT u.rent_request_id
    FROM public.v_rent_collection_unapplied u
    WHERE u.unapplied_ugx > 0
      AND EXISTS (SELECT 1 FROM public.v_rent_day_ledger l
                   WHERE l.rent_request_id = u.rent_request_id AND l.remaining_ugx > 0)
  LOOP
    v := public.rent_apply_collections_to_days(r.rent_request_id);
    v_plans := v_plans + 1;
    v_amount := v_amount + COALESCE((v->>'amount_applied')::numeric, 0);
  END LOOP;

  RETURN jsonb_build_object('status','swept','plans', v_plans, 'amount_applied', v_amount);
END;
$function$;

COMMENT ON FUNCTION public.rent_sweep_unapplied_collections() IS
  'Applies unapplied collection money across every Rent Plan that has open days. Only touches plans that hold surplus AND have somewhere to put it, so the loop stays short. Run after the daily pin.';

REVOKE ALL ON FUNCTION public.rent_sweep_unapplied_collections() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rent_sweep_unapplied_collections() TO service_role;

-- ------------------------------------------------------- reversals stay honest

-- `agent_reverse_tenant_allocation` does not delete a collection row; it only
-- appends '[REVERSED: reason]' to notes. Without this the reversed money would
-- keep showing days as settled. Detecting the notes change avoids editing a
-- money-moving RPC.
CREATE OR REPLACE FUNCTION public.rent_drop_settlements_on_reversal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.notes,'') ILIKE '%[REVERSED:%'
     AND COALESCE(OLD.notes,'') NOT ILIKE '%[REVERSED:%' THEN
    DELETE FROM public.rent_day_settlements WHERE collection_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rent_drop_settlements_on_reversal ON public.agent_collections;
CREATE TRIGGER trg_rent_drop_settlements_on_reversal
  AFTER UPDATE OF notes ON public.agent_collections
  FOR EACH ROW
  EXECUTE FUNCTION public.rent_drop_settlements_on_reversal();

COMMENT ON FUNCTION public.rent_drop_settlements_on_reversal() IS
  'Releases the days a collection had settled when that collection is reversed, so a reversed payment stops showing days as covered.';

-- ------------------------------------------------------------- read interfaces

-- One round trip for one tenant's full day-by-day ledger plus its summary.
CREATE OR REPLACE FUNCTION public.rent_plan_day_ledger(p_rent_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid;
  v_assigned uuid;
  v_out jsonb;
BEGIN
  IF p_rent_request_id IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  SELECT rr.agent_id, rr.assigned_agent_id INTO v_agent, v_assigned
  FROM public.rent_requests rr WHERE rr.id = p_rent_request_id;

  IF NOT (
    public.rent_arrears_read_authorized()
    OR auth.uid() = v_agent
    OR auth.uid() = v_assigned
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_build_object(
           'rent_request_id', p_rent_request_id,
           'go_live', public.rent_arrears_go_live(),
           'summary', COALESCE(
             (SELECT to_jsonb(a) - 'rent_request_id'
                FROM public.v_rent_plan_arrears a
               WHERE a.rent_request_id = p_rent_request_id),
             jsonb_build_object('days_billed',0,'days_behind',0,'arrears_ugx',0,
                                'due_today_ugx',0,'billed_to_date_ugx',0,
                                'settled_to_date_ugx',0,'oldest_open_day',NULL)),
           'days', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'day', l.day,
                      'expected', l.expected_ugx,
                      'settled', l.settled_ugx,
                      'remaining', l.remaining_ugx,
                      'is_settled', l.is_settled
                    ) ORDER BY l.day DESC)
             FROM public.v_rent_day_ledger l
             WHERE l.rent_request_id = p_rent_request_id), '[]'::jsonb),
           'unapplied_ugx', COALESCE((
             SELECT SUM(u.unapplied_ugx) FROM public.v_rent_collection_unapplied u
              WHERE u.rent_request_id = p_rent_request_id), 0)
         )
    INTO v_out;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.rent_plan_day_ledger(uuid) IS
  'One Rent Plan day-by-day: expected, settled and remaining per day, plus the arrears summary and any unapplied money. Readable by staff (rent_arrears_read_authorized) or the owning/assigned agent.';

GRANT EXECUTE ON FUNCTION public.rent_plan_day_ledger(uuid) TO authenticated, service_role;

-- One round trip for an agent's whole arrears book, aggregated server-side.
CREATE OR REPLACE FUNCTION public.agent_arrears_overview(p_agent_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_out jsonb;
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  IF NOT (public.rent_arrears_read_authorized() OR auth.uid() = v_agent) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_build_object(
           'agent_id', v_agent,
           'go_live', public.rent_arrears_go_live(),
           'as_at', (now() AT TIME ZONE 'Africa/Kampala')::timestamp(0),
           'totals', jsonb_build_object(
             'tenants_behind', COUNT(*) FILTER (WHERE a.arrears_ugx > 0),
             'arrears_ugx',    COALESCE(SUM(a.arrears_ugx), 0),
             'due_today_ugx',  COALESCE(SUM(a.due_today_ugx), 0),
             'days_behind',    COALESCE(SUM(a.days_behind), 0)
           ),
           'tenants', COALESCE(jsonb_agg(jsonb_build_object(
             'rent_request_id', a.rent_request_id,
             'tenant_id', a.tenant_id,
             'tenant_name', p.full_name,
             'tenant_phone', p.phone,
             'days_behind', a.days_behind,
             'arrears_ugx', a.arrears_ugx,
             'due_today_ugx', a.due_today_ugx,
             'oldest_open_day', a.oldest_open_day
           ) ORDER BY a.arrears_ugx DESC, a.days_behind DESC)
             FILTER (WHERE a.arrears_ugx > 0 OR a.due_today_ugx > 0), '[]'::jsonb)
         )
    INTO v_out
  FROM public.v_rent_plan_arrears a
  LEFT JOIN public.profiles p ON p.id = a.tenant_id
  -- `a.agent_id` is already the current owner (see the view), so there is no
  -- need to re-join rent_requests here.
  WHERE a.agent_id = v_agent;

  RETURN COALESCE(v_out, jsonb_build_object('agent_id', v_agent, 'tenants', '[]'::jsonb));
END;
$function$;

COMMENT ON FUNCTION public.agent_arrears_overview(uuid) IS
  'An agent''s arrears book in one round trip: totals plus a per-tenant list of days behind, arrears and what is still due today. Agents may read their own; staff may read any.';

GRANT EXECUTE ON FUNCTION public.agent_arrears_overview(uuid) TO authenticated, service_role;

-- ------------------------------------------- wire it into the collection path

-- `agent_allocate_tenant_payment` is the only RPC that writes a collection, so
-- it is the one place attribution needs to hook in. Everything above the new
-- block is byte-identical to the previous definition (auth and ownership checks,
-- the REPAYMENT_NOT_STARTED guard from 20260909151000, the tracking-only partial
-- semantics, and the additive stamping of expected/shortfall/is_partial).
--
-- The attribution call is deliberately NON-FATAL. Attribution is derived data
-- and self-healing — `rent_sweep_unapplied_collections()` reapplies anything
-- left unapplied — so a fault in it must never block a collection or unwind
-- money that has already moved. It warns and carries on.
--
-- See the applied definition in the database for the full body; the only change
-- versus 20260909151000 is the addition of:
--
--     BEGIN
--       PERFORM public.rent_apply_collections_to_days(p_rent_request_id);
--     EXCEPTION WHEN OTHERS THEN
--       RAISE WARNING 'rent day attribution failed for plan %: %',
--                     p_rent_request_id, SQLERRM;
--     END;
--
-- inside the success branch, immediately after the expected/shortfall stamping
-- and before the result object is assembled.
