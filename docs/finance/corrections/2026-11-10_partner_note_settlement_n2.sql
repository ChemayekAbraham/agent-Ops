-- PROMISSORY NOTES SETTLED BY FUND-INS — item N2 of batch acct_corr_202611_notes. CFO approval 10 Nov 2026:
-- "I approve including N2 (121 notes, UGX134,550,000) under the same category and correction mechanism as N1."
--
-- ACCOUNTING RECORDS ONLY. NO MONEY MOVEMENT. For each listed note, settle_partner_receivable posts
-- DR L2 partner_receivable_capital / CR A7 partner_receivable_created for the part of the note already settled by
-- capital fund-ins the system attributes to it (commission_fund_ins.note_id). Bridge/platform legs only; never a
-- wallet leg; no wallet, portfolio, note, fund-in, Returns or payout changes. Nothing is deleted.
--
-- The list is the approved schedule of 10 Nov 2026 (121 notes). Note 0067f12b-5778-42cf-ae2c-c72fc3b99933
-- (UGX 4,000,000, fund-in recorded 10 Nov 15:07 Kampala, after the schedule) is NOT included.
-- Needs migration 20261111100000 and N1 (2026-11-10_partner_note_settlement.sql). Any failed check aborts everything.
-- Rollback: 2026-11-10_partner_note_settlement_rollback.sql (counter-entries for the whole batch).
begin;

