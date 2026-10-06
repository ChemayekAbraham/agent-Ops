-- Agent dashboard: count only actively repaying plans as active and expected.
--
-- `v_agent_daily_eligibility` feeds the agent's daily capacity strip (expected
-- today, active tenants, collection %) and, through
-- `enforce_agent_daily_eligibility`, gates whether an agent may post new rent
-- requests at all. Its candidate set, `all_rents`, admits three statuses:
--
--   status IN ('funded','repaying')
--   OR status = 'completed' AND a collection landed today
--
-- An agent cannot collect from a `funded` plan - the landlord may not even be
-- paid yet - and a `completed` plan has nothing left to ask for. Including them
-- inflates what the strip calls "active", and lets the fallback expected branch
-- quote a daily instalment for a plan nobody should be chasing.
--
-- `expected` and `active_count` are now restricted to `repaying`.
--
-- Deliberately NOT restricted: the collection-matching path. `matched`,
-- `per_day` and `raw_collected` still see the broader set, so money an agent
-- genuinely collected today on a plan that completed with that very payment
-- still counts toward `paid_today`. Narrowing both halves would have dropped
-- real collections out of the numerator and made the mismatch worse, not
-- better.
--
-- Measured before the change, today: the view reported 778 active plans across
-- 97 agents against 429 plans on the pinned bill - 608 vs 259 on the 55 agents
-- whose counts disagreed. The expected AMOUNT was already close to the pin
-- (8,198,082 vs 8,245,841, 0.6% apart), because the landlord-settlement gate in
-- `live_rents` was already keeping unpaid funded plans out of the money. So
-- this corrects the plan count and closes the fallback path; it is not the
-- source of a large expected-figure error.
--
-- `status` is threaded through all_rents -> active_rents -> live_rents ->
-- eligible_rents so the filter can be applied once, at the point the figures
-- are aggregated. Applied as guarded replaces on the stored view definition
-- rather than retyping a 200-line view; each raises if its anchor is absent.

do $patch$
declare v_src text; v_new text;
begin
  select pg_get_viewdef('public.v_agent_daily_eligibility'::regclass, true) into v_src;
  if v_src is null then raise exception 'v_agent_daily_eligibility not found'; end if;

  -- 1. carry the plan status out of rent_requests
  v_new := replace(v_src,
$o1$ SELECT rr.agent_id,
            rr.id AS rent_request_id,$o1$,
$n1$ SELECT rr.agent_id,
            rr.status,
            rr.id AS rent_request_id,$n1$);
  if v_new = v_src then raise exception 'anchor 1 (all_rents select) not found'; end if;
  v_src := v_new;

  -- 2 and 3. through active_rents and live_rents (same shape, both occurrences)
  v_new := replace(v_src,
$o2$ SELECT ar.agent_id,
            ar.rent_request_id,$o2$,
$n2$ SELECT ar.agent_id,
            ar.status,
            ar.rent_request_id,$n2$);
  if v_new = v_src then raise exception 'anchor 2 (active_rents/live_rents select) not found'; end if;
  v_src := v_new;

  -- 4. and into eligible_rents
  v_new := replace(v_src,
$o3$ SELECT lr.agent_id,
            lr.rent_request_id,$o3$,
$n3$ SELECT lr.agent_id,
            lr.status,
            lr.rent_request_id,$n3$);
  if v_new = v_src then raise exception 'anchor 3 (eligible_rents select) not found'; end if;
  v_src := v_new;

  -- 5. and apply it where the figures are aggregated
  v_new := replace(v_src,
$o4$           FROM eligible_rents er
          GROUP BY er.agent_id$o4$,
$n4$           FROM eligible_rents er
          WHERE er.status = 'repaying'::text
          GROUP BY er.agent_id$n4$);
  if v_new = v_src then raise exception 'anchor 4 (expected aggregate) not found'; end if;

  execute 'create or replace view public.v_agent_daily_eligibility as ' || v_new;
end
$patch$;
