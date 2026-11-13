-- Self-onboarded tenants, and agents with no Service Centre manager, go straight to Agent Ops.
--
-- E58 (migration e58_close_off_pipeline_paths, applied 2026-11-09 14:33 UTC, not in this
-- folder) switched on `pipeline_guard:route_to_service_centre`, which sent EVERY new or
-- revived rent request to `service_center_review` — including tenants who applied for
-- themselves through /tenants-onboarding, and requests whose agent has no Service Centre
-- manager (they landed in Service Centre review with no manager, so nobody's queue).
-- Agent Ops reads `status = 'pending'`, so those tenants never reached it, and Agent Ops is
-- where a self-onboarded tenant is given an agent.
--
-- Rules after this migration (switch ON or OFF):
--   1. A tenant self-application stays at `pending` (Agent Ops). Honoured only when the
--      insert comes from the service key (the tenant-self-onboarding edge function) or from
--      the tenant themself — a signed-in agent cannot set the flag to skip vetting.
--   2. No Service Centre manager for the agent -> stays at `pending` (Agent Ops).
--   3. Otherwise -> `service_center_review` with that manager (unchanged E58 behaviour;
--      with the switch OFF, the old Diamond-rank skip still applies).
-- The same rules apply to E58-2 (an agent bringing a rejected/cancelled request back).
-- Requests already stuck in Service Centre review are moved by 20261110120100.

create or replace function public.route_rent_request_service_center()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_agent uuid := coalesce(new.agent_id, new.assigned_agent_id);
  v_manager uuid;
  v_switch boolean := public._pipeline_switch_on('pipeline_guard:route_to_service_centre');
  v_was_skip text;
begin
  if coalesce(new.status, 'pending') <> 'pending' then return new; end if;

  -- 1) Tenant applied for themselves: Agent Ops assigns their agent. Never the Service Centre.
  --    Honoured only from the service key (the edge function) or the tenant themself.
  if coalesce(new.tenant_self_applied, false)
     and (auth.uid() is null or auth.uid() = new.tenant_id) then
    new.service_center_manager_id := null;
    return new;
  end if;

  v_manager := public.resolve_service_center_manager_for_agent(v_agent);

  -- 2) No Service Centre manager: straight to Agent Ops.
  if v_manager is null then
    return new;
  end if;

  if not v_switch then
    -- Old behaviour, kept only for switching back: Diamond rank skipped the Service Centre.
    if exists (select 1 from agent_elite_ranks e where e.agent_id = v_agent and e.rank_position = 1) then
      new.service_center_comment := 'Skipped Service Centre: Diamond rank privilege';
      return new;
    end if;
    new.status := 'service_center_review';
    new.service_center_manager_id := v_manager;
    return new;
  end if;

  -- 3) E58: has a manager -> always the Service Centre (Diamond rank no longer skips).
  v_was_skip := case
    when exists (select 1 from agent_elite_ranks e where e.agent_id = v_agent and e.rank_position = 1) then 'diamond_rank_skip'
  end;
  new.status := 'service_center_review';
  new.service_center_manager_id := v_manager;
  if v_was_skip is not null then
    insert into public.pipeline_guard_log(rent_request_id, from_status, asked_status, final_status, outcome, rule, actor_id, actor_staff_ref, detail)
    values (new.id, null, 'pending', 'service_center_review', 'rerouted', 'E58-1 '||v_was_skip, auth.uid(), public._pipeline_staff_ref(auth.uid()),
            jsonb_build_object('agent_id', v_agent));
  end if;
  return new;
end $function$;

create or replace function public.trg_e58_pipeline_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_staff text := public._pipeline_staff_ref(auth.uid());
  v_partner boolean;
  v_days numeric;
  v_manager uuid;
begin
  if old.status is not distinct from new.status then return new; end if;

  -- 2) Agent brings a closed request back: start again at the Service Centre — unless the
  --    tenant applied for themselves or the agent has no Service Centre manager, in which
  --    case it starts again at Agent Ops (`pending`).
  if old.status in ('rejected','cancelled','deleted_by_agent')
     and new.status not in ('rejected','cancelled','deleted_by_agent','service_center_review')
     and v_uid is not null and v_staff is null
     and public._pipeline_switch_on('pipeline_guard:route_to_service_centre') then
    v_manager := public.resolve_service_center_manager_for_agent(coalesce(new.agent_id, new.assigned_agent_id));
    if coalesce(new.tenant_self_applied, false) or v_manager is null then
      insert into public.pipeline_guard_log(rent_request_id, from_status, asked_status, final_status, outcome, rule, actor_id, actor_staff_ref)
      values (new.id, old.status, new.status, 'pending', 'rerouted',
              case when coalesce(new.tenant_self_applied, false)
                   then 'E58-2 self-applied resubmission starts at Agent Ops'
                   else 'E58-2 resubmission with no Service Centre manager starts at Agent Ops' end,
              v_uid, v_staff);
      new.status := 'pending';
      new.service_center_manager_id := null;
      return new;
    end if;
    insert into public.pipeline_guard_log(rent_request_id, from_status, asked_status, final_status, outcome, rule, actor_id, actor_staff_ref)
    values (new.id, old.status, new.status, 'service_center_review', 'rerouted', 'E58-2 resubmission starts at the Service Centre', v_uid, v_staff);
    new.status := 'service_center_review';
    new.service_center_manager_id := v_manager;
    return new;
  end if;

  -- 3) Welile funding only after 7 days on the funders' board.
  if old.status = 'coo_approved' and new.status = 'funded' and public._pipeline_switch_on('pipeline_guard:welile_day7') then
    v_partner := new.supporter_id is not null or new.self_funding_partner_id is not null
                 or exists (select 1 from public.partner_self_plan_claims c where c.rent_request_id = new.id and c.status = 'confirmed');
    v_days := round((extract(epoch from now() - coalesce(old.coo_reviewed_at, now())) / 86400.0)::numeric, 1);
    if not v_partner and v_days < 7 then
      raise exception 'Welile can fund this request only after 7 days on the funders'' board (it has been % days). Partners can fund it now.', v_days
        using errcode = 'P0001';
    end if;
  end if;

  -- 4) Anything else outside the desk pipeline.
  if not public._pipeline_move_ok(old.status, new.status) then
    if public._pipeline_switch_on('pipeline_guard:block_off_pipeline') then
      raise exception 'This move (% → %) is not part of the desk pipeline.', old.status, new.status using errcode = 'P0001';
    end if;
    insert into public.pipeline_guard_log(rent_request_id, from_status, asked_status, final_status, outcome, rule, actor_id, actor_staff_ref, detail)
    values (new.id, old.status, new.status, new.status, 'reported', 'E58-4 move outside the desk pipeline', v_uid, v_staff,
            jsonb_build_object('db_user', current_user));
  end if;
  return new;
end $function$;

