-- 2026-11-04: Merchandise Receivables (A12 / A13) corrections. Production apply needs explicit CFO approval.
-- Source: CFO-reviewed 3 Nov 2026 merchandise schedule, re-verified read-only against production 2026-11-03 21:18 UTC.
-- ACCOUNTING ONLY: no wallet leg, no refund, no payment, no cash or order-status change; nothing existing is edited.
-- One new balanced group per item (key merch_a12_a13_correction_20261104:<plan>:<code>[:<collection group>]), each leg a category already mapped and
-- allowlisted, linked to the plan (source_id) and the evidence group (reference_id):
--   J1b  charge part of a collection credited in full to A12 -> DR A12 merchandise_recovery_repayment / CR R1 access_fee_collected
--   J7   charges (or the old bike access fee) booked as principal by the 22 Sep restatement -> DR E3 / CR A12|A13 opening
--   J5/J6 goods never delivered: remaining receivable only -> DR E3 / CR A12|A13 opening (cash already taken stays in E3,
--        shown as a possible refund for CFO decision; no refund liability is posted)
--   J2/J3 payout expensed instead of a receivable -> DR A12 smartphone_advance_receivable | A13 bike_recovery_repayment
--        / CR X1 equipment_expense (the reverse of cfo_cancel_bike_lease's legs)
-- NOT posted (needs a CFO decision; no evidenced counterpart): company stock issued with nothing posted for the issue.
-- The 82 historical smartphone recoveries were reclassified A10 -> A12/R1 by 20261103200000 and are NOT touched here.
-- The CFO "Money received" reports skip these groups (they move no money), as they skip the smartphone reclassification.
-- Preflight refuses (nothing changed) unless every evidence group and item state is exactly as verified.
-- Rollback: supabase/rollbacks/20261104090000_merchandise_a12_a13_corrections.rollback.sql (report functions only; correction entries stay - append-only).
-- Dry run (read-only): supabase/tests/merchandise_a12_a13_corrections_dryrun.sql. Tests: src/test/merchandiseA12A13Corrections.test.ts.
-- TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.create_ledger_transaction(jsonb, text, boolean)')) IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.sofp_ledger_legs(timestamp with time zone)')) IS DISTINCT FROM '843ccf477014f8c7a8e0b5c6f14a1ba0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.ledger_category_allowlist()')) IS DISTINCT FROM 'd1b408552ac7f96bb3b84a286261c7fd'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_totals(date, date)')) IS DISTINCT FROM 'ba864905b5bc7ff9165d47f9c946432a'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)')) IS DISTINCT FROM '6e69a2f7eacc80fa6d87ae4d18a8f5a5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_agent_products_breakdown(date, date)')) IS DISTINCT FROM 'c79bcf09662300dc96ac2f89f5880179' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - a function differs from production 2026-11-04';
  END IF;
  IF (SELECT count(*) FROM public.ledger_account_map m WHERE m.wallet_bucket IS NULL AND (m.ledger_scope, m.category, m.account_code, m.debit_when) IN (
        ('platform', 'receivable_restatement_equity', 'E3', 'cash_in'),
        ('bridge', 'merchandise_recovery_receivable_opening', 'A12', 'cash_in'),
        ('bridge', 'bike_recovery_receivable_opening', 'A13', 'cash_in'),
        ('platform', 'merchandise_recovery_repayment', 'A12', 'cash_out'),
        ('platform', 'bike_recovery_repayment', 'A13', 'cash_out'),
        ('platform', 'smartphone_advance_receivable', 'A12', 'cash_out'),
        ('platform', 'equipment_expense', 'X1', 'cash_out'),
        ('platform', 'access_fee_collected', 'R1', 'cash_out'))) <> 8
     OR EXISTS (SELECT 1 FROM public.ledger_account_map m WHERE m.wallet_bucket IS NOT NULL AND m.category IN ('receivable_restatement_equity', 'merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'merchandise_recovery_repayment', 'bike_recovery_repayment', 'smartphone_advance_receivable', 'equipment_expense', 'access_fee_collected'))
     OR NOT (public.ledger_category_allowlist() @> ARRAY['receivable_restatement_equity', 'merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'merchandise_recovery_repayment', 'bike_recovery_repayment', 'smartphone_advance_receivable', 'equipment_expense', 'access_fee_collected']) THEN
    RAISE EXCEPTION 'merchandise correction: ledger_account_map / allowlist not as expected';
  END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger WHERE left(COALESCE(idempotency_key, ''), 34) = 'merch_a12_a13_correction_20261104:') THEN
    RAISE EXCEPTION 'merchandise correction: already applied';
  END IF;
  IF (SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('ad7f535c-30fe-454a-a834-8e5be5ac58fb'::uuid, 'a8db01e9-02f2-4e4d-95bd-c5be59701b05'::uuid) OR reference_id IN ('ad7f535c-30fe-454a-a834-8e5be5ac58fb', 'a8db01e9-02f2-4e4d-95bd-c5be59701b05'))) IS DISTINCT FROM '40153b06-713a-4b09-8588-769053c5317e'
     OR (SELECT order_status FROM public.merchandise_sales WHERE id = 'a8db01e9-02f2-4e4d-95bd-c5be59701b05') IS DISTINCT FROM 'pending_approval' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for ad7f535c J6';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = '461e2615-3e16-4cbf-8eeb-d4aa173851dc' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = '6d9d3a96-05f3-4bf1-a231-e04c352e0a40') IS DISTINCT FROM 85801
     OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = '6d9d3a96-05f3-4bf1-a231-e04c352e0a40' AND category = 'merchandise_recovery_receivable_opening') <> 1
     OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = '3bc99bf6-1a37-47f5-a185-4aedf49ddbad') IS DISTINCT FROM 55000 THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 6d9d3a96 J7';
  END IF;
  IF (SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '1c0aae02-cd3c-48b6-a414-f5a1a308084b' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 10000 AND source_id = 'aec3dd25-002e-4af7-8105-f9c596c81583') <> 1
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '1c0aae02-cd3c-48b6-a414-f5a1a308084b' AND category = 'access_fee_collected')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '1c0aae02-cd3c-48b6-a414-f5a1a308084b')
     OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = 'aec3dd25-002e-4af7-8105-f9c596c81583') IS DISTINCT FROM 156200
     OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = 'aec3dd25-002e-4af7-8105-f9c596c81583') IS DISTINCT FROM '2026-09-24'
     OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4cf491c5-21b0-4366-9369-7a210b431013') IS DISTINCT FROM '156200/2' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for aec3dd25 J1b';
  END IF;
  IF (SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '31d8fbc4-0fb3-487d-90d1-0c98359f5cf9' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 716 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '31d8fbc4-0fb3-487d-90d1-0c98359f5cf9' AND category = 'access_fee_collected')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '31d8fbc4-0fb3-487d-90d1-0c98359f5cf9')
     OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
     OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
     OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 8c845dc0 J1b';
  END IF;
  IF (SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '553e8bd5-ea79-422c-88a4-fb8623f6f378' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 716 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '553e8bd5-ea79-422c-88a4-fb8623f6f378' AND category = 'access_fee_collected')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '553e8bd5-ea79-422c-88a4-fb8623f6f378')
     OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
     OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
     OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 8c845dc0 J1b';
  END IF;
  IF (SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '6ed2036d-d2c3-4766-9950-7bb0cbf8af9c' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 716 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '6ed2036d-d2c3-4766-9950-7bb0cbf8af9c' AND category = 'access_fee_collected')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '6ed2036d-d2c3-4766-9950-7bb0cbf8af9c')
     OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
     OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
     OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 8c845dc0 J1b';
  END IF;
  IF (SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '0a0e9648-75be-495f-b267-ffd18f32586e' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 316 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '0a0e9648-75be-495f-b267-ffd18f32586e' AND category = 'access_fee_collected')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '0a0e9648-75be-495f-b267-ffd18f32586e')
     OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
     OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
     OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 8c845dc0 J1b';
  END IF;
  IF (SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 600 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964' AND category = 'access_fee_collected')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964')
     OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
     OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
     OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 8c845dc0 J1b';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'cf004e45-e7de-4b6b-92cd-40c3c2c9dc19' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
     OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab' AND category = 'merchandise_recovery_receivable_opening') <> 1
     OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM 35000 THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 8c845dc0 J7';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'bdd9ba3d-4430-4a94-a18c-9601cef90d2f' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = 'ed33ae8b-c9e2-4eea-ae80-46c726830107') IS DISTINCT FROM 78001
     OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = 'ed33ae8b-c9e2-4eea-ae80-46c726830107' AND category = 'merchandise_recovery_receivable_opening') <> 1
     OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = 'c70edae6-f131-4304-98d1-36af8d0e8680') IS DISTINCT FROM 50000 THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for ed33ae8b J7';
  END IF;
  IF (SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('48c09a3f-b128-4671-8e01-8a9a88af429f'::uuid, 'bf923bdc-27a6-4a13-b1f0-f54dca6e5355'::uuid) OR reference_id IN ('48c09a3f-b128-4671-8e01-8a9a88af429f', 'bf923bdc-27a6-4a13-b1f0-f54dca6e5355'))) IS DISTINCT FROM 'c23a68a4-2056-4301-a9d7-781d8c0054d9'
     OR (SELECT order_status FROM public.merchandise_sales WHERE id = 'bf923bdc-27a6-4a13-b1f0-f54dca6e5355') IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 48c09a3f J5';
  END IF;
  IF (SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('08f711e2-927a-43dd-bce0-73831c4dd16a'::uuid, 'dddc2333-efb2-4855-9ab7-f3d5c3793873'::uuid) OR reference_id IN ('08f711e2-927a-43dd-bce0-73831c4dd16a', 'dddc2333-efb2-4855-9ab7-f3d5c3793873'))) IS DISTINCT FROM '363d3c7e-8383-47c6-8a37-eefba64bcde5,3c3bbd25-f18b-4c6d-9b08-7a7174bfb685,45350348-c291-49d1-82ed-6abfddf193f9,559cb590-9d29-486c-bdf7-044dad0698bc,638fa018-b433-4d6d-87cb-758ffe667f14,64b3d9c2-882c-40e0-918f-51cbc08cb2ad,64e05571-8428-45aa-9fd7-14023861c88a,87ce086f-d205-47c5-8ab4-fedb0e9149ed,a08feb5b-df7e-4b29-88dc-f195476e1eec,cec2fc54-b8e7-4181-9ddf-f60f89b86af6,d2fa50c7-dc6f-4e99-a543-438a663ee01e,d678e01a-55d4-4b1f-b326-2d64c7ca48e0,ebd60b55-fd44-4e67-893d-2b108613be06,fa6d7234-bfda-467e-843b-6b010ae07f4b'
     OR (SELECT order_status FROM public.merchandise_sales WHERE id = 'dddc2333-efb2-4855-9ab7-f3d5c3793873') IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 08f711e2 J5';
  END IF;
  IF (SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0'::uuid, '54c4c664-6004-4aab-a56c-b285050633cd'::uuid) OR reference_id IN ('9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0', '54c4c664-6004-4aab-a56c-b285050633cd'))) IS DISTINCT FROM '58019236-67f8-4701-a2a7-2a09307034e3,6286223b-54b7-4625-bb18-02445328278c'
     OR (SELECT order_status FROM public.merchandise_sales WHERE id = '54c4c664-6004-4aab-a56c-b285050633cd') IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 9be1f0c5 J5';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = '47e2056e-e27a-4831-95d6-983ec3e58229' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = '85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297') IS DISTINCT FROM 70200
     OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = '85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297' AND category = 'merchandise_recovery_receivable_opening') <> 1
     OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = '6681828a-7449-4af0-9e71-972d8ba54a98') IS DISTINCT FROM 45000 THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 85a8a9c0 J7';
  END IF;
  IF (SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('fdb05fd5-e17c-49b6-a1f9-dd1d238edb85'::uuid, '3a82618b-7d49-4015-ad72-7a1e06dbb5ab'::uuid) OR reference_id IN ('fdb05fd5-e17c-49b6-a1f9-dd1d238edb85', '3a82618b-7d49-4015-ad72-7a1e06dbb5ab'))) IS DISTINCT FROM '13b424d1-cd40-4511-b49c-ba55109036d2,42890207-99e5-47e4-8ec0-67c17b17ef0c,50dd123f-1881-4c4a-87ed-cf8ade764cad,704ea639-a2c6-467f-9ed9-c2397fc3f288,715b39e2-571f-4bef-8241-b967ccc442b4,7956e554-5e59-43ad-adc4-e8e5e0ac728e,929957f8-fc53-431e-98d2-1a1bab0ee644,9f890350-4e57-44e0-a611-ab5a7e4ecb67,9feb412c-d89b-4429-955c-76102c3c1544,a06a3292-c0be-4d7d-9621-034e24e6313c,aa97b0fc-3f33-4525-b8c9-09c252139145,b4462f82-b723-41d1-bf57-238b290bf615,ba2d87dc-a13c-4cbd-b9dd-1b869e590214,c5bf9a39-fea0-403e-a575-66595d3a3092,dded5e1b-49cf-43d0-a2fe-cadc6f217015,e78dbd42-5830-4416-b3b3-37ec08a866ca'
     OR (SELECT order_status FROM public.merchandise_sales WHERE id = '3a82618b-7d49-4015-ad72-7a1e06dbb5ab') IS DISTINCT FROM 'pending_approval' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for fdb05fd5 J6';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'c9e2f448-7523-4df7-9018-1af7783f9893' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = 'c75a2acc-6dcf-47ba-bce3-2213bfb40ad1') IS DISTINCT FROM 257400
     OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = 'c75a2acc-6dcf-47ba-bce3-2213bfb40ad1' AND category = 'merchandise_recovery_receivable_opening') <> 1
     OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = '9b704619-2d97-44cb-a61e-5ba7ac6525f6') IS DISTINCT FROM 165000 THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for c75a2acc J7';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = '8905a91c-f154-4754-84a2-5f46b04f37e6' AND ledger_scope = 'platform' AND category = 'equipment_expense' AND direction = 'cash_out' AND source_id = '27842d46-9467-4852-853e-c4100fbbc516') IS DISTINCT FROM 145000
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE (source_id IN ('71570ebd-b43a-4dd6-8f96-e7b0ab982475'::uuid, '27842d46-9467-4852-853e-c4100fbbc516'::uuid) OR reference_id IN ('71570ebd-b43a-4dd6-8f96-e7b0ab982475', '27842d46-9467-4852-853e-c4100fbbc516')) AND category IN ('merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'smartphone_advance_receivable'))
     OR (SELECT order_status FROM public.merchandise_sales WHERE id = '27842d46-9467-4852-853e-c4100fbbc516') IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 71570ebd J3';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'bbfbff6a-3cb9-4af4-af84-cd6179ef04aa' AND ledger_scope = 'platform' AND category = 'equipment_expense' AND direction = 'cash_out' AND source_id = '893e5dde-cad2-4745-a607-5b94d9e087a4') IS DISTINCT FROM 650000
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE (source_id IN ('16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb'::uuid, '893e5dde-cad2-4745-a607-5b94d9e087a4'::uuid) OR reference_id IN ('16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb', '893e5dde-cad2-4745-a607-5b94d9e087a4')) AND category IN ('merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'smartphone_advance_receivable'))
     OR (SELECT order_status FROM public.merchandise_sales WHERE id = '893e5dde-cad2-4745-a607-5b94d9e087a4') IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 16a47f1c J2';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'e946ce59-bcd3-4af1-9807-70cf41cfe94d' AND ledger_scope = 'platform' AND category = 'equipment_expense' AND direction = 'cash_out' AND source_id = '97534451-ca4e-42e1-9f49-d45fd44031f9') IS DISTINCT FROM 75000
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE (source_id IN ('d8bbd824-7a74-4f79-acdb-3ef542558cfc'::uuid, '97534451-ca4e-42e1-9f49-d45fd44031f9'::uuid) OR reference_id IN ('d8bbd824-7a74-4f79-acdb-3ef542558cfc', '97534451-ca4e-42e1-9f49-d45fd44031f9')) AND category IN ('merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'smartphone_advance_receivable'))
     OR (SELECT order_status FROM public.merchandise_sales WHERE id = '97534451-ca4e-42e1-9f49-d45fd44031f9') IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for d8bbd824 J2';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'f44c69ed-a61e-4754-b014-9180dc44d18e' AND ledger_scope = 'platform' AND category = 'equipment_expense' AND direction = 'cash_out' AND source_id = '136b32fb-5b28-496d-96d4-ba2eb3b9f8bb') IS DISTINCT FROM 500000
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE (source_id IN ('a238c808-c566-473d-8094-4b25731c021a'::uuid, '136b32fb-5b28-496d-96d4-ba2eb3b9f8bb'::uuid) OR reference_id IN ('a238c808-c566-473d-8094-4b25731c021a', '136b32fb-5b28-496d-96d4-ba2eb3b9f8bb')) AND category IN ('merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'smartphone_advance_receivable'))
     OR (SELECT order_status FROM public.merchandise_sales WHERE id = '136b32fb-5b28-496d-96d4-ba2eb3b9f8bb') IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for a238c808 J2';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = '7be1c065-8577-43cd-abda-d2d07697df4f' AND ledger_scope = 'bridge' AND category = 'bike_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9') IS DISTINCT FROM 710000
     OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9' AND category = 'bike_recovery_receivable_opening') <> 1
     OR (SELECT principal_total FROM public.merchandise_recovery_plans WHERE id = 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9') IS DISTINCT FROM 500000 THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for bfe58c27 J7';
  END IF;
  IF (SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = 'e74fdaa4-7f79-42ba-b1e4-26c5c648942f' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 216 AND source_id = '673c0f25-1ec1-4824-aed9-f4e8c18db472') <> 1
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = 'e74fdaa4-7f79-42ba-b1e4-26c5c648942f' AND category = 'access_fee_collected')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = 'e74fdaa4-7f79-42ba-b1e4-26c5c648942f')
     OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '673c0f25-1ec1-4824-aed9-f4e8c18db472') IS DISTINCT FROM 1386004
     OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '673c0f25-1ec1-4824-aed9-f4e8c18db472') IS DISTINCT FROM '2026-10-13'
     OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '3d11c494-31b9-468a-a638-24921a83a0b5') IS DISTINCT FROM '1386004/6' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 673c0f25 J1b';
  END IF;
  IF (SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'c1597078-16c5-41f2-9bde-5dd7fcd8ff64' AND ledger_scope = 'bridge' AND category = 'bike_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = '93d95269-34da-45f0-9845-fff6b7312220') IS DISTINCT FROM 710000
     OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = '93d95269-34da-45f0-9845-fff6b7312220' AND category = 'bike_recovery_receivable_opening') <> 1
     OR (SELECT principal_total FROM public.merchandise_recovery_plans WHERE id = '93d95269-34da-45f0-9845-fff6b7312220') IS DISTINCT FROM 500000 THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 93d95269 J7';
  END IF;
  IF (SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = 'c349303f-3e74-47f1-bffe-0ebca15edcc2' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 639 AND source_id = '973c6ecb-3c1a-4f3d-8471-106fc460aec7') <> 1
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = 'c349303f-3e74-47f1-bffe-0ebca15edcc2' AND category = 'access_fee_collected')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = 'c349303f-3e74-47f1-bffe-0ebca15edcc2')
     OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '973c6ecb-3c1a-4f3d-8471-106fc460aec7') IS DISTINCT FROM 1482001
     OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '973c6ecb-3c1a-4f3d-8471-106fc460aec7') IS DISTINCT FROM '2026-10-26'
     OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = 'c60db3db-334d-453e-89b8-aa1557535778') IS DISTINCT FROM '1482001/3' THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 973c6ecb J1b';
  END IF;
  IF (SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('2edc40be-671b-4b1f-a00e-cb0e71b08482'::uuid) OR reference_id IN ('2edc40be-671b-4b1f-a00e-cb0e71b08482'))) IS DISTINCT FROM 'e331dd0a-4f23-47a3-a144-1609ac1be143'
     OR EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = '2edc40be-671b-4b1f-a00e-cb0e71b08482') THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for 2edc40be J5';
  END IF;
  IF (SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('bc2acdbe-8e2c-4c90-aab4-5e922bf50c93'::uuid) OR reference_id IN ('bc2acdbe-8e2c-4c90-aab4-5e922bf50c93'))) IS DISTINCT FROM 'f58ca836-4720-4f41-913a-72a3eccb110d'
     OR EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = 'bc2acdbe-8e2c-4c90-aab4-5e922bf50c93') THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for bc2acdbe J5';
  END IF;
  IF (SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('c95555c7-6363-4f09-b7c4-220a272db6ab'::uuid) OR reference_id IN ('c95555c7-6363-4f09-b7c4-220a272db6ab'))) IS DISTINCT FROM '1f8e69d7-f976-456b-ab69-95888a063f45'
     OR EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = 'c95555c7-6363-4f09-b7c4-220a272db6ab') THEN
    RAISE EXCEPTION 'merchandise correction: preflight refused - evidence or state changed for c95555c7 J5';
  END IF;
