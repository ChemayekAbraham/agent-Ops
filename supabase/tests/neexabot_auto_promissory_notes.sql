-- Test for 20261030140000_neexabot_auto_promissory_notes.sql. Run after the migration; always rolls back.
-- Expect: every NeexaBot note is approved with no verification bonus, fund-ins of note partners are paid
-- to NeexaBot at the engine rates, paid-up partners carry no receivable, a new agreement creates one note,
-- and a second call is a no-op.
do $$
declare msg text := ''; r record; v_bot uuid := public.neexabot_profile_id(); v_pid uuid; res jsonb;
begin
  for r in select n.partner_name, n.amount, n.total_collected, n.status, n.approval_bonus_paid,
                  (select coalesce(sum(g.amount),0) from general_ledger g
                    where g.source_id::text = n.id::text and g.category = 'partner_receivable_created') recv_amt
             from promissory_notes n where n.agent_id = v_bot order by 1 loop
    msg := msg || format(E'\nNOTE %s amt=%s collected=%s %s approved=%s receivable=%s',
      r.partner_name, r.amount, r.total_collected, r.status, r.approval_bonus_paid, r.recv_amt);
  end loop;
  for r in select p.full_name, f.status, f.kind, f.rate, f.commission, f.earner_id = v_bot as to_bot
             from commission_fund_ins f join profiles p on p.id = f.partner_id
            where p.referrer_id = v_bot order by 1 loop
    msg := msg || format(E'\nFUNDIN %s %s %s rate=%s commission=%s to_neexabot=%s',
      r.full_name, r.status, r.kind, r.rate, r.commission, r.to_bot);
  end loop;
  msg := msg || format(E'\nverification bonus legs to NeexaBot: %s  [expect 0]',
    (select count(*) from general_ledger where user_id = v_bot and idempotency_key like 'promissory_note_verified:%'));

  select pr.id into v_pid from profiles pr
   where pr.referrer_id = v_bot and length(regexp_replace(coalesce(pr.phone,''), '\D', '', 'g')) >= 9
     and not exists (select 1 from promissory_notes n where n.partner_user_id = pr.id)
     and not exists (select 1 from partner_agreements a where a.partner_id = pr.id)
   limit 1;
  if v_pid is null then
    msg := msg || E'\nTRIGGER skipped: no NeexaBot partner without a note and agreement';
  else
    insert into partner_agreements (partner_id, full_name, phone, partnership_amount, status)
    select v_pid, full_name, phone, 300000, 'pending' from profiles where id = v_pid;
    msg := msg || format(E'\nTRIGGER new agreement -> %s  [expect one approved note, 300000]',
      (select jsonb_agg(jsonb_build_object('amount', amount, 'status', status, 'approved', approval_bonus_paid))
         from promissory_notes where agent_id = v_bot and partner_user_id = v_pid));
    res := public.neexabot_ensure_partner_note(v_pid, 'retest');
    msg := msg || format(E'\nSECOND CALL %s  [expect skipped note_exists]', res);
  end if;
  raise exception 'TEST RESULT: %', msg;
end $$;
