-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Option 2 phase 2 fixture (local copy only). Rows are inserted with triggers off (session_replication_role =
-- replica) because rent_requests carries ~40 unrelated guards (GPS, formula, photos). Every call UNDER TEST runs
-- with triggers on. All names and numbers are made up.
--
-- Partners: Grace A (11..), Brian B (33..). Tenant Musa (44..). Agent Peter (55..).
-- Landlords: Okello (verified, L1), Kato (not verified, L2).
-- Plans: R1..R10, UGX 500,000 each unless noted; R2 belongs to the unverified landlord.

\set ON_ERROR_STOP 1
SET client_min_messages = warning;
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'), ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'), ('55555555-5555-4555-8555-555555555555');
INSERT INTO public.profiles (id, full_name, email, phone) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Grace Partner', 'grace@example.test', '0700000001'),
  ('33333333-3333-4333-8333-333333333333', 'Brian Partner', 'brian@example.test', '0700000003'),
  ('44444444-4444-4444-8444-444444444444', 'Musa Tenant',   'musa@example.test',  '0700000004'),
  ('55555555-5555-4555-8555-555555555555', 'Peter Agent',   'peter@example.test', '0700000005');
-- One tenant per plan (a tenant who still owes on one plan cannot have another funded). Plan 1's tenant is Musa.
INSERT INTO auth.users (id)
SELECT ('44444444-4444-4444-8444-4444444444' || lpad(n::text, 2, '0'))::uuid FROM generate_series(2, 10) n;
INSERT INTO public.profiles (id, full_name, email, phone)
SELECT ('44444444-4444-4444-8444-4444444444' || lpad(n::text, 2, '0'))::uuid, 'Tenant ' || n, 'tenant' || n || '@example.test',
       '07000001' || lpad(n::text, 2, '0')
  FROM generate_series(2, 10) n;
INSERT INTO public.user_roles (user_id, role, enabled) VALUES
  ('11111111-1111-4111-8111-111111111111', 'supporter', true),
  ('33333333-3333-4333-8333-333333333333', 'supporter', true),
  ('55555555-5555-4555-8555-555555555555', 'agent', true);

-- Both partners signed their partnership agreement (no capital is deployed without one).
INSERT INTO public.supporter_agreement_acceptance (supporter_id, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'accepted'), ('33333333-3333-4333-8333-333333333333', 'accepted');

INSERT INTO public.landlords (id, name, phone, property_address, verified, verified_mobile_money_number) VALUES
  ('1a1a1a1a-0000-4000-8000-000000000001', 'Okello', '0772123456', 'Kireka', true, '+256 772 123456'),
  ('1a1a1a1a-0000-4000-8000-000000000002', 'Kato',   '0772999888', 'Bweyogerere', false, NULL);

INSERT INTO public.rent_requests (id, tenant_id, landlord_id, agent_id, rent_amount, duration_days, access_fee, request_fee,
                                  total_repayment, daily_repayment, status, tenancy_status, coo_reviewed_at, funder_visible)
SELECT ('a0a0a0a0-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       CASE WHEN n = 1 THEN '44444444-4444-4444-8444-444444444444'::uuid
            ELSE ('44444444-4444-4444-8444-4444444444' || lpad(n::text, 2, '0'))::uuid END,
       CASE WHEN n = 2 THEN '1a1a1a1a-0000-4000-8000-000000000002'::uuid ELSE '1a1a1a1a-0000-4000-8000-000000000001'::uuid END,
       '55555555-5555-4555-8555-555555555555', 500000, 30, 0, 0, 600000, 20000,
       'coo_approved', 'active', now() - interval '1 day', true
  FROM generate_series(1, 10) n;

-- A deposit whose TID a later proof re-uses (flag tid_used_before).
INSERT INTO public.deposit_requests (id, user_id, amount, transaction_id, status)
VALUES ('d0d0d0d0-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 100000, 'MP-3333-3333', 'approved');

-- Phases 2-7 test option 2 for every partner; phase8_test.sql turns the everyone-switch off to test the pilot list.
UPDATE public.pipeline_switches SET is_on = true WHERE key IN ('self_support_direct_pay', 'self_support_direct_pay_everyone');
SET LOCAL session_replication_role = origin;

-- Grace gets 50,000 operational float (balanced test credit, real ledger triggers).
SELECT public.create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', '11111111-1111-4111-8111-111111111111', 'amount', 50000, 'direction', 'cash_in',
    'category', 'partner_funding', 'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
    'source_table', 'test', 'description', 'fixture: operational float'),
  jsonb_build_object('amount', 50000, 'direction', 'cash_out', 'category', 'wallet_deposit', 'ledger_scope', 'platform',
    'source_table', 'test', 'description', 'fixture: cash received')), 'p2-fixture-float-grace');
COMMIT;
