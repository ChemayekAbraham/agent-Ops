-- Money In: stop counting accounting corrections as money received; correction register (CFO, 2026-11-08).
--
-- ACCOUNTING AND REPORTING ONLY. No money, wallet, payment, collection or ledger row is changed by this file.
--
-- WHY
-- Money In (get_cfo_received_by_category_totals / _page) adds up every platform `cash_in` leg in a mapped category.
-- Some of those legs are not money:
--   * group eb648b95-0494-451c-b2d3-142ee2be69f0 (16 Sep 2026): the contra of the 1,210 duplicate rent collections.
--     Its DR A3 leg (`tenant_repayment_collected`, cash_in, UGX 92,656,683) showed as Tenant Products and Services.
--   * fee postings later reversed in full: the 440 duplicate-collection fee groups (UGX 15,996,841, reversed by Finance
--     on 2026-10-01, keys fee_rev_floatgate:*). Their access-fee legs (UGX 14,119,617) still showed as Revenue Collected,
--     because Money In reads cash_in only and never sees the cash_out reversal.
-- Excluding by idempotency-key prefix (the existing rule) cannot catch either: the contra has no key, and the fee
-- originals carry the ordinary rent-fee-collection key.
--
-- WHAT THIS DOES
-- 1. public.money_in_report_exclusions: one row per ledger GROUP that Money In must not count, with the reason.
--    Seeded with the contra group and both sides of every fee posting already reversed (allocation carries
--    reversal_group_id). Every later correction that is not money adds its group here.
-- 2. A trigger keeps it in step: when an allocation's fee posting is reversed later (reversal_group_id set, e.g. by
--    reverse_rent_fee_allocation), both groups are excluded automatically.
-- 3. public.accounting_correction_register: one row per correction posted, naming the original record, the original
--    ledger group/legs and the correction group. Unique per (item, source, action), so a correction cannot post twice.
-- 4. Money In totals/page: the live definitions (read-only export 2026-11-08), unchanged except one NOT EXISTS line.
--
-- Effect on September 2026 Money In (read-only, before any correction is posted):
--   Tenant Products and Services 162,419,916 -> 69,763,233 (-92,656,683, the contra)
--   Revenue Collected             25,157,934 -> 11,038,317 (-14,119,617, access fees of reversed duplicates)
-- No other month changes.
--
-- Rollback: supabase/rollbacks/20261108150000_money_in_exclusions_and_correction_register.rollback.sql

create table if not exists public.money_in_report_exclusions (
  transaction_group_id uuid primary key,
  reason               text not null,
  correction_item      text,
  reverses_group_id    uuid,
  created_at           timestamptz not null default now(),
  created_by           uuid default auth.uid()
);
comment on table public.money_in_report_exclusions is
  'Ledger groups the CFO Money In report must not count as money received (accounting corrections, reversals). Reporting only; never changes the ledger.';

create table if not exists public.accounting_correction_register (
  id                   uuid primary key default gen_random_uuid(),
  batch                text not null,
  correction_item      text not null,
  action               text not null,
  source_table         text not null,
  source_id            uuid not null,
  rent_request_id      uuid,
  original_group_id    uuid,
  original_leg_ids     uuid[],
  correction_group_id  uuid,
  rebook_group_id      uuid,
  amount               numeric not null,
  before_value         numeric,
  after_value          numeric,
  detail               jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  created_by           uuid default auth.uid(),
  rolled_back_at       timestamptz,
  rollback_group_id    uuid,
  constraint accounting_correction_register_once unique (correction_item, source_table, source_id, action)
);
create index if not exists accounting_correction_register_batch_idx on public.accounting_correction_register (batch);
comment on table public.accounting_correction_register is
  'One row per approved accounting correction: what was corrected (source), the original ledger group/legs, the correction group. Unique per item/source/action so nothing posts twice.';

alter table public.money_in_report_exclusions enable row level security;
alter table public.accounting_correction_register enable row level security;

