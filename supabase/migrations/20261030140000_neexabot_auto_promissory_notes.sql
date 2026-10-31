-- NeexaBot auto promissory notes.
--
-- A partner referred by NeexaBot (profiles.referrer_id = the NeexaBot profile, neexabot@welileapp.com)
-- gets a promissory note in NeexaBot's name, approved automatically, so the fund-in commission engine
-- pays NeexaBot's wallet the same percentages a proxy agent earns: 2% of the first fund-in
-- (portfolio_creation) and 1% of later ones (portfolio_topup), from promissory_commission_rates.
--
-- Rules set by the user on 2026-10-30:
--   * NeexaBot is paid like a proxy agent: no UGX 1,500 verification bonus, percentages only.
--     approve_promissory_note is NOT used (it pays the bonus); the note is approved here directly.
--   * If the partner already has a promissory note, nothing is created and the partner is left alone.
--     "Already has a note" = any note that is not cancelled, matched like the commission engine does:
--     linked account, last 9 digits of phone/WhatsApp, email, or the same full name (the engine pays a
--     unique name match, e.g. Kobusinge Violet on 2026-10-29, so a name match is left to the humans).
--
-- When: on a new partnership agreement (contract amount known) and on a new fund-in candidate
-- (money arrived). Partners with neither have no amount yet and get their note later.
--
-- Ledger effects, all through existing code:
--   * the approval fires pay_commission_after_note_approval -> commission_pay_fund_in, which posts the
--     2% / 1% (marketing_expense -> NeexaBot wallet agent_commission) for any unattributed fund-in;
--   * activation fires recognise_partner_receivable for amount - total_collected. total_collected is set
--     to what the partner already has in active portfolios, so a partner who has already paid gets no
--     receivable; a pending contract is recognised like every other note.
--   * trg_partner_note_lead_override records 'skipped' (NeexaBot has no lead assignment).
--
-- Never blocks the agreement or fund-in that triggered it: every failure is caught and logged to
-- system_events.

create or replace function public.neexabot_profile_id()
 returns uuid language sql stable security definer set search_path to 'public'
as $f$
  select id from public.profiles where email = 'neexabot@welileapp.com' limit 1
$f$;
revoke all on function public.neexabot_profile_id() from public, anon, authenticated;
grant execute on function public.neexabot_profile_id() to service_role;

