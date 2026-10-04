-- A cancelled Rent Plan is not owed, so it must not generate arrears.
--
-- WHAT WAS WRONG
--
-- `v_rent_plan_arrears` decides how much a plan can still owe:
--
--   CASE WHEN rr.status = ANY (ARRAY['completed','settled','closed']) THEN 0
--        ELSE GREATEST(0, total_repayment - amount_repaid) END
--
-- `cancelled` is not in that list. Neither is `rejected` or `deleted_by_agent`.
-- So a plan that has been unwound keeps every pinned day it was ever billed,
-- keeps its arrears, and keeps appearing in the agent's chase list — which is
-- how an agent ended up being told to "Call these 3 tenants NOW, UGX 90,146
-- overdue" about plans that had just been cancelled, two of them belonging to
-- accounts that no longer exist and therefore showing "No phone number on file
-- — visit this tenant today".
--
-- WHY THIS WAS LATENT AND IS ABOUT TO STOP BEING
--
-- Measured 2026-09-28: only 4 plans across 2 agents, worth 171,185, are
-- affected right now, and they are the ones cancelled minutes earlier during a
-- test-data clear. Cancellation has simply been rare.
--
-- That is changing. The 24-hour landlord-float recall
-- (20260925170000 and the idle-float queue behind it) CANCELS PLANS
-- AUTOMATICALLY when float sits unpaid. Every plan it recalls would have
-- generated phantom arrears and a phantom chase task for the agent, on money
-- the platform had just taken back. The bug would have arrived at scale, in a
-- flow designed to reduce agent workload, and looked like the recall itself was
-- broken.
--
-- THE FIX IS THE MINIMUM ONE
--
-- Three terminal states join the three already there. Nothing else in the view
-- changes: the day ledger, the caps, the ordering and every column keep their
-- current meaning, so no reader has to be touched.
--
-- `cancelled` belongs with `completed` rather than with `repaying` because
-- cancellation is an UNWIND, not a write-off:
-- `cancel_tenant_and_return_landlord_float` returns the landlord float to the
-- platform and reverses the fee recognition. The tenant is not being forgiven a
-- debt, they never ended up owing one.
--
-- Verified before and after against production.

CREATE OR REPLACE VIEW public.v_rent_plan_arrears AS
 WITH agg AS (
         SELECT l.rent_request_id,
            count(*) AS days_billed,
            count(*) FILTER (WHERE l.remaining_ugx > 0::numeric AND l.day < (now() AT TIME ZONE 'Africa/Kampala'::text)::date) AS days_behind,
            COALESCE(sum(l.remaining_ugx) FILTER (WHERE l.day < (now() AT TIME ZONE 'Africa/Kampala'::text)::date), 0::numeric) AS raw_arrears_ugx,
            COALESCE(sum(l.remaining_ugx) FILTER (WHERE l.day = (now() AT TIME ZONE 'Africa/Kampala'::text)::date), 0::numeric) AS raw_due_today_ugx,
            COALESCE(sum(l.expected_ugx), 0::numeric) AS billed_to_date_ugx,
            COALESCE(sum(l.settled_ugx), 0::numeric) AS settled_to_date_ugx,
            min(l.day) FILTER (WHERE l.remaining_ugx > 0::numeric AND l.day < (now() AT TIME ZONE 'Africa/Kampala'::text)::date) AS oldest_open_day
           FROM v_rent_day_ledger l
          GROUP BY l.rent_request_id
        ), j AS (
         SELECT a.rent_request_id,
            a.days_billed,
            a.days_behind,
            a.raw_arrears_ugx,
            a.raw_due_today_ugx,
            a.billed_to_date_ugx,
            a.settled_to_date_ugx,
            a.oldest_open_day,
            COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
            rr.tenant_id,
                CASE
                    -- Terminal. A plan in any of these states cannot be owed:
                    -- the first three finished, the last three were unwound.
                    WHEN rr.status = ANY (ARRAY['completed'::text, 'settled'::text, 'closed'::text,
                                                'cancelled'::text, 'rejected'::text, 'deleted_by_agent'::text]) THEN 0::numeric
                    ELSE GREATEST(0::numeric, COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric))
                END AS owed_ugx
           FROM agg a
             JOIN rent_requests rr ON rr.id = a.rent_request_id
        )
 SELECT rent_request_id,
    agent_id,
    tenant_id,
    days_billed,
        CASE
            WHEN owed_ugx <= 0::numeric THEN 0::bigint
            ELSE days_behind
        END AS days_behind,
    LEAST(raw_arrears_ugx, owed_ugx) AS arrears_ugx,
    LEAST(raw_due_today_ugx, GREATEST(owed_ugx - LEAST(raw_arrears_ugx, owed_ugx), 0::numeric)) AS due_today_ugx,
    billed_to_date_ugx,
    settled_to_date_ugx,
        CASE
            WHEN owed_ugx <= 0::numeric THEN NULL::date
            ELSE oldest_open_day
        END AS oldest_open_day
   FROM j;

COMMENT ON VIEW public.v_rent_plan_arrears IS
  'Arrears per Rent Plan, capped at what the plan can still owe. Six terminal '
  'statuses owe nothing: completed, settled and closed finished; cancelled, '
  'rejected and deleted_by_agent were unwound. Cancellation returns the '
  'landlord float and reverses the fee, so the tenant never ended up owing.';

-- ---------------------------------------------------------------------------
-- And a deleted account is not someone an agent can serve.
--
-- `get_agent_tenants_overview` builds the roster from rent_requests UNION
-- agent_collections joined to profiles, with no check on deleted_at. Soft
-- deletion anonymises a profile but leaves the row, so a cleared test tenant
-- stayed on the agent's list as "[DELETED] Kyasman Tenants — COMPLETED — UGX 0"
-- and, on the chase surfaces, as "No phone number on file — visit this tenant
-- today", because deletion nulls the phone.
--
-- Checked before writing: ZERO deleted tenants sit on a live plan anywhere on
-- the platform (repaying, funded, disbursed, pending or either ops-approved
-- state), so this hides nothing anyone is still owed money by. It is applied as
-- an anchored patch because the function is a 6.9KB SQL body and restating it
-- in full here would be six hundred lines of unrelated risk.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_tenants_overview';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'get_agent_tenants_overview not found';
  END IF;

  IF v_src LIKE '%WHERE p.deleted_at IS NULL%' THEN
    RAISE NOTICE 'Already applied - deleted tenants are already excluded.';
    RETURN;
  END IF;

  v_new := replace(v_src,
'    FROM public.profiles p
    JOIN linked_ids li ON li.id = p.id
  ),',
'    FROM public.profiles p
    JOIN linked_ids li ON li.id = p.id
    WHERE p.deleted_at IS NULL
  ),');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'anchor not found in get_agent_tenants_overview - the tenants CTE has changed shape';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_agent_tenants_overview(
       p_today_start timestamp with time zone DEFAULT date_trunc(''day''::text, now()))
     RETURNS TABLE(id uuid, full_name text, phone text, email text, created_at timestamp with time zone,
       monthly_rent numeric, verified boolean, balance numeric, daily numeric, total_repayment numeric,
       amount_repaid numeric, statuses text[], landlord_name text, property_address text,
       latitude numeric, longitude numeric, completed_count integer, request_count integer,
       last_paid_at timestamp with time zone, last_paid_amount numeric, today_paid_amount numeric,
       today_paid_count integer, repaying_balance numeric, payment_states text[], latest_status text,
       unfunded_balance numeric)
     LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''public''
     AS %L', v_new);
END
$patch$;
