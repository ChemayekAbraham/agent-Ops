-- NOT APPLIED. Benjamin must approve this file before it is run.
-- Do not apply it to project byrzshwlentqvktcksem from this pull request.
-- Apply after 20261102160000_v360_cycle_waterfall.sql.
--
-- Adds ledger categories for the 360-day cycle. It does not post a single
-- shilling and does not call create_ledger_transaction. Existing mapping rows,
-- including partner_funding (financing), are not updated.
--
-- The cash-flow column is cash_flow_line_map.section. That is the cf_section
-- in the approval note. New v360 partner capital and partner margin rows are
-- section = operating. Historical partner capital stays in financing.
--
-- Intended groups, for a later CFO posting package. All legs must set
-- ledger_scope = 'platform' explicitly (auto_assign_ledger_scope defaults an
-- omitted scope to wallet and would move a balance). None of these groups is
-- posted here.
--
--   Cover Pool contribution:  platform v360_cover_pool cash_in     CREDIT L10
--   Proxy fee from that pool: platform v360_cover_pool cash_out    DEBIT  L10
--                             platform v360_proxy_agent_commission cash_in CREDIT L5
--   Welile 7% (full):         platform v360_platform_revenue cash_in CREDIT R1
--   Tithe, from that 7% only: platform v360_platform_revenue cash_out DEBIT R1
--                             platform v360_tithe cash_in            CREDIT L11
--
-- L10 and L11 are new liability accounts. L8 is already Unearned Agent Advance
-- Penalty Income, so it is not reused.

SET lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.ledger_account_catalog') IS NULL
     OR to_regclass('public.ledger_account_map') IS NULL
     OR to_regclass('public.cash_flow_line_map') IS NULL
     OR to_regprocedure('public.ledger_category_allowlist()') IS NULL THEN
    RAISE EXCEPTION 'a ledger object this file uses is missing; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_account_catalog WHERE code IN ('L10', 'L11')) THEN
    RAISE EXCEPTION 'L10 or L11 already exists; nothing was changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ledger_account_map
    WHERE category LIKE 'v360\_%'
  ) THEN
    RAISE EXCEPTION 'a v360 ledger category is already mapped; nothing was changed';
  END IF;
END
$pre$;

INSERT INTO public.ledger_account_catalog (code, label, nature, section, sort_order)
VALUES
  ('L10', 'Cover Pool (360-day Rent Plans)', 'liability', 'current_liability', 70),
  ('L11', 'Tithe Payable (from Welile 7%)', 'liability', 'current_liability', 75);

INSERT INTO public.ledger_account_map (ledger_scope, wallet_bucket, category, account_code, debit_when, notes)
VALUES
  ('platform', NULL, 'v360_cover_pool', 'L10', 'cash_out',
   '360-day Cover Pool. cash_in credits the segregated pool. cash_out reduces it when the pool pays the Proxy Agent or a missed day. Not Welile revenue.'),
  ('platform', NULL, 'v360_proxy_agent_commission', 'L5', 'cash_out',
   'One-off Proxy Agent (Platform Sales Officer) fee, 2% of P, owed from the cycle-1 Cover Pool. cash_in credits the payable. Not taken from Welile 7%.'),
  ('platform', NULL, 'v360_platform_revenue', 'R1', 'cash_out',
   'Welile 7% of Gross on a 360-day cycle. cash_in credits the full 7%. A later cash_out of the tithe reduces it.'),
  ('platform', NULL, 'v360_tithe', 'L11', 'cash_out',
   'Tithe, 10% of Welile 7% only. cash_in credits the payable. It is not charged to the partner, the agent, or the Cover Pool.'),
  ('platform', NULL, 'v360_partner_capital', 'L2', 'cash_out',
   '360-day partner capital (the rent amount P). Cash-flow section is operating. Does not reclassify historical partner_funding.'),
  ('platform', NULL, 'v360_partner_margin', 'X2', 'cash_out',
   '360-day partner margin. Target 15% of P, not guaranteed. Cash-flow section is operating.'),
  ('platform', NULL, 'v360_agent_commission_sub', 'X3', 'cash_out',
   '360-day sub-agent commission, 6% of Gross. Current Rent Plans stay on agent_commission_earned.'),
  ('platform', NULL, 'v360_agent_commission_general', 'X3', 'cash_out',
   '360-day general agent commission, 2% of Gross.'),
  ('platform', NULL, 'v360_rail', 'X1', 'cash_out',
   '360-day rail, max(3500, 2.5% of P rounded up).'),
  ('platform', NULL, 'v360_landlord_principal', 'L4', 'cash_out',
   '360-day landlord principal. cash_in credits landlord payable.');