END $pre$;

-- ---------------------------------------------------------------- CFO Money received reports: skip these corrections
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

CREATE OR REPLACE FUNCTION public.get_cfo_received_agent_products_breakdown(p_from date, p_to date)
 RETURNS TABLE(product_key text, product_label text, amount numeric, tx_count bigint)
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
  WITH x AS (
    SELECT g.amount,
      public._cfo_received_agent_product_for(g.category, g.source_table, mp.is_bike_lease) AS k
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp
      ON g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND left(COALESCE(g.idempotency_key, ''), 30) <> 'smartphone_a10_to_a12_reclass:' -- 2026-11-03: not money received (reclassification)
      AND left(COALESCE(g.idempotency_key, ''), 34) <> 'merch_a12_a13_correction_20261104:' -- 2026-11-04: not money received (merchandise correction)
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND public._cfo_received_category_for(g.category) = 'agent'
  )
  SELECT x.k,
    CASE x.k WHEN 'smartphone' THEN 'Smartphone recoveries' WHEN 'bike' THEN 'Bike recoveries'
             WHEN 'rejection' THEN 'Rejection charges' ELSE 'Agent advance repayments' END,
    round(sum(x.amount), 2), count(*)
  FROM x GROUP BY x.k ORDER BY 3 DESC;
