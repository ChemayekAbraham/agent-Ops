-- Landlord-paid notices: fire on the landlord actually being paid, and never
-- expire unsent.
--
-- `rent_plan_transition_notices_pending` drives the two messages agents and
-- tenants report missing: T1, the tenant welcome with their rent details, and
-- AP, the agent's "landlord paid" SMS carrying the receipt number. Both read
-- one CTE, `paid`, which required all three of:
--
--   * a `system_events` row of type `rent_request_repaying_started`
--   * that event inside a rolling lookback (default 48h, capped at 7 days)
--   * `rent_requests.status = 'repaying'`
--
-- Each is a way for a landlord-paid plan to get no message at all:
--
--   * No event row, no message - ever. The event is the only trigger, so a
--     landlord paid without one is invisible to the drain.
--   * The window expires. A plan missed for 48 hours (provider outage, a phone
--     number corrected late) falls out and is never retried, which defeats the
--     point of a self-healing drain.
--   * `status = 'repaying'` is backwards for T1. A plan only leaves `funded`
--     on its FIRST COLLECTION, and the welcome SMS is what tells the tenant to
--     start paying. A landlord-paid plan whose tenant has not paid yet sits at
--     `funded`, so the message that would prompt them never sends.
--
-- Now `paid` reads `landlord_payouts` directly: if the payout carries a real
-- disbursement timestamp, the notice is due. No rolling window, so a message
-- can be late but can no longer expire.
--
-- Three bounds keep "aggressive" from meaning "spam":
--
--   * Disbursement is proved by `finops_disbursed_at` / `disbursed_at` being
--     set, not by status alone. An earlier revision of this patch fell back to
--     `updated_at`, which let a plan from May - touched recently by an
--     unrelated status change - queue a "repayment starts tomorrow" message.
--   * Both the disbursement and the plan's `repayment_starts_on` must be at or
--     after `landlord_float_recall_go_live()`, so the pre-go-live backlog stays
--     untouched and a long-delayed payout on a stale plan cannot wake it.
--   * `completed` plans are excluded - "repayment starts tomorrow" is wrong on
--     a finished plan.
--
-- Duplicate protection is unchanged and never depended on the window: the
-- unique index on `sms_delivery_log(idempotency_key)` plus the NOT EXISTS on
-- `rent-plan-t1:` / `rent-plan-ap:` already in the CTEs. DISTINCT ON stops a
-- plan with more than one payout row being queued twice.
--
-- Measured on 2026-10-05 after applying: nothing queued, because everything
-- disbursed since go-live has already been messaged. Without the go-live floor
-- the first run would have swept 1,049 plans, including months-old completed
-- ones - which is why the floor is there.
--
-- Applied as a guarded in-place patch rather than retyping a 9k-character
-- function to change one CTE; each replace raises if its snippet is absent.

do $patch$
declare v_src text; v_new text;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rent_plan_transition_notices_pending';
  if v_src is null then raise exception 'rent_plan_transition_notices_pending not found'; end if;

  -- 1. source the paid set from the payout itself rather than a transient event
  v_new := replace(v_src,
$o1$  paid AS (
    SELECT ev.related_entity_id AS rent_request_id,
           (ev.metadata->>'landlord_name') AS landlord_name,
           (ev.metadata->>'landlord_payout_id')::uuid AS payout_id,
           (ev.metadata->>'finops_momo_reference') AS momo_ref,$o1$,
$n1$  paid AS (
    SELECT DISTINCT ON (lp.rent_request_id)
           lp.rent_request_id AS rent_request_id,
           COALESCE(lp.landlord_name, ll.name) AS landlord_name,
           lp.id AS payout_id,
           lp.finops_momo_reference AS momo_ref,$n1$);
  if v_new = v_src then raise exception 'paid CTE select list not found'; end if;
  v_src := v_new;

  -- 2. and gate it on a real disbursement, floored at go-live on both the
  --    payout and the plan
  v_new := replace(v_src,
$o2$    FROM public.system_events ev
    JOIN public.rent_requests rr ON rr.id = ev.related_entity_id, since
    WHERE ev.event_type = 'rent_request_repaying_started'
      AND ev.created_at >= since.t
      AND rr.status = 'repaying'
  ),$o2$,
$n2$    FROM public.landlord_payouts lp
    JOIN public.rent_requests rr ON rr.id = lp.rent_request_id
    LEFT JOIN public.landlords ll ON ll.id = lp.landlord_id
    WHERE COALESCE(lp.finops_disbursed_at, lp.disbursed_at) IS NOT NULL
      AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at)
            >= public.landlord_float_recall_go_live()
      AND rr.status IN ('funded','repaying')
      AND (rr.repayment_starts_on IS NULL
           OR rr.repayment_starts_on >= (public.landlord_float_recall_go_live())::date)
    ORDER BY lp.rent_request_id,
             COALESCE(lp.finops_disbursed_at, lp.disbursed_at) DESC
  ),$n2$);
  if v_new = v_src then raise exception 'paid CTE source clause not found'; end if;

  execute format(
    'create or replace function public.rent_plan_transition_notices_pending(p_lookback_hours integer default 48) returns jsonb language sql stable security definer set search_path=public as %L',
    v_new);
end
$patch$;