-- Extend the allowlist in place. Previous categories stay. Search path is restored.
DO $allow$
DECLARE
  v_src text;
  v_expr text;
  v_before text[];
  v_after text[];
  v_config text[];
  v_path text;
  v_new text[] := ARRAY[
    'v360_cover_pool',
    'v360_proxy_agent_commission',
    'v360_tithe',
    'v360_platform_revenue',
    'v360_partner_margin',
    'v360_partner_capital',
    'v360_agent_commission_sub',
    'v360_agent_commission_general',
    'v360_rail',
    'v360_landlord_principal'
  ];
BEGIN
  IF public.ledger_category_allowlist() && v_new THEN
    RAISE EXCEPTION 'a v360 economics category is already allowlisted; nothing was changed';
  END IF;
  SELECT prosrc, proconfig INTO v_src, v_config
  FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure;
  IF v_src IS NULL OR v_src !~* '^\s*select\s' OR v_src ~ '\$' THEN
    RAISE EXCEPTION 'ledger_category_allowlist() is not a single SELECT; nothing was changed';
  END IF;
  v_before := public.ledger_category_allowlist();
  v_expr := regexp_replace(regexp_replace(v_src, '^\s*select\s+', '', 'i'), ';\s*$', '');
  EXECUTE format(
    $f$CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
      RETURNS text[] LANGUAGE sql IMMUTABLE AS $body$
    SELECT (%s) || %L::text[];
    $body$$f$,
    v_expr,
    v_new
  );
  IF v_config IS NULL OR v_config[1] IS NULL OR v_config[1] NOT LIKE 'search_path=%' THEN
    RAISE EXCEPTION 'ledger_category_allowlist() has no search_path setting to preserve';
  END IF;
  SELECT string_agg(quote_literal(btrim(part)), ', ') INTO v_path
  FROM unnest(string_to_array(split_part(v_config[1], '=', 2), ',')) AS part;
  EXECUTE format('ALTER FUNCTION public.ledger_category_allowlist() SET search_path TO %s', v_path);
  v_after := public.ledger_category_allowlist();
  IF NOT (v_after @> v_before)
     OR cardinality(v_after) <> cardinality(v_before) + cardinality(v_new)
     OR NOT (v_after @> v_new) THEN
    RAISE EXCEPTION 'allowlist check failed: previous categories were not all preserved';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)
       IS DISTINCT FROM v_config
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION 'allowlist check failed: search_path or volatility was not preserved';
  END IF;
END
$allow$;

-- Cash-flow presentation. section = operating is the approved cf_section.
-- Existing L2 / partner_funding rows stay financing. These new categories do not.
INSERT INTO public.cash_flow_line_map
  (account_code, category, section, group_label, group_sort, line_label, line_sort, display_only, notes)
SELECT v.account_code, v.category, 'operating', v.group_label, v.group_sort, v.line_label, v.line_sort, false, v.notes
FROM (VALUES
  ('L2', 'v360_partner_capital', 'Partner Products and Services', 30, '360-day partner capital (operating)', 40,
   'Approved cf_section operating. Does not move historical partner capital out of financing.'),
  ('X2', 'v360_partner_margin', 'Partner Products and Services', 30, '360-day partner margin (target 15%, not guaranteed)', 12,
   'Approved cf_section operating.'),
  ('L10', 'v360_cover_pool', 'Tenant Products and Services', 10, '360-day Cover Pool movements', 80,
   'Segregated missed-day reserve.'),
  ('L5', 'v360_proxy_agent_commission', 'Agent Products and Services', 20, '360-day Proxy Agent fee from the Cover Pool', 16,
   'Paid from cycle-1 Cover Pool, not from Welile 7%.'),
  ('R1', 'v360_platform_revenue', 'Tenant Products and Services', 10, '360-day Welile 7% of Gross', 42,
   'Welile share before the tithe set-aside.'),
  ('L11', 'v360_tithe', 'Other Operating Activities', 60, '360-day tithe set aside from Welile 7%', 16,
   '10% of Welile 7% only.'),
  ('X3', 'v360_agent_commission_sub', 'Agent Products and Services', 20, '360-day sub-agent commission (6% of Gross)', 12,
   'v360 only. Current plans stay on the existing commission lines.'),
  ('X3', 'v360_agent_commission_general', 'Agent Products and Services', 20, '360-day general agent commission (2% of Gross)', 13,
   'v360 only.'),
  ('X1', 'v360_rail', 'Tenant Products and Services', 10, '360-day rail', 82,
   'max(3500, 2.5% of rent rounded up).'),
  ('L4', 'v360_landlord_principal', 'Landlord Products and Services', 40, '360-day landlord principal', 15,
   'Operating, with the other landlord settlements.')
) AS v(account_code, category, group_label, group_sort, line_label, line_sort, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.cash_flow_line_map m
  WHERE m.category = v.category AND m.line_label = v.line_label
);
