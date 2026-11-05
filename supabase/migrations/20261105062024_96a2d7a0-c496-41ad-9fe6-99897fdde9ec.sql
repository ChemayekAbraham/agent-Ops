create or replace function public._welile_signages_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ops boolean := public.welile_signages_ops_ok();
begin
  if tg_op = 'INSERT' then
    new.reference_no := 'SGN-' || to_char(now(), 'YYYY') || '-' || nextval('public.welile_signage_seq');
    new.reviewed_by := null; new.reviewed_at := null; new.verified_by := null; new.verified_at := null;
    new.activated_at := null; new.agent_reward_status := 'not_eligible'; new.owner_rent_status := 'not_due';
    new.agent_reward_tx_ref := null; new.agent_reward_disbursed_at := null; new.agent_reward_disbursed_by := null;
    new.owner_rent_tx_ref := null; new.owner_rent_disbursed_at := null; new.owner_rent_disbursed_by := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  if new.agent_id <> old.agent_id or new.reference_no <> old.reference_no or new.created_at <> old.created_at then
    raise exception 'Signage owner, reference and creation date cannot change';
  end if;
  -- Payout fields: only a future payment process (setting welile.signage_payout = on) may change them.
  if coalesce(current_setting('welile.signage_payout', true), '') <> 'on' then
    new.agent_reward_status := old.agent_reward_status; new.agent_reward_tx_ref := old.agent_reward_tx_ref;
    new.agent_reward_disbursed_at := old.agent_reward_disbursed_at; new.agent_reward_disbursed_by := old.agent_reward_disbursed_by;
    new.owner_rent_status := old.owner_rent_status; new.owner_rent_tx_ref := old.owner_rent_tx_ref;
    new.owner_rent_disbursed_at := old.owner_rent_disbursed_at; new.owner_rent_disbursed_by := old.owner_rent_disbursed_by;
  end if;
  if not v_ops then
    if (new.reviewed_by, new.reviewed_at, new.review_notes, new.rejection_reason, new.installed_at, new.installer_name, new.verified_by, new.verified_at, new.verification_notes, new.activated_at)
       is distinct from (old.reviewed_by, old.reviewed_at, old.review_notes, old.rejection_reason, old.installed_at, old.installer_name, old.verified_by, old.verified_at, old.verification_notes, old.activated_at) then
      raise exception 'Only Agent Ops can record review or installation details';
    end if;
  else
    if new.status is distinct from old.status and new.status in ('approved_for_installation','changes_required','rejected') then
      new.reviewed_by := auth.uid(); new.reviewed_at := now();
    end if;
    if new.status = 'active' and old.status <> 'active' then
      new.verified_by := auth.uid(); new.verified_at := now();
      new.activated_at := coalesce(old.activated_at, now());
      if old.agent_reward_status = 'not_eligible' then new.agent_reward_status := 'eligible'; end if;
      if old.owner_rent_status = 'not_due' then new.owner_rent_status := 'pending'; end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;