END $function$;

-- ---------------------------------------------------------------- corrections (append-only)
DO $post$
BEGIN
  -- J6 Jumper white (CHEMUTAI ELISHA): order pending_approval: goods never delivered (no approval/disbursement/handover); clear the remaining receivable opened by group 40153b06-713a-4b09-8588-769053c5317e
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 65000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "ad7f535c-30fe-454a-a834-8e5be5ac58fb", "reference_id": "40153b06-713a-4b09-8588-769053c5317e", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Jumper white (CHEMUTAI ELISHA)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "merchandise_recovery_receivable_opening", "amount": 65000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "ad7f535c-30fe-454a-a834-8e5be5ac58fb", "reference_id": "40153b06-713a-4b09-8588-769053c5317e", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Jumper white (CHEMUTAI ELISHA)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:ad7f535c-30fe-454a-a834-8e5be5ac58fb:DEREC');
  -- J7 Press Jacket (semyalo benon): 22 Sep restatement (group 461e2615-3e16-4cbf-8eeb-d4aa173851dc) opened 85,801 but the principal is 55,000; 30,801 is future charges, not receivable principal
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 30801, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "6d9d3a96-05f3-4bf1-a231-e04c352e0a40", "reference_id": "461e2615-3e16-4cbf-8eeb-d4aa173851dc", "description": "Correction 2026-11-04: reverse charges booked as principal by the 2026-09-22 restatement - Press Jacket (semyalo benon)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "merchandise_recovery_receivable_opening", "amount": 30801, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "6d9d3a96-05f3-4bf1-a231-e04c352e0a40", "reference_id": "461e2615-3e16-4cbf-8eeb-d4aa173851dc", "description": "Correction 2026-11-04: receivable reduced to principal 55,000 (charges 30,801 removed) - Press Jacket (semyalo benon)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:6d9d3a96-05f3-4bf1-a231-e04c352e0a40:J7');
  -- J1b Press Jacket (Barasa Emmanuel joan): collection of 10,000 on 2026-10-08 (group 1c0aae02-cd3c-48b6-a414-f5a1a308084b) was credited in full to A12; its charge part 3,590 (stored schedule) is revenue
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "merchandise_recovery_repayment", "amount": 3590, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "aec3dd25-002e-4af7-8105-f9c596c81583", "reference_id": "1c0aae02-cd3c-48b6-a414-f5a1a308084b", "description": "Correction 2026-11-04 (CFO-approved schedule): charge part of collection 1c0aae02-cd3c-48b6-a414-f5a1a308084b moved from A12 principal to R1 - Press Jacket (Barasa Emmanuel joan)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "access_fee_collected", "amount": 3590, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "aec3dd25-002e-4af7-8105-f9c596c81583", "reference_id": "1c0aae02-cd3c-48b6-a414-f5a1a308084b", "description": "Correction 2026-11-04 (CFO-approved schedule): monthly charge in collection 1c0aae02-cd3c-48b6-a414-f5a1a308084b recognised - Press Jacket (Barasa Emmanuel joan)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:aec3dd25-002e-4af7-8105-f9c596c81583:J1B:1c0aae02-cd3c-48b6-a414-f5a1a308084b');
  -- J1b Welile Polo (semyalo benon): collection of 716 on 2026-09-23 (group 31d8fbc4-0fb3-487d-90d1-0c98359f5cf9) was credited in full to A12; its charge part 327 (stored schedule) is revenue
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "merchandise_recovery_repayment", "amount": 327, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "31d8fbc4-0fb3-487d-90d1-0c98359f5cf9", "description": "Correction 2026-11-04 (CFO-approved schedule): charge part of collection 31d8fbc4-0fb3-487d-90d1-0c98359f5cf9 moved from A12 principal to R1 - Welile Polo (semyalo benon)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "access_fee_collected", "amount": 327, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "31d8fbc4-0fb3-487d-90d1-0c98359f5cf9", "description": "Correction 2026-11-04 (CFO-approved schedule): monthly charge in collection 31d8fbc4-0fb3-487d-90d1-0c98359f5cf9 recognised - Welile Polo (semyalo benon)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:31d8fbc4-0fb3-487d-90d1-0c98359f5cf9');
  -- J1b Welile Polo (semyalo benon): collection of 716 on 2026-09-24 (group 553e8bd5-ea79-422c-88a4-fb8623f6f378) was credited in full to A12; its charge part 327 (stored schedule) is revenue
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "merchandise_recovery_repayment", "amount": 327, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "553e8bd5-ea79-422c-88a4-fb8623f6f378", "description": "Correction 2026-11-04 (CFO-approved schedule): charge part of collection 553e8bd5-ea79-422c-88a4-fb8623f6f378 moved from A12 principal to R1 - Welile Polo (semyalo benon)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "access_fee_collected", "amount": 327, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "553e8bd5-ea79-422c-88a4-fb8623f6f378", "description": "Correction 2026-11-04 (CFO-approved schedule): monthly charge in collection 553e8bd5-ea79-422c-88a4-fb8623f6f378 recognised - Welile Polo (semyalo benon)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:553e8bd5-ea79-422c-88a4-fb8623f6f378');
  -- J1b Welile Polo (semyalo benon): collection of 716 on 2026-09-25 (group 6ed2036d-d2c3-4766-9950-7bb0cbf8af9c) was credited in full to A12; its charge part 327 (stored schedule) is revenue
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "merchandise_recovery_repayment", "amount": 327, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "6ed2036d-d2c3-4766-9950-7bb0cbf8af9c", "description": "Correction 2026-11-04 (CFO-approved schedule): charge part of collection 6ed2036d-d2c3-4766-9950-7bb0cbf8af9c moved from A12 principal to R1 - Welile Polo (semyalo benon)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "access_fee_collected", "amount": 327, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "6ed2036d-d2c3-4766-9950-7bb0cbf8af9c", "description": "Correction 2026-11-04 (CFO-approved schedule): monthly charge in collection 6ed2036d-d2c3-4766-9950-7bb0cbf8af9c recognised - Welile Polo (semyalo benon)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:6ed2036d-d2c3-4766-9950-7bb0cbf8af9c');
  -- J1b Welile Polo (semyalo benon): collection of 316 on 2026-09-29 (group 0a0e9648-75be-495f-b267-ffd18f32586e) was credited in full to A12; its charge part 144 (stored schedule) is revenue
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "merchandise_recovery_repayment", "amount": 144, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "0a0e9648-75be-495f-b267-ffd18f32586e", "description": "Correction 2026-11-04 (CFO-approved schedule): charge part of collection 0a0e9648-75be-495f-b267-ffd18f32586e moved from A12 principal to R1 - Welile Polo (semyalo benon)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "access_fee_collected", "amount": 144, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "0a0e9648-75be-495f-b267-ffd18f32586e", "description": "Correction 2026-11-04 (CFO-approved schedule): monthly charge in collection 0a0e9648-75be-495f-b267-ffd18f32586e recognised - Welile Polo (semyalo benon)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:0a0e9648-75be-495f-b267-ffd18f32586e');
  -- J1b Welile Polo (semyalo benon): collection of 600 on 2026-10-02 (group 1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964) was credited in full to A12; its charge part 274 (stored schedule) is revenue
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "merchandise_recovery_repayment", "amount": 274, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964", "description": "Correction 2026-11-04 (CFO-approved schedule): charge part of collection 1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964 moved from A12 principal to R1 - Welile Polo (semyalo benon)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "access_fee_collected", "amount": 274, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964", "description": "Correction 2026-11-04 (CFO-approved schedule): monthly charge in collection 1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964 recognised - Welile Polo (semyalo benon)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964');
  -- J7 Welile Polo (semyalo benon): 22 Sep restatement (group cf004e45-e7de-4b6b-92cd-40c3c2c9dc19) opened 54,601 but the principal is 35,000; 19,601 is future charges, not receivable principal
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 19601, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "cf004e45-e7de-4b6b-92cd-40c3c2c9dc19", "description": "Correction 2026-11-04: reverse charges booked as principal by the 2026-09-22 restatement - Welile Polo (semyalo benon)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "merchandise_recovery_receivable_opening", "amount": 19601, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "8c845dc0-e644-4f86-ab36-614d62d561ab", "reference_id": "cf004e45-e7de-4b6b-92cd-40c3c2c9dc19", "description": "Correction 2026-11-04: receivable reduced to principal 35,000 (charges 19,601 removed) - Welile Polo (semyalo benon)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J7');
  -- J7 signages (Okwakol Micheal): 22 Sep restatement (group bdd9ba3d-4430-4a94-a18c-9601cef90d2f) opened 78,001 but the principal is 50,000; 28,001 is future charges, not receivable principal
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 28001, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "ed33ae8b-c9e2-4eea-ae80-46c726830107", "reference_id": "bdd9ba3d-4430-4a94-a18c-9601cef90d2f", "description": "Correction 2026-11-04: reverse charges booked as principal by the 2026-09-22 restatement - signages (Okwakol Micheal)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "merchandise_recovery_receivable_opening", "amount": 28001, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "ed33ae8b-c9e2-4eea-ae80-46c726830107", "reference_id": "bdd9ba3d-4430-4a94-a18c-9601cef90d2f", "description": "Correction 2026-11-04: receivable reduced to principal 50,000 (charges 28,001 removed) - signages (Okwakol Micheal)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:ed33ae8b-c9e2-4eea-ae80-46c726830107:J7');
  -- J5 Welile Spiro Bike (Nakato oliver): order rejected: goods never delivered (no approval/disbursement/handover); clear the remaining receivable opened by group c23a68a4-2056-4301-a9d7-781d8c0054d9
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 192850, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "48c09a3f-b128-4671-8e01-8a9a88af429f", "reference_id": "c23a68a4-2056-4301-a9d7-781d8c0054d9", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Welile Spiro Bike (Nakato oliver)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "bike_recovery_receivable_opening", "amount": 192850, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "48c09a3f-b128-4671-8e01-8a9a88af429f", "reference_id": "c23a68a4-2056-4301-a9d7-781d8c0054d9", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Welile Spiro Bike (Nakato oliver)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:48c09a3f-b128-4671-8e01-8a9a88af429f:DEREC');
  -- J5 Welile Spiro Bike (Martin lukwago): order rejected: goods never delivered (no approval/disbursement/handover); clear the remaining receivable opened by group d678e01a-55d4-4b1f-b326-2d64c7ca48e0
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 10549, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "08f711e2-927a-43dd-bce0-73831c4dd16a", "reference_id": "d678e01a-55d4-4b1f-b326-2d64c7ca48e0", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Welile Spiro Bike (Martin lukwago)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "bike_recovery_receivable_opening", "amount": 10549, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "08f711e2-927a-43dd-bce0-73831c4dd16a", "reference_id": "d678e01a-55d4-4b1f-b326-2d64c7ca48e0", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Welile Spiro Bike (Martin lukwago)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:08f711e2-927a-43dd-bce0-73831c4dd16a:DEREC');
  -- J5 Welile Spiro Bike (walimbwa peter): order rejected: goods never delivered (no approval/disbursement/handover); clear the remaining receivable opened by group 6286223b-54b7-4625-bb18-02445328278c
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 664896.52, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0", "reference_id": "6286223b-54b7-4625-bb18-02445328278c", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Welile Spiro Bike (walimbwa peter)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "bike_recovery_receivable_opening", "amount": 664896.52, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0", "reference_id": "6286223b-54b7-4625-bb18-02445328278c", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Welile Spiro Bike (walimbwa peter)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0:DEREC');
  -- J7 Company Ids (semyalo benon): 22 Sep restatement (group 47e2056e-e27a-4831-95d6-983ec3e58229) opened 70,200 but the principal is 45,000; 25,200 is future charges, not receivable principal
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 25200, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297", "reference_id": "47e2056e-e27a-4831-95d6-983ec3e58229", "description": "Correction 2026-11-04: reverse charges booked as principal by the 2026-09-22 restatement - Company Ids (semyalo benon)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "merchandise_recovery_receivable_opening", "amount": 25200, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297", "reference_id": "47e2056e-e27a-4831-95d6-983ec3e58229", "description": "Correction 2026-11-04: receivable reduced to principal 45,000 (charges 25,200 removed) - Company Ids (semyalo benon)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297:J7');
  -- J6 Press Jacket (EMMANUEL WASWA SSESANGA): order pending_approval: goods never delivered (no approval/disbursement/handover); clear the remaining receivable opened by group 715b39e2-571f-4bef-8241-b967ccc442b4
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 35471, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "fdb05fd5-e17c-49b6-a1f9-dd1d238edb85", "reference_id": "715b39e2-571f-4bef-8241-b967ccc442b4", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Press Jacket (EMMANUEL WASWA SSESANGA)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "merchandise_recovery_receivable_opening", "amount": 35471, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "fdb05fd5-e17c-49b6-a1f9-dd1d238edb85", "reference_id": "715b39e2-571f-4bef-8241-b967ccc442b4", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - Press Jacket (EMMANUEL WASWA SSESANGA)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:fdb05fd5-e17c-49b6-a1f9-dd1d238edb85:DEREC');
  -- J7 Welile Smartphone (Kayongo Joel): 22 Sep restatement (group c9e2f448-7523-4df7-9018-1af7783f9893) opened 257,400 but the principal is 165,000; 92,400 is future charges, not receivable principal
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 92400, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "c75a2acc-6dcf-47ba-bce3-2213bfb40ad1", "reference_id": "c9e2f448-7523-4df7-9018-1af7783f9893", "description": "Correction 2026-11-04: reverse charges booked as principal by the 2026-09-22 restatement - Welile Smartphone (Kayongo Joel)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "merchandise_recovery_receivable_opening", "amount": 92400, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "c75a2acc-6dcf-47ba-bce3-2213bfb40ad1", "reference_id": "c9e2f448-7523-4df7-9018-1af7783f9893", "description": "Correction 2026-11-04: receivable reduced to principal 165,000 (charges 92,400 removed) - Welile Smartphone (Kayongo Joel)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:c75a2acc-6dcf-47ba-bce3-2213bfb40ad1:J7');
  -- J3 Welile Spiro Bike (Abraham Chelimo): CFO payout 145,000 (group 8905a91c-f154-4754-84a2-5f46b04f37e6) was booked DR X1 equipment expense; the customer owes it under the plan and no receivable was opened
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "bike_recovery_repayment", "amount": 145000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "71570ebd-b43a-4dd6-8f96-e7b0ab982475", "reference_id": "8905a91c-f154-4754-84a2-5f46b04f37e6", "description": "Correction 2026-11-04: recognise receivable for the payout in group 8905a91c-f154-4754-84a2-5f46b04f37e6 - Welile Spiro Bike (Abraham Chelimo)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "equipment_expense", "amount": 145000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "71570ebd-b43a-4dd6-8f96-e7b0ab982475", "reference_id": "8905a91c-f154-4754-84a2-5f46b04f37e6", "description": "Correction 2026-11-04: reverse the payout expense in group 8905a91c-f154-4754-84a2-5f46b04f37e6 (now a receivable) - Welile Spiro Bike (Abraham Chelimo)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:71570ebd-b43a-4dd6-8f96-e7b0ab982475:MISSING');
  -- J2 waiting chair (FRED MUWANGUZI): CFO payout 650,000 (group bbfbff6a-3cb9-4af4-af84-cd6179ef04aa) was booked DR X1 equipment expense; the customer owes it under the plan and no receivable was opened
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "smartphone_advance_receivable", "amount": 650000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb", "reference_id": "bbfbff6a-3cb9-4af4-af84-cd6179ef04aa", "description": "Correction 2026-11-04: recognise receivable for the payout in group bbfbff6a-3cb9-4af4-af84-cd6179ef04aa - waiting chair (FRED MUWANGUZI)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "equipment_expense", "amount": 650000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb", "reference_id": "bbfbff6a-3cb9-4af4-af84-cd6179ef04aa", "description": "Correction 2026-11-04: reverse the payout expense in group bbfbff6a-3cb9-4af4-af84-cd6179ef04aa (now a receivable) - waiting chair (FRED MUWANGUZI)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb:MISSING');
  -- J2 Audrey chair (FRED MUWANGUZI): CFO payout 75,000 (group e946ce59-bcd3-4af1-9807-70cf41cfe94d) was booked DR X1 equipment expense; the customer owes it under the plan and no receivable was opened
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "smartphone_advance_receivable", "amount": 75000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "d8bbd824-7a74-4f79-acdb-3ef542558cfc", "reference_id": "e946ce59-bcd3-4af1-9807-70cf41cfe94d", "description": "Correction 2026-11-04: recognise receivable for the payout in group e946ce59-bcd3-4af1-9807-70cf41cfe94d - Audrey chair (FRED MUWANGUZI)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "equipment_expense", "amount": 75000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "d8bbd824-7a74-4f79-acdb-3ef542558cfc", "reference_id": "e946ce59-bcd3-4af1-9807-70cf41cfe94d", "description": "Correction 2026-11-04: reverse the payout expense in group e946ce59-bcd3-4af1-9807-70cf41cfe94d (now a receivable) - Audrey chair (FRED MUWANGUZI)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:d8bbd824-7a74-4f79-acdb-3ef542558cfc:MISSING');
  -- J2 office chair (FRED MUWANGUZI): CFO payout 500,000 (group f44c69ed-a61e-4754-b014-9180dc44d18e) was booked DR X1 equipment expense; the customer owes it under the plan and no receivable was opened
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "smartphone_advance_receivable", "amount": 500000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "a238c808-c566-473d-8094-4b25731c021a", "reference_id": "f44c69ed-a61e-4754-b014-9180dc44d18e", "description": "Correction 2026-11-04: recognise receivable for the payout in group f44c69ed-a61e-4754-b014-9180dc44d18e - office chair (FRED MUWANGUZI)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "equipment_expense", "amount": 500000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "a238c808-c566-473d-8094-4b25731c021a", "reference_id": "f44c69ed-a61e-4754-b014-9180dc44d18e", "description": "Correction 2026-11-04: reverse the payout expense in group f44c69ed-a61e-4754-b014-9180dc44d18e (now a receivable) - office chair (FRED MUWANGUZI)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:a238c808-c566-473d-8094-4b25731c021a:MISSING');
  -- J7 Welile Spiro Bike (Mata Pius): 22 Sep restatement (group 7be1c065-8577-43cd-abda-d2d07697df4f) opened 710,000 but the principal is 500,000; 210,000 is the old access fee, not receivable principal
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 210000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9", "reference_id": "7be1c065-8577-43cd-abda-d2d07697df4f", "description": "Correction 2026-11-04: reverse charges booked as principal by the 2026-09-22 restatement - Welile Spiro Bike (Mata Pius)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "bike_recovery_receivable_opening", "amount": 210000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9", "reference_id": "7be1c065-8577-43cd-abda-d2d07697df4f", "description": "Correction 2026-11-04: receivable reduced to principal 500,000 (charges 210,000 removed) - Welile Spiro Bike (Mata Pius)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9:J7');
  -- J1b Welile Smartphone (semyalo benon): collection of 216 on 2026-10-19 (group e74fdaa4-7f79-42ba-b1e4-26c5c648942f) was credited in full to A12; its charge part 135 (stored schedule) is revenue
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "merchandise_recovery_repayment", "amount": 135, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "673c0f25-1ec1-4824-aed9-f4e8c18db472", "reference_id": "e74fdaa4-7f79-42ba-b1e4-26c5c648942f", "description": "Correction 2026-11-04 (CFO-approved schedule): charge part of collection e74fdaa4-7f79-42ba-b1e4-26c5c648942f moved from A12 principal to R1 - Welile Smartphone (semyalo benon)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "access_fee_collected", "amount": 135, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "673c0f25-1ec1-4824-aed9-f4e8c18db472", "reference_id": "e74fdaa4-7f79-42ba-b1e4-26c5c648942f", "description": "Correction 2026-11-04 (CFO-approved schedule): monthly charge in collection e74fdaa4-7f79-42ba-b1e4-26c5c648942f recognised - Welile Smartphone (semyalo benon)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:673c0f25-1ec1-4824-aed9-f4e8c18db472:J1B:e74fdaa4-7f79-42ba-b1e4-26c5c648942f');
  -- J7 Welile Spiro Bike (ALPHA SSEMA): 22 Sep restatement (group c1597078-16c5-41f2-9bde-5dd7fcd8ff64) opened 710,000 but the principal is 500,000; 210,000 is the old access fee, not receivable principal
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 210000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "93d95269-34da-45f0-9845-fff6b7312220", "reference_id": "c1597078-16c5-41f2-9bde-5dd7fcd8ff64", "description": "Correction 2026-11-04: reverse charges booked as principal by the 2026-09-22 restatement - Welile Spiro Bike (ALPHA SSEMA)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "bike_recovery_receivable_opening", "amount": 210000, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "93d95269-34da-45f0-9845-fff6b7312220", "reference_id": "c1597078-16c5-41f2-9bde-5dd7fcd8ff64", "description": "Correction 2026-11-04: receivable reduced to principal 500,000 (charges 210,000 removed) - Welile Spiro Bike (ALPHA SSEMA)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:93d95269-34da-45f0-9845-fff6b7312220:J7');
  -- J1b Welile Smartphone (NSUBUGA Lawrence George): collection of 639 on 2026-10-25 (group c349303f-3e74-47f1-bffe-0ebca15edcc2) was credited in full to A12; its charge part 292 (stored schedule) is revenue
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_out", "category": "merchandise_recovery_repayment", "amount": 292, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "973c6ecb-3c1a-4f3d-8471-106fc460aec7", "reference_id": "c349303f-3e74-47f1-bffe-0ebca15edcc2", "description": "Correction 2026-11-04 (CFO-approved schedule): charge part of collection c349303f-3e74-47f1-bffe-0ebca15edcc2 moved from A12 principal to R1 - Welile Smartphone (NSUBUGA Lawrence George)"}, {"ledger_scope": "platform", "direction": "cash_in", "category": "access_fee_collected", "amount": 292, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "973c6ecb-3c1a-4f3d-8471-106fc460aec7", "reference_id": "c349303f-3e74-47f1-bffe-0ebca15edcc2", "description": "Correction 2026-11-04 (CFO-approved schedule): monthly charge in collection c349303f-3e74-47f1-bffe-0ebca15edcc2 recognised - Welile Smartphone (NSUBUGA Lawrence George)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:973c6ecb-3c1a-4f3d-8471-106fc460aec7:J1B:c349303f-3e74-47f1-bffe-0ebca15edcc2');
  -- J5 (plan deleted): plan deleted; its A13 opening (group e331dd0a-4f23-47a3-a144-1609ac1be143) has no order or plan behind it
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 246050, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "2edc40be-671b-4b1f-a00e-cb0e71b08482", "reference_id": "e331dd0a-4f23-47a3-a144-1609ac1be143", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - (plan deleted)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "bike_recovery_receivable_opening", "amount": 246050, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "2edc40be-671b-4b1f-a00e-cb0e71b08482", "reference_id": "e331dd0a-4f23-47a3-a144-1609ac1be143", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - (plan deleted)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:2edc40be-671b-4b1f-a00e-cb0e71b08482:DEREC');
  -- J5 (plan deleted): plan deleted; its A13 opening (group f58ca836-4720-4f41-913a-72a3eccb110d) has no order or plan behind it
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 159600, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "bc2acdbe-8e2c-4c90-aab4-5e922bf50c93", "reference_id": "f58ca836-4720-4f41-913a-72a3eccb110d", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - (plan deleted)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "bike_recovery_receivable_opening", "amount": 159600, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "bc2acdbe-8e2c-4c90-aab4-5e922bf50c93", "reference_id": "f58ca836-4720-4f41-913a-72a3eccb110d", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - (plan deleted)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:bc2acdbe-8e2c-4c90-aab4-5e922bf50c93:DEREC');
  -- J5 (plan deleted): plan deleted; its A13 opening (group 1f8e69d7-f976-456b-ab69-95888a063f45) has no order or plan behind it
  PERFORM public.create_ledger_transaction(entries => '[{"ledger_scope": "platform", "direction": "cash_in", "category": "receivable_restatement_equity", "amount": 163200, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "c95555c7-6363-4f09-b7c4-220a272db6ab", "reference_id": "1f8e69d7-f976-456b-ab69-95888a063f45", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - (plan deleted)"}, {"ledger_scope": "bridge", "direction": "cash_out", "category": "bike_recovery_receivable_opening", "amount": 163200, "currency": "UGX", "source_table": "merchandise_recovery_plans", "source_id": "c95555c7-6363-4f09-b7c4-220a272db6ab", "reference_id": "1f8e69d7-f976-456b-ab69-95888a063f45", "description": "Correction 2026-11-04: derecognise receivable for goods not delivered (remaining balance only) - (plan deleted)"}]'::jsonb, idempotency_key => 'merch_a12_a13_correction_20261104:c95555c7-6363-4f09-b7c4-220a272db6ab:DEREC');