drop policy if exists finance_reads_money_in_exclusions on public.money_in_report_exclusions;
create policy finance_reads_money_in_exclusions on public.money_in_report_exclusions for select to authenticated
  using ((select public.has_role((select auth.uid()), 'cfo'::app_role))
      or (select public.has_role((select auth.uid()), 'ceo'::app_role))
      or (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
drop policy if exists finance_reads_correction_register on public.accounting_correction_register;
create policy finance_reads_correction_register on public.accounting_correction_register for select to authenticated
  using ((select public.has_role((select auth.uid()), 'cfo'::app_role))
      or (select public.has_role((select auth.uid()), 'ceo'::app_role))
      or (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
drop policy if exists mfa_required_for_staff on public.money_in_report_exclusions;
create policy mfa_required_for_staff on public.money_in_report_exclusions as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
drop policy if exists mfa_required_for_staff on public.accounting_correction_register;
create policy mfa_required_for_staff on public.accounting_correction_register as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

-- Read-only for staff; written only by migrations and approved correction scripts (service role / owner).
revoke all on public.money_in_report_exclusions from anon, authenticated;
revoke all on public.accounting_correction_register from anon, authenticated;
grant select on public.money_in_report_exclusions to authenticated;
grant select on public.accounting_correction_register to authenticated;
grant select, insert, update, delete on public.money_in_report_exclusions to service_role;
grant select, insert, update, delete on public.accounting_correction_register to service_role;

-- Seed: the contra, and both sides of every fee posting already reversed.
insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
select g.transaction_group_id,
       'Contra of the 1,210 duplicate rent collections of 15-16 Sep 2026 (float-gate defect): accounting entry, no money received',
       'D'
from public.general_ledger g
where g.transaction_group_id = 'eb648b95-0494-451c-b2d3-142ee2be69f0'
group by g.transaction_group_id
on conflict (transaction_group_id) do nothing;

insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
select distinct ia.transaction_group_id, 'Fee posting reversed in full (allocation reversed): not money received', 'D'
from public.instalment_allocations ia
where ia.reversed_at is not null and ia.reversal_group_id is not null and ia.transaction_group_id is not null
on conflict (transaction_group_id) do nothing;

insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item, reverses_group_id)
select distinct on (ia.reversal_group_id) ia.reversal_group_id, 'Reversal of a fee posting: not money received', 'D', ia.transaction_group_id
from public.instalment_allocations ia
where ia.reversed_at is not null and ia.reversal_group_id is not null
order by ia.reversal_group_id
on conflict (transaction_group_id) do nothing;

-- Keep it in step: a fee posting reversed later is excluded on both sides automatically.
create or replace function public._money_in_exclude_reversed_allocation()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.reversal_group_id is not null and new.reversal_group_id is distinct from old.reversal_group_id then
    if new.transaction_group_id is not null then
      insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
      values (new.transaction_group_id, 'Fee posting reversed in full (allocation reversed): not money received', 'auto')
      on conflict (transaction_group_id) do nothing;
    end if;
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item, reverses_group_id)
    values (new.reversal_group_id, 'Reversal of a fee posting: not money received', 'auto', new.transaction_group_id)
    on conflict (transaction_group_id) do nothing;
  end if;
  return null;
end $function$;
revoke all on function public._money_in_exclude_reversed_allocation() from public, anon, authenticated;

drop trigger if exists trg_money_in_exclude_reversed_allocation on public.instalment_allocations;
create trigger trg_money_in_exclude_reversed_allocation
  after update of reversal_group_id on public.instalment_allocations
  for each row execute function public._money_in_exclude_reversed_allocation();

-- Money In: live definitions (read-only export 2026-11-08) plus one NOT EXISTS line each. Same signatures, so the
-- existing grants (authenticated) are kept.

CREATE OR REPLACE FUNCTION public.get_cfo_received_by_category_totals(p_from date, p_to date)
 RETURNS TABLE(category_key text, category_label text, nature text, sort_order integer, amount numeric, tx_count bigint, pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT g.category AS c, g.source_table AS s, sum(g.amount) AS amt, count(*) AS n
    FROM public.general_ledger g
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND left(COALESCE(g.idempotency_key, ''), 30) <> 'smartphone_a10_to_a12_reclass:' -- 2026-11-03: not money received (reclassification)
      AND left(COALESCE(g.idempotency_key, ''), 34) <> 'merch_a12_a13_correction_20261104:' -- 2026-11-04: not money received (merchandise correction)
      AND left(COALESCE(g.idempotency_key, ''), 19) <> 'merch_recv_derecog:' -- 2026-11-04: not money received (receivable derecognition)
      AND NOT EXISTS (SELECT 1 FROM public.money_in_report_exclusions x WHERE x.transaction_group_id = g.transaction_group_id) -- 2026-11-08: accounting corrections and reversals are not money received
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
    GROUP BY g.category, g.source_table
  ), agg AS (
    SELECT public._cfo_received_category_for(r.c, r.s) AS cat_key, sum(r.amt) AS amt, sum(r.n) AS n
    FROM raw r GROUP BY 1
  ), agg2 AS (SELECT * FROM agg WHERE agg.cat_key IS NOT NULL),
  grand AS (SELECT COALESCE(sum(a.amt), 0) AS total FROM agg2 a)
  SELECT f.k, f.l, f.nat, f.s, round(COALESCE(a.amt, 0), 2), COALESCE(a.n, 0)::bigint,
         round(CASE WHEN gr.total > 0 THEN COALESCE(a.amt, 0) * 100 / gr.total ELSE 0 END, 2)
  FROM (VALUES
    ('partner', 'Partner Products and Services', 'capital', 1),
    ('land', 'Tenant Products and Services', 'recovery', 2),
    ('landlord', 'Landlord Products and Services', 'recovery', 3),
    ('agent', 'Agent Products and Services', 'recovery', 4),
    ('fees', 'Revenue Collected', 'income', 5),
    ('other_income', 'Other Income', 'income', 6),
    ('capital', 'Share Capital', 'capital', 7)
  ) AS f(k, l, nat, s)
  LEFT JOIN agg2 a ON a.cat_key = f.k
  CROSS JOIN grand gr
  ORDER BY f.s;
END $function$;

CREATE OR REPLACE FUNCTION public.get_cfo_received_by_category_page(p_from date, p_to date, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_type text DEFAULT NULL::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, transaction_date timestamp with time zone, created_at timestamp with time zone, category_key text, category_label text, ledger_category text, amount numeric, description text, reference_id text, counterparty text, counterparty_phone text, approved_by text, source_table text, transaction_group_id uuid, classification text, total_matched bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz; v_to timestamptz; v_search text := nullif(btrim(p_search), '');
        v_type text := nullif(btrim(lower(p_type)), '');
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  IF v_type IS NOT NULL AND v_type NOT IN ('smartphone', 'bike', 'advance') THEN
    RAISE EXCEPTION 'unknown product type %', p_type USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH base AS MATERIALIZED (
    SELECT g.id AS gid, g.transaction_date AS tdate, g.category AS c, g.source_table AS s,
           mp.is_bike_lease AS bike
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp
      ON v_type IS NOT NULL AND g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id
    LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND left(COALESCE(g.idempotency_key, ''), 30) <> 'smartphone_a10_to_a12_reclass:' -- 2026-11-03: not money received (reclassification)
      AND left(COALESCE(g.idempotency_key, ''), 34) <> 'merch_a12_a13_correction_20261104:' -- 2026-11-04: not money received (merchandise correction)
      AND left(COALESCE(g.idempotency_key, ''), 19) <> 'merch_recv_derecog:' -- 2026-11-04: not money received (receivable derecognition)
      AND NOT EXISTS (SELECT 1 FROM public.money_in_report_exclusions x WHERE x.transaction_group_id = g.transaction_group_id) -- 2026-11-08: accounting corrections and reversals are not money received
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND (v_search IS NULL OR COALESCE(g.description, '') ILIKE '%' || v_search || '%'
           OR COALESCE(g.reference_id, '') ILIKE '%' || v_search || '%'
           OR COALESCE(g.linked_party, '') ILIKE '%' || v_search || '%'
           OR COALESCE(sp.full_name, '') ILIKE '%' || v_search || '%'
           OR COALESCE(sp.phone, '') ILIKE '%' || v_search || '%')
  ), cmap AS MATERIALIZED (
    SELECT d.c, d.s, public._cfo_received_category_for(d.c, d.s) AS ckey,
           public._cfo_received_category_for(d.c) AS plain
    FROM (SELECT DISTINCT b.c, b.s FROM base b) d
  ), pmap AS MATERIALIZED (
    SELECT d.c, d.s, d.bike, public._cfo_received_agent_product_for(d.c, d.s, d.bike) AS pkey
    FROM (SELECT DISTINCT b.c, b.s, b.bike FROM base b WHERE v_type IS NOT NULL) d
  ), f AS (
    SELECT b.gid, b.tdate, cm.ckey,
           CASE WHEN v_type IS NOT NULL AND cm.plain = 'agent' THEN pm.pkey END AS pkey
    FROM base b
    JOIN cmap cm ON cm.c IS NOT DISTINCT FROM b.c AND cm.s IS NOT DISTINCT FROM b.s
    LEFT JOIN pmap pm ON pm.c IS NOT DISTINCT FROM b.c AND pm.s IS NOT DISTINCT FROM b.s
                     AND pm.bike IS NOT DISTINCT FROM b.bike
  ), m AS (
    SELECT f.gid, f.tdate, f.ckey, count(*) OVER () AS n
    FROM f WHERE f.ckey IS NOT NULL AND (p_category IS NULL OR f.ckey = p_category)
      AND (v_type IS NULL OR f.pkey = v_type)
  ), pg AS (
    SELECT m.gid, m.tdate, m.ckey, m.n FROM m ORDER BY m.tdate DESC, m.gid
    LIMIT least(greatest(COALESCE(p_limit, 50), 1), 1000) OFFSET greatest(COALESCE(p_offset, 0), 0)
  )
  SELECT g.id, g.transaction_date, g.created_at, pg.ckey,
         CASE pg.ckey WHEN 'partner' THEN 'Partner Products and Services' WHEN 'land' THEN 'Tenant Products and Services'
           WHEN 'landlord' THEN 'Landlord Products and Services'
           WHEN 'agent' THEN 'Agent Products and Services' WHEN 'fees' THEN 'Revenue Collected'
           WHEN 'other_income' THEN 'Other Income' WHEN 'capital' THEN 'Share Capital' END,
         g.category, round(g.amount, 2), g.description, g.reference_id,
         COALESCE(cp.full_name, p.full_name), COALESCE(cp.phone, p.phone),
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN p.full_name END,
         g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN LATERAL (
    SELECT x.user_id FROM public.general_ledger x
    WHERE x.transaction_group_id = g.transaction_group_id
      AND x.ledger_scope = 'wallet' AND x.direction = 'cash_out' AND x.user_id IS NOT NULL
    ORDER BY x.amount DESC, x.id
    LIMIT 1
  ) cpl ON true
  LEFT JOIN public.profiles cp ON cp.id = cpl.user_id
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END $function$;