create or replace function public.neexabot_ensure_partner_note(p_partner uuid, p_trigger text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $f$
declare
  v_bot uuid := public.neexabot_profile_id();
  p record;
  v_phone text; v_phone9 text; v_email text; v_name text;
  v_contract numeric; v_active numeric; v_cand numeric; v_amount numeric;
  v_existing uuid;
  v_note uuid;
begin
  if v_bot is null or p_partner is null or p_partner = v_bot then
    return jsonb_build_object('status','skipped','reason','not_applicable');
  end if;

  select pr.id, pr.full_name, pr.phone, pr.email, pr.referrer_id into p
    from public.profiles pr where pr.id = p_partner;
  if p.id is null or p.referrer_id is distinct from v_bot then
    return jsonb_build_object('status','skipped','reason','not_referred_by_neexabot');
  end if;
  if coalesce(p.full_name,'') like '[DELETED]%' then
    return jsonb_build_object('status','skipped','reason','deleted_profile');
  end if;

  -- Serialise per partner so an agreement and a fund-in arriving together create one note.
  perform pg_advisory_xact_lock(hashtextextended('neexabot_note:' || p_partner::text, 0));

  select a.partnership_amount, nullif(btrim(a.phone),'') into v_contract, v_phone
    from public.partner_agreements a
   where a.partner_id = p_partner and a.status in ('pending','countersigned')
   order by a.created_at desc limit 1;
  v_phone  := coalesce(nullif(btrim(p.phone),''), v_phone);
  v_phone9 := right(regexp_replace(coalesce(v_phone,''), '\D', '', 'g'), 9);
  v_email  := nullif(lower(btrim(coalesce(p.email,''))), '');
  v_name   := nullif(lower(regexp_replace(btrim(coalesce(p.full_name,'')), '\s+', ' ', 'g')), '');

  select n.id into v_existing
    from public.promissory_notes n
   where n.status <> 'cancelled'
     and (   n.partner_user_id = p_partner
          or (length(v_phone9) = 9 and (
                 right(regexp_replace(coalesce(n.whatsapp_number,''), '\D', '', 'g'), 9) = v_phone9
              or right(regexp_replace(coalesce(n.phone_number,''), '\D', '', 'g'), 9) = v_phone9))
          or (v_email is not null and lower(btrim(coalesce(n.email,''))) = v_email)
          or (v_name is not null and position(' ' in v_name) > 0 and length(v_name) >= 5
              and lower(regexp_replace(btrim(coalesce(n.partner_name,'')), '\s+', ' ', 'g')) = v_name))
   order by n.created_at limit 1;
  if v_existing is not null then
    return jsonb_build_object('status','skipped','reason','note_exists','note_id',v_existing);
  end if;

  if length(v_phone9) < 9 then
    insert into public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    values ('neexabot.promissory_note.no_phone', p_partner, 'profiles', p_partner,
            'NeexaBot partner has no phone number, so no promissory note was created',
            jsonb_build_object('trigger', p_trigger));
    return jsonb_build_object('status','skipped','reason','no_phone');
  end if;

  select coalesce(sum(ip.investment_amount),0) into v_active
    from public.investor_portfolios ip
   where ip.investor_id = p_partner and ip.status = 'active';
  select max(c.amount) into v_cand
    from public.commission_fund_in_candidates c where c.partner_id = p_partner;

  v_amount := greatest(coalesce(v_contract,0), v_active, coalesce(v_cand,0));
  if v_amount <= 0 then
    return jsonb_build_object('status','skipped','reason','no_amount_yet');
  end if;

  begin
    insert into public.promissory_notes (
      agent_id, partner_name, whatsapp_number, phone_number, email, partner_user_id,
      amount, contribution_type, support_mode, status, total_collected, recorded_on, notes
    ) values (
      v_bot, coalesce(nullif(btrim(p.full_name),''), 'NeexaBot partner'), v_phone, v_phone, v_email, p_partner,
      v_amount, 'once_off', 'existing_support', 'pending', least(v_active, v_amount), current_date,
      'Created automatically: partner referred by NeexaBot (' || p_trigger || ').'
    ) returning id into v_note;

    -- Approve directly (proxy-agent terms: no verification bonus). Fires the one-note guard,
    -- the receivable recognition and the fund-in commission catch-up.
    update public.promissory_notes
       set approval_bonus_paid = true, approved_at = now(), approved_by = v_bot,
           approval_reason = 'Automatic approval: partner referred by NeexaBot. Paid as a proxy agent, percentages only, no verification bonus.',
           status = 'activated', updated_at = now()
     where id = v_note;
  exception when others then
    insert into public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    values ('neexabot.promissory_note.failed', p_partner, 'profiles', p_partner,
            'NeexaBot promissory note could not be created',
            jsonb_build_object('trigger', p_trigger, 'error', sqlerrm, 'amount', v_amount));
    return jsonb_build_object('status','error','reason',sqlerrm);
  end;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  values (v_bot, 'create', 'neexabot_auto_promissory_note', 'promissory_notes', v_note::text,
          jsonb_build_object('partner_id', p_partner, 'partner_name', p.full_name, 'amount', v_amount,
                             'contract_amount', v_contract, 'active_principal', v_active,
                             'trigger', p_trigger, 'bonus_amount', 0));
  insert into public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
  values ('neexabot.promissory_note.created', p_partner, 'promissory_notes', v_note,
          'Promissory note created and approved for a NeexaBot partner',
          jsonb_build_object('trigger', p_trigger, 'amount', v_amount, 'agent_id', v_bot));

  return jsonb_build_object('status','created','note_id',v_note,'amount',v_amount);
end;
$f$;
revoke all on function public.neexabot_ensure_partner_note(uuid, text) from public, anon, authenticated;
grant execute on function public.neexabot_ensure_partner_note(uuid, text) to service_role;

create or replace function public.trg_neexabot_note_on_agreement()
 returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $f$
begin
  begin
    perform public.neexabot_ensure_partner_note(NEW.partner_id, 'partnership_agreement');
  exception when others then
    raise warning 'neexabot_ensure_partner_note (agreement %) failed: %', NEW.id, sqlerrm;
  end;
  return null;
end $f$;

create or replace function public.trg_neexabot_note_on_fund_in()
 returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp'
as $f$
begin
  begin
    perform public.neexabot_ensure_partner_note(NEW.partner_id, 'fund_in');
  exception when others then
    raise warning 'neexabot_ensure_partner_note (candidate %) failed: %', NEW.id, sqlerrm;
  end;
  return null;
end $f$;
revoke all on function public.trg_neexabot_note_on_agreement() from public, anon, authenticated;
revoke all on function public.trg_neexabot_note_on_fund_in() from public, anon, authenticated;

drop trigger if exists neexabot_note_on_agreement on public.partner_agreements;
create trigger neexabot_note_on_agreement
  after insert on public.partner_agreements
  for each row when (NEW.partner_id is not null)
  execute function public.trg_neexabot_note_on_agreement();

drop trigger if exists neexabot_note_on_fund_in on public.commission_fund_in_candidates;
create trigger neexabot_note_on_fund_in
  after insert on public.commission_fund_in_candidates
  for each row when (NEW.partner_id is not null)
  execute function public.trg_neexabot_note_on_fund_in();

-- Backfill: NeexaBot partners who already have a contract or money in.
do $$
declare r record; res jsonb;
begin
  for r in
    select pr.id, pr.full_name from public.profiles pr
     where pr.referrer_id = public.neexabot_profile_id()
       and (exists (select 1 from public.partner_agreements a where a.partner_id = pr.id and a.status in ('pending','countersigned'))
            or exists (select 1 from public.investor_portfolios ip where ip.investor_id = pr.id and ip.status = 'active')
            or exists (select 1 from public.commission_fund_in_candidates c where c.partner_id = pr.id))
     order by pr.created_at
  loop
    res := public.neexabot_ensure_partner_note(r.id, 'backfill_2026_10_30');
    raise notice 'neexabot backfill % -> %', r.full_name, res;
  end loop;
end $$;