create temp table _n2 (note_id uuid primary key, release numeric not null) on commit drop;
insert into _n2 (note_id, release) values
  ('000f18fd-62e1-4abb-8f07-85f235864b2c', 1000000),
  ('00883a24-3109-4bc7-bd9e-427eab1a7e03', 100000),
  ('01c315db-6ca6-46ab-b822-a34c1d9ed4a3', 100000),
  ('0367b072-d877-4249-a05e-36b3eadf6b54', 3000000),
  ('040d869a-e3da-437a-adfd-3f7b6fa4983a', 840000),
  ('0a557186-4480-407d-adc7-76bd232ef645', 2000000),
  ('0ec936b7-98c8-4faf-aeb3-be13cad6009d', 2000000),
  ('15ab4128-9bfc-4b2d-86e5-94d118e9b27a', 150000),
  ('1808889c-da68-4934-a6a4-3da1d27aca57', 1000000),
  ('1b9510ed-3a6a-4826-b742-3d81010e0b79', 100000),
  ('1b9bda98-2285-45f0-9285-d93c3a66017c', 5000000),
  ('1c56d980-fd16-4145-bce4-2db9455ac5ca', 100000),
  ('2029481e-6959-42b4-8a24-83ccf9c7ab11', 2500000),
  ('20ce099f-0971-4315-9075-e0b6f0cfbc07', 10000000),
  ('272b77cc-ab34-4cff-9691-cb33ce58d075', 2000000),
  ('28085aa0-b5e0-40cc-8607-3979c3a943ad', 200000),
  ('2c3c0303-6cf5-4e94-ae16-bac3301f026b', 105000),
  ('2e4785bb-271d-4bfe-b4be-0db6a0aa2bc3', 100000),
  ('324853a5-c2f4-4f8e-a59e-ca513db44a2b', 1400000),
  ('334f8c86-fc4a-4611-b765-bb25373fa1ed', 50000),
  ('34164199-a759-4a66-99ab-915369a6bdd6', 4000000),
  ('381c00ca-c7dc-48e4-88b9-2ea840900f33', 1000000),
  ('3a0848f9-e9fd-4a88-b2fc-c39e9b4a7ca8', 100000),
  ('3a700776-5a6b-420c-8f30-c84b95a0b502', 3100000),
  ('3cf20a3d-f673-41bd-a8ba-d52369306335', 500000),
  ('3eb09aa8-b5cf-46ae-b302-93e37cb77bb8', 50000),
  ('40b11732-2011-40ad-8e84-7e438bc8305f', 50000),
  ('438ac174-9b0a-406d-911f-e07f31a515d6', 100000),
  ('445c0040-3775-4665-91c3-b437dd4e84c1', 100000),
  ('4538edfb-179e-456e-b605-0f1fe428a83a', 150000),
  ('47012ce0-1bdb-408b-89f6-9e55ef4a16c5', 1500000),
  ('478413e6-58b1-4b28-8825-303d11eb12ff', 500000),
  ('508d0ac1-d866-463a-9826-88b55ff04ee1', 50000),
  ('526a1fe4-e625-499d-b218-94bb3e2af765', 100000),
  ('53b6bf1a-32dd-49cd-995c-4b93d906e8d1', 1000000),
  ('57ea14bd-dbca-4524-b653-1abe547d7c2a', 100000),
  ('585da54c-79a4-4474-8c64-eb9e447e5ac9', 1000000),
  ('59b00c39-2542-4823-b245-060f6345f02b', 100000),
  ('5bdeb319-2a85-4806-b10f-11dd88eb3697', 1000000),
  ('5d52b487-81d1-47a6-adff-d1b172fb3397', 20000),
  ('5ddaad72-0e18-41ea-aa31-a8ead9d469bc', 100000),
  ('5e3f9e32-5bc3-4a0d-912a-4046019d5c34', 5000000),
  ('5ea5929f-94eb-48fb-9de2-507a9c348d35', 500000),
  ('6297ef7a-047f-4cf9-9764-1e03aec30e57', 3500000),
  ('643b6aa3-76d1-4871-a440-63ef16ccb898', 1000000),
  ('64b9af73-996d-42ff-981a-ce09cf61c5b0', 100000),
  ('655f4ee9-a5b9-426b-b6bd-4ceff6322133', 100000),
  ('65952d8b-a113-49eb-bfe4-477268523d7f', 400000),
  ('660b9930-95c4-4dae-8378-18ae26266c97', 100000),
  ('6811432f-8fa2-4e2c-b38f-b77ac2fe23c4', 500000),
  ('6a1fa4f8-4429-4382-b9b0-ca4e7346408e', 500000),
  ('6a428e38-4d20-4845-9fb2-ed6344f630b0', 1000000),
  ('6c7245c9-81cf-46ce-9cc5-94c4769390e4', 500000),
  ('711ef71e-3cb4-4a86-83a2-8f6874f83141', 200000),
  ('72dfd06a-5b1b-40aa-ae99-a236162a96cb', 1000000),
  ('7323e472-3fdb-4870-a6a6-ac83d8633fd6', 1000000),
  ('733f9b65-711a-4b44-9d0b-dfb9e8892983', 100000),
  ('77809c25-f34b-45fb-8fdd-74c686d2f453', 1000000),
  ('7875be46-ba70-43e8-b15e-5cc1fdedb979', 400000),
  ('78f2ac21-6455-4349-9f3e-927bd6f1cc14', 700000),
  ('7af020a4-023b-43c7-b4fb-ed148c358405', 50000),
  ('7b0a4c6d-3b96-41fe-92c4-0a2ab0263711', 5000000),
  ('7c7bce6c-634a-4480-9d40-9a44eb50f4ee', 100000),
  ('7d4604c5-323f-4505-b55b-147ee261c962', 3000000),
  ('7fa6e371-9c75-485f-b9f7-35ac13f21e5a', 2000000),
  ('7fb19fe5-c290-4cd7-a164-5eba1f384ed9', 100000),
  ('80558d8d-787f-44fa-82be-1169cff950f5', 100000),
  ('81545f23-8f4e-4515-9d18-ae7df2592cd7', 2000000),
  ('846e607e-56a2-4faa-93c8-61d5b0a17b01', 100000),
  ('847d023b-d7b2-42ca-a7b5-9175df320921', 100000),
  ('8be4422f-56f5-4600-b1e7-a11209d5cf07', 100000),
  ('8d0a6300-cf5b-4261-9363-b54e5893ed3a', 500000),
  ('933cd25f-2f89-45eb-95fd-dd451872e017', 200000),
  ('93adfce6-8705-4ce1-a49d-e15fba714b08', 50000),
  ('9552b277-9398-4dc5-acfa-c87710f2252a', 100000),
  ('9620687b-9106-4ae2-a52d-979e3b5dab65', 1000000),
  ('98a21d9b-f08b-40da-9b06-bd150e80beb0', 1000000),
  ('9de72ebe-c1b8-45d9-904c-9aba337c76c0', 500000),
  ('9dff56c9-d908-452f-a035-0c6cdf4ee394', 85000),
  ('9fdde260-c785-43a9-a9ad-3321f7845059', 300000),
  ('aadb55ee-2e7c-4ee8-9c2b-e6e38b158f1f', 390000),
  ('b371807b-650e-4226-ad93-f5bfdd00a297', 2000000),
  ('b503ed6e-b0c2-470e-b91a-2e57b33f4455', 4000000),
  ('b69ddf0b-1666-4f2d-a42d-b66360c521d2', 600000),
  ('b88dac34-9b2d-4757-a05d-a22e7f692ba4', 1000000),
  ('bb1ddb5c-ae2b-4131-9792-20d5987a39e1', 100000),
  ('be17ec74-a1d4-4da2-b5b4-ba870f5f4e07', 1000000),
  ('bfb94e26-c054-42c8-aa9f-8bf22c20e48e', 100000),
  ('c2266e60-fb36-48bf-8979-ef41c65356f7', 500000),
  ('c25f4fa1-b868-45c0-ab4b-f5cbf3589dcb', 50000),
  ('c2aa568f-446f-4158-aed2-dab9bdb718f5', 700000),
  ('c2d96129-ebd4-4973-a5b4-442a6050c2e7', 150000),
  ('c2e989c2-e7ab-49d0-9dd5-68dcb24dfaf4', 20000000),
  ('ca129605-0380-4026-be50-96e6b1c5698e', 750000),
  ('cac5ae00-ccd5-44ce-8975-fcec7d332879', 1000000),
  ('cc650b02-90f3-4d07-a635-1bd7c5dd4257', 2000000),
  ('ccde4f37-bdcc-4cd6-bbf2-44bbbb86f153', 3500000),
  ('cffd197d-b49e-4b0e-8b63-ad59c1cac4c9', 500000),
  ('d194ffec-95db-4edb-8245-2c0b1ce74930', 1000000),
  ('d1c832a7-7119-4504-ad80-cc91870cb0ca', 550000),
  ('d2312749-6fff-477b-9097-72d3740debea', 1000000),
  ('d41dd342-a485-4996-a76c-5d5dba13364b', 200000),
  ('d44929a7-7d18-4c45-9afc-82593e2efe98', 800000),
  ('d5a0c5f8-a07e-45fc-a86d-aacc402382fd', 1000000),
  ('d91e9a0f-3d24-4870-956a-6dd3e6912405', 100000),
  ('d930ddad-78ca-4d5a-8e62-9c5b6f0f3290', 1000000),
  ('e2f93e24-0a94-40e2-9aed-8760c16cf843', 600000),
  ('e96b0a93-a965-4570-b78d-69c3f67b0ae7', 100000),
  ('e9eff2d9-36c4-441d-b6b2-a3cbd0cd087e', 1000000),
  ('edda2c88-8609-403c-b11e-69d09bc8b2ea', 500000),
  ('ef12de48-d010-475d-9355-c04a1acd8d54', 10000),
  ('ef39464c-582a-4f66-b086-ba1739083014', 1000000),
  ('efc332fd-7330-4cff-bf80-edc97e9661c6', 100000),
  ('efe09ac9-eef7-4c4a-8157-04c5c249ef13', 100000),
  ('f140c89e-1136-42e3-8f50-a0f4f16adba7', 100000),
  ('f1972cc5-4132-4559-8ea5-4f58a0a46f45', 100000),
  ('f21e0ac7-4c4a-45d3-a6c2-1183ad93c6de', 500000),
  ('f2eb0c7e-1d74-4420-882d-cbf5ce2b199e', 100000),
  ('fa7af7cb-8e93-471f-bca7-617eea0788eb', 500000),
  ('fad8fafb-1680-4f1d-beea-1031e0f4cbda', 500000),
  ('fcec3f24-92ec-4013-8ad0-fe64f6a506fc', 5000000)