END $post$;

-- ---------------------------------------------------------------- post-checks
DO $check$
DECLARE v_groups int; v_bad int; v_acct jsonb;
BEGIN
  SELECT count(DISTINCT transaction_group_id) INTO v_groups FROM public.general_ledger WHERE left(COALESCE(idempotency_key, ''), 34) = 'merch_a12_a13_correction_20261104:';
  SELECT count(*) INTO v_bad FROM (
    SELECT g.transaction_group_id FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE left(COALESCE(g.idempotency_key, ''), 34) = 'merch_a12_a13_correction_20261104:'
    GROUP BY 1
    HAVING sum(CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END) <> 0
        OR sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) <> 0
        OR bool_or(g.ledger_scope = 'wallet') OR count(*) <> 2) z;
  SELECT jsonb_object_agg(acct, net) INTO v_acct FROM (
    SELECT m.account_code acct, sum(CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END) net
    FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE left(COALESCE(g.idempotency_key, ''), 34) = 'merch_a12_a13_correction_20261104:' GROUP BY 1) z;
  IF v_groups <> 27 OR v_bad <> 0 OR v_acct IS DISTINCT FROM '{"A12": 933942, "A13": -1712145.52, "E3": 2153619.52, "R1": -5416, "X1": -1370000}'::jsonb THEN
    RAISE EXCEPTION 'merchandise correction: post-check failed (groups %, bad %, accounts %)', v_groups, v_bad, v_acct;
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_totals(date, date)')) IS DISTINCT FROM '7cb4ad64e743816e8130e398735b30c6' OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)')) IS DISTINCT FROM '6ff0d64da4142b425c0022663fcb0643' OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_agent_products_breakdown(date, date)')) IS DISTINCT FROM 'fb673e6c61738bdb1c25359fe605b06b' THEN
    RAISE EXCEPTION 'merchandise correction: report functions not as intended';
  END IF;
END $check$;