;
create temp table _expected (n int not null, amount numeric not null) on commit drop;
insert into _expected values (121, 134550000);

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_notes';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  r record; e record; v_n int; v_x numeric; v_res jsonb; s_wallet_legs bigint; s_wallet_sum numeric;
  s_wp text; s_wbp text; s_pf text; s_notes text; s_fi text; h text;
begin
  if to_regprocedure('public.settle_partner_receivable(uuid,text)') is null then
    raise exception 'STOP: apply migration 20261111100000 first';
  end if;
  if not exists (select 1 from public.accounting_correction_register where batch = c_batch and correction_item = 'N1') then
    raise exception 'STOP: post N1 first';
  end if;
  if exists (select 1 from public.accounting_correction_register where batch = c_batch and correction_item = 'N2') then
    raise exception 'STOP: N2 of batch % is already posted', c_batch;
  end if;

  -- 1. The schedule must be exactly what was approved, and each note must still need exactly that release.
  select * into e from _expected;
  select count(*), coalesce(sum(release), 0) into v_n, v_x from _n2;
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: N2 input is % / %, approved % / %', v_n, v_x, e.n, e.amount; end if;
  for r in
    select x.note_id, x.release, v.outstanding, n.status,
           (select coalesce(sum(case when g.direction = 'cash_in' then g.amount else -g.amount end), 0) from public.general_ledger g
             where g.category = 'partner_receivable_created' and g.ledger_scope = 'bridge' and g.source_id = x.note_id) net
    from _n2 x left join public.v_partner_note_settlement v on v.note_id = x.note_id left join public.promissory_notes n on n.id = x.note_id
  loop
    if r.status is null or round(r.net - r.outstanding) <> r.release then
      raise exception 'STOP: note % changed since the schedule (needs %, schedule %)', r.note_id, round(r.net - r.outstanding), r.release;
    end if;
  end loop;

  -- 2. Money-safety snapshot.
  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into s_wp from public.wallets_physical t;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into s_wbp from public.wallet_balances_projection t;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_pf from public.investor_portfolios t;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_notes from public.promissory_notes t;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_fi from public.commission_fund_ins t;

  -- 3. Release each listed note through the same mechanism as N1.
  for r in select note_id, release from _n2 order by note_id loop
    v_res := public.settle_partner_receivable(r.note_id);
    if not coalesce((v_res->>'posted')::boolean, false) or (v_res->>'amount')::numeric <> r.release then
      raise exception 'STOP: note % did not release as scheduled: %', r.note_id, v_res;
    end if;
    if exists (select 1 from public.general_ledger g where g.transaction_group_id = (v_res->>'group_id')::uuid
                and (g.ledger_scope = 'wallet' or g.ledger_scope not in ('bridge', 'platform'))) then
      raise exception 'STOP: settlement group for note % is not bridge/platform only', r.note_id;
    end if;
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
    values ((v_res->>'group_id')::uuid, 'Promissory note settled by Supporter capital (accounting only): not money received', 'N2');
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, correction_group_id,
      amount, before_value, after_value, detail, created_by)
    values (c_batch, 'N2', 'settle_partner_receivable', 'promissory_notes', r.note_id, (v_res->>'group_id')::uuid, r.release,
      (v_res->>'net_before')::numeric, (v_res->>'outstanding')::numeric,
      jsonb_build_object('idempotency_key', v_res->>'idempotency_key', 'basis', v_res->>'basis'), c_cfo);
  end loop;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch and correction_item = 'N2';
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: N2 posted % / %', v_n, v_x; end if;

  -- 4. Money-safety: nothing that holds or moves money changed.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> s_wallet_legs or v_x <> s_wallet_sum then raise exception 'STOP: a wallet-scope ledger leg was written'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into h from public.wallets_physical t;
  if h <> s_wp then raise exception 'STOP: wallets_physical changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into h from public.wallet_balances_projection t;
  if h <> s_wbp then raise exception 'STOP: wallet_balances_projection changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into h from public.investor_portfolios t;
  if h <> s_pf then raise exception 'STOP: a portfolio changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into h from public.promissory_notes t;
  if h <> s_notes then raise exception 'STOP: a promissory note changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into h from public.commission_fund_ins t;
  if h <> s_fi then raise exception 'STOP: a fund-in record changed'; end if;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  values (c_cfo, 'accounting_correction_batch_posted', 'partner_note_settlement_n2', 'accounting_correction_register', c_batch,
    'Promissory notes settled by fund-ins, item N2 (accounting records only, no money movement)',
    jsonb_build_object('batch', c_batch, 'item', 'N2', 'notes', e.n, 'amount', e.amount));
  raise notice 'batch % item N2 posted: % notes, UGX %', c_batch, e.n, e.amount;
end $corr$;

commit;
