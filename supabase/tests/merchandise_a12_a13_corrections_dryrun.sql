-- READ-ONLY dry run of supabase/migrations/20261104090000_merchandise_a12_a13_corrections.sql (SELECT only). Run with qro_file.sh.
-- Shows: every evidence check (must all be true), the planned groups and legs, and each item's A12/A13 balance now and after.
WITH planned(n, code, plan_id, item, acct, leg_acct, side, category, scope, direction, amount, idem) AS (VALUES
    (1, 'J6', 'ad7f535c-30fe-454a-a834-8e5be5ac58fb', 'Jumper white (CHEMUTAI ELISHA)', 'A12', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 65000, 'merch_a12_a13_correction_20261104:ad7f535c-30fe-454a-a834-8e5be5ac58fb:DEREC'),
    (1, 'J6', 'ad7f535c-30fe-454a-a834-8e5be5ac58fb', 'Jumper white (CHEMUTAI ELISHA)', 'A12', 'A12', 'CR', 'merchandise_recovery_receivable_opening', 'bridge', 'cash_out', 65000, 'merch_a12_a13_correction_20261104:ad7f535c-30fe-454a-a834-8e5be5ac58fb:DEREC'),
    (2, 'J7', '6d9d3a96-05f3-4bf1-a231-e04c352e0a40', 'Press Jacket (semyalo benon)', 'A12', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 30801, 'merch_a12_a13_correction_20261104:6d9d3a96-05f3-4bf1-a231-e04c352e0a40:J7'),
    (2, 'J7', '6d9d3a96-05f3-4bf1-a231-e04c352e0a40', 'Press Jacket (semyalo benon)', 'A12', 'A12', 'CR', 'merchandise_recovery_receivable_opening', 'bridge', 'cash_out', 30801, 'merch_a12_a13_correction_20261104:6d9d3a96-05f3-4bf1-a231-e04c352e0a40:J7'),
    (3, 'J1b', 'aec3dd25-002e-4af7-8105-f9c596c81583', 'Press Jacket (Barasa Emmanuel joan)', 'A12', 'A12', 'DR', 'merchandise_recovery_repayment', 'platform', 'cash_out', 3590, 'merch_a12_a13_correction_20261104:aec3dd25-002e-4af7-8105-f9c596c81583:J1B:1c0aae02-cd3c-48b6-a414-f5a1a308084b'),
    (3, 'J1b', 'aec3dd25-002e-4af7-8105-f9c596c81583', 'Press Jacket (Barasa Emmanuel joan)', 'A12', 'R1', 'CR', 'access_fee_collected', 'platform', 'cash_in', 3590, 'merch_a12_a13_correction_20261104:aec3dd25-002e-4af7-8105-f9c596c81583:J1B:1c0aae02-cd3c-48b6-a414-f5a1a308084b'),
    (4, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'A12', 'DR', 'merchandise_recovery_repayment', 'platform', 'cash_out', 327, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:31d8fbc4-0fb3-487d-90d1-0c98359f5cf9'),
    (4, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'R1', 'CR', 'access_fee_collected', 'platform', 'cash_in', 327, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:31d8fbc4-0fb3-487d-90d1-0c98359f5cf9'),
    (5, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'A12', 'DR', 'merchandise_recovery_repayment', 'platform', 'cash_out', 327, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:553e8bd5-ea79-422c-88a4-fb8623f6f378'),
    (5, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'R1', 'CR', 'access_fee_collected', 'platform', 'cash_in', 327, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:553e8bd5-ea79-422c-88a4-fb8623f6f378'),
    (6, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'A12', 'DR', 'merchandise_recovery_repayment', 'platform', 'cash_out', 327, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:6ed2036d-d2c3-4766-9950-7bb0cbf8af9c'),
    (6, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'R1', 'CR', 'access_fee_collected', 'platform', 'cash_in', 327, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:6ed2036d-d2c3-4766-9950-7bb0cbf8af9c'),
    (7, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'A12', 'DR', 'merchandise_recovery_repayment', 'platform', 'cash_out', 144, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:0a0e9648-75be-495f-b267-ffd18f32586e'),
    (7, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'R1', 'CR', 'access_fee_collected', 'platform', 'cash_in', 144, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:0a0e9648-75be-495f-b267-ffd18f32586e'),
    (8, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'A12', 'DR', 'merchandise_recovery_repayment', 'platform', 'cash_out', 274, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964'),
    (8, 'J1b', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'R1', 'CR', 'access_fee_collected', 'platform', 'cash_in', 274, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J1B:1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964'),
    (9, 'J7', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 19601, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J7'),
    (9, 'J7', '8c845dc0-e644-4f86-ab36-614d62d561ab', 'Welile Polo (semyalo benon)', 'A12', 'A12', 'CR', 'merchandise_recovery_receivable_opening', 'bridge', 'cash_out', 19601, 'merch_a12_a13_correction_20261104:8c845dc0-e644-4f86-ab36-614d62d561ab:J7'),
    (10, 'J7', 'ed33ae8b-c9e2-4eea-ae80-46c726830107', 'signages (Okwakol Micheal)', 'A12', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 28001, 'merch_a12_a13_correction_20261104:ed33ae8b-c9e2-4eea-ae80-46c726830107:J7'),
    (10, 'J7', 'ed33ae8b-c9e2-4eea-ae80-46c726830107', 'signages (Okwakol Micheal)', 'A12', 'A12', 'CR', 'merchandise_recovery_receivable_opening', 'bridge', 'cash_out', 28001, 'merch_a12_a13_correction_20261104:ed33ae8b-c9e2-4eea-ae80-46c726830107:J7'),
    (11, 'J5', '48c09a3f-b128-4671-8e01-8a9a88af429f', 'Welile Spiro Bike (Nakato oliver)', 'A13', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 192850, 'merch_a12_a13_correction_20261104:48c09a3f-b128-4671-8e01-8a9a88af429f:DEREC'),
    (11, 'J5', '48c09a3f-b128-4671-8e01-8a9a88af429f', 'Welile Spiro Bike (Nakato oliver)', 'A13', 'A13', 'CR', 'bike_recovery_receivable_opening', 'bridge', 'cash_out', 192850, 'merch_a12_a13_correction_20261104:48c09a3f-b128-4671-8e01-8a9a88af429f:DEREC'),
    (12, 'J5', '08f711e2-927a-43dd-bce0-73831c4dd16a', 'Welile Spiro Bike (Martin lukwago)', 'A13', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 10549, 'merch_a12_a13_correction_20261104:08f711e2-927a-43dd-bce0-73831c4dd16a:DEREC'),
    (12, 'J5', '08f711e2-927a-43dd-bce0-73831c4dd16a', 'Welile Spiro Bike (Martin lukwago)', 'A13', 'A13', 'CR', 'bike_recovery_receivable_opening', 'bridge', 'cash_out', 10549, 'merch_a12_a13_correction_20261104:08f711e2-927a-43dd-bce0-73831c4dd16a:DEREC'),
    (13, 'J5', '9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0', 'Welile Spiro Bike (walimbwa peter)', 'A13', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 664896.52, 'merch_a12_a13_correction_20261104:9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0:DEREC'),
    (13, 'J5', '9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0', 'Welile Spiro Bike (walimbwa peter)', 'A13', 'A13', 'CR', 'bike_recovery_receivable_opening', 'bridge', 'cash_out', 664896.52, 'merch_a12_a13_correction_20261104:9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0:DEREC'),
    (14, 'J7', '85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297', 'Company Ids (semyalo benon)', 'A12', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 25200, 'merch_a12_a13_correction_20261104:85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297:J7'),
    (14, 'J7', '85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297', 'Company Ids (semyalo benon)', 'A12', 'A12', 'CR', 'merchandise_recovery_receivable_opening', 'bridge', 'cash_out', 25200, 'merch_a12_a13_correction_20261104:85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297:J7'),
    (15, 'J6', 'fdb05fd5-e17c-49b6-a1f9-dd1d238edb85', 'Press Jacket (EMMANUEL WASWA SSESANGA)', 'A12', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 35471, 'merch_a12_a13_correction_20261104:fdb05fd5-e17c-49b6-a1f9-dd1d238edb85:DEREC'),
    (15, 'J6', 'fdb05fd5-e17c-49b6-a1f9-dd1d238edb85', 'Press Jacket (EMMANUEL WASWA SSESANGA)', 'A12', 'A12', 'CR', 'merchandise_recovery_receivable_opening', 'bridge', 'cash_out', 35471, 'merch_a12_a13_correction_20261104:fdb05fd5-e17c-49b6-a1f9-dd1d238edb85:DEREC'),
    (16, 'J7', 'c75a2acc-6dcf-47ba-bce3-2213bfb40ad1', 'Welile Smartphone (Kayongo Joel)', 'A12', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 92400, 'merch_a12_a13_correction_20261104:c75a2acc-6dcf-47ba-bce3-2213bfb40ad1:J7'),
    (16, 'J7', 'c75a2acc-6dcf-47ba-bce3-2213bfb40ad1', 'Welile Smartphone (Kayongo Joel)', 'A12', 'A12', 'CR', 'merchandise_recovery_receivable_opening', 'bridge', 'cash_out', 92400, 'merch_a12_a13_correction_20261104:c75a2acc-6dcf-47ba-bce3-2213bfb40ad1:J7'),
    (17, 'J3', '71570ebd-b43a-4dd6-8f96-e7b0ab982475', 'Welile Spiro Bike (Abraham Chelimo)', 'A13', 'A13', 'DR', 'bike_recovery_repayment', 'platform', 'cash_out', 145000, 'merch_a12_a13_correction_20261104:71570ebd-b43a-4dd6-8f96-e7b0ab982475:MISSING'),
    (17, 'J3', '71570ebd-b43a-4dd6-8f96-e7b0ab982475', 'Welile Spiro Bike (Abraham Chelimo)', 'A13', 'X1', 'CR', 'equipment_expense', 'platform', 'cash_in', 145000, 'merch_a12_a13_correction_20261104:71570ebd-b43a-4dd6-8f96-e7b0ab982475:MISSING'),
    (18, 'J2', '16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb', 'waiting chair (FRED MUWANGUZI)', 'A12', 'A12', 'DR', 'smartphone_advance_receivable', 'platform', 'cash_out', 650000, 'merch_a12_a13_correction_20261104:16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb:MISSING'),
    (18, 'J2', '16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb', 'waiting chair (FRED MUWANGUZI)', 'A12', 'X1', 'CR', 'equipment_expense', 'platform', 'cash_in', 650000, 'merch_a12_a13_correction_20261104:16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb:MISSING'),
    (19, 'J2', 'd8bbd824-7a74-4f79-acdb-3ef542558cfc', 'Audrey chair (FRED MUWANGUZI)', 'A12', 'A12', 'DR', 'smartphone_advance_receivable', 'platform', 'cash_out', 75000, 'merch_a12_a13_correction_20261104:d8bbd824-7a74-4f79-acdb-3ef542558cfc:MISSING'),
    (19, 'J2', 'd8bbd824-7a74-4f79-acdb-3ef542558cfc', 'Audrey chair (FRED MUWANGUZI)', 'A12', 'X1', 'CR', 'equipment_expense', 'platform', 'cash_in', 75000, 'merch_a12_a13_correction_20261104:d8bbd824-7a74-4f79-acdb-3ef542558cfc:MISSING'),
    (20, 'J2', 'a238c808-c566-473d-8094-4b25731c021a', 'office chair (FRED MUWANGUZI)', 'A12', 'A12', 'DR', 'smartphone_advance_receivable', 'platform', 'cash_out', 500000, 'merch_a12_a13_correction_20261104:a238c808-c566-473d-8094-4b25731c021a:MISSING'),
    (20, 'J2', 'a238c808-c566-473d-8094-4b25731c021a', 'office chair (FRED MUWANGUZI)', 'A12', 'X1', 'CR', 'equipment_expense', 'platform', 'cash_in', 500000, 'merch_a12_a13_correction_20261104:a238c808-c566-473d-8094-4b25731c021a:MISSING'),
    (21, 'J7', 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9', 'Welile Spiro Bike (Mata Pius)', 'A13', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 210000, 'merch_a12_a13_correction_20261104:bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9:J7'),
    (21, 'J7', 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9', 'Welile Spiro Bike (Mata Pius)', 'A13', 'A13', 'CR', 'bike_recovery_receivable_opening', 'bridge', 'cash_out', 210000, 'merch_a12_a13_correction_20261104:bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9:J7'),
    (22, 'J1b', '673c0f25-1ec1-4824-aed9-f4e8c18db472', 'Welile Smartphone (semyalo benon)', 'A12', 'A12', 'DR', 'merchandise_recovery_repayment', 'platform', 'cash_out', 135, 'merch_a12_a13_correction_20261104:673c0f25-1ec1-4824-aed9-f4e8c18db472:J1B:e74fdaa4-7f79-42ba-b1e4-26c5c648942f'),
    (22, 'J1b', '673c0f25-1ec1-4824-aed9-f4e8c18db472', 'Welile Smartphone (semyalo benon)', 'A12', 'R1', 'CR', 'access_fee_collected', 'platform', 'cash_in', 135, 'merch_a12_a13_correction_20261104:673c0f25-1ec1-4824-aed9-f4e8c18db472:J1B:e74fdaa4-7f79-42ba-b1e4-26c5c648942f'),
    (23, 'J7', '93d95269-34da-45f0-9845-fff6b7312220', 'Welile Spiro Bike (ALPHA SSEMA)', 'A13', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 210000, 'merch_a12_a13_correction_20261104:93d95269-34da-45f0-9845-fff6b7312220:J7'),
    (23, 'J7', '93d95269-34da-45f0-9845-fff6b7312220', 'Welile Spiro Bike (ALPHA SSEMA)', 'A13', 'A13', 'CR', 'bike_recovery_receivable_opening', 'bridge', 'cash_out', 210000, 'merch_a12_a13_correction_20261104:93d95269-34da-45f0-9845-fff6b7312220:J7'),
    (24, 'J1b', '973c6ecb-3c1a-4f3d-8471-106fc460aec7', 'Welile Smartphone (NSUBUGA Lawrence George)', 'A12', 'A12', 'DR', 'merchandise_recovery_repayment', 'platform', 'cash_out', 292, 'merch_a12_a13_correction_20261104:973c6ecb-3c1a-4f3d-8471-106fc460aec7:J1B:c349303f-3e74-47f1-bffe-0ebca15edcc2'),
    (24, 'J1b', '973c6ecb-3c1a-4f3d-8471-106fc460aec7', 'Welile Smartphone (NSUBUGA Lawrence George)', 'A12', 'R1', 'CR', 'access_fee_collected', 'platform', 'cash_in', 292, 'merch_a12_a13_correction_20261104:973c6ecb-3c1a-4f3d-8471-106fc460aec7:J1B:c349303f-3e74-47f1-bffe-0ebca15edcc2'),
    (25, 'J5', '2edc40be-671b-4b1f-a00e-cb0e71b08482', '(plan deleted)', 'A13', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 246050, 'merch_a12_a13_correction_20261104:2edc40be-671b-4b1f-a00e-cb0e71b08482:DEREC'),
    (25, 'J5', '2edc40be-671b-4b1f-a00e-cb0e71b08482', '(plan deleted)', 'A13', 'A13', 'CR', 'bike_recovery_receivable_opening', 'bridge', 'cash_out', 246050, 'merch_a12_a13_correction_20261104:2edc40be-671b-4b1f-a00e-cb0e71b08482:DEREC'),
    (26, 'J5', 'bc2acdbe-8e2c-4c90-aab4-5e922bf50c93', '(plan deleted)', 'A13', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 159600, 'merch_a12_a13_correction_20261104:bc2acdbe-8e2c-4c90-aab4-5e922bf50c93:DEREC'),
    (26, 'J5', 'bc2acdbe-8e2c-4c90-aab4-5e922bf50c93', '(plan deleted)', 'A13', 'A13', 'CR', 'bike_recovery_receivable_opening', 'bridge', 'cash_out', 159600, 'merch_a12_a13_correction_20261104:bc2acdbe-8e2c-4c90-aab4-5e922bf50c93:DEREC'),
    (27, 'J5', 'c95555c7-6363-4f09-b7c4-220a272db6ab', '(plan deleted)', 'A13', 'E3', 'DR', 'receivable_restatement_equity', 'platform', 'cash_in', 163200, 'merch_a12_a13_correction_20261104:c95555c7-6363-4f09-b7c4-220a272db6ab:DEREC'),
    (27, 'J5', 'c95555c7-6363-4f09-b7c4-220a272db6ab', '(plan deleted)', 'A13', 'A13', 'CR', 'bike_recovery_receivable_opening', 'bridge', 'cash_out', 163200, 'merch_a12_a13_correction_20261104:c95555c7-6363-4f09-b7c4-220a272db6ab:DEREC')
), checks AS (
  SELECT 1 n, 'ad7f535c-30fe-454a-a834-8e5be5ac58fb' plan_id, 'J6' code, NOT ((SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('ad7f535c-30fe-454a-a834-8e5be5ac58fb'::uuid, 'a8db01e9-02f2-4e4d-95bd-c5be59701b05'::uuid) OR reference_id IN ('ad7f535c-30fe-454a-a834-8e5be5ac58fb', 'a8db01e9-02f2-4e4d-95bd-c5be59701b05'))) IS DISTINCT FROM '40153b06-713a-4b09-8588-769053c5317e'
      OR (SELECT order_status FROM public.merchandise_sales WHERE id = 'a8db01e9-02f2-4e4d-95bd-c5be59701b05') IS DISTINCT FROM 'pending_approval') AS evidence_ok
  UNION ALL
  SELECT 2 n, '6d9d3a96-05f3-4bf1-a231-e04c352e0a40' plan_id, 'J7' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = '461e2615-3e16-4cbf-8eeb-d4aa173851dc' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = '6d9d3a96-05f3-4bf1-a231-e04c352e0a40') IS DISTINCT FROM 85801
      OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = '6d9d3a96-05f3-4bf1-a231-e04c352e0a40' AND category = 'merchandise_recovery_receivable_opening') <> 1
      OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = '3bc99bf6-1a37-47f5-a185-4aedf49ddbad') IS DISTINCT FROM 55000) AS evidence_ok
  UNION ALL
  SELECT 3 n, 'aec3dd25-002e-4af7-8105-f9c596c81583' plan_id, 'J1b' code, NOT ((SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '1c0aae02-cd3c-48b6-a414-f5a1a308084b' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 10000 AND source_id = 'aec3dd25-002e-4af7-8105-f9c596c81583') <> 1
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '1c0aae02-cd3c-48b6-a414-f5a1a308084b' AND category = 'access_fee_collected')
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '1c0aae02-cd3c-48b6-a414-f5a1a308084b')
      OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = 'aec3dd25-002e-4af7-8105-f9c596c81583') IS DISTINCT FROM 156200
      OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = 'aec3dd25-002e-4af7-8105-f9c596c81583') IS DISTINCT FROM '2026-09-24'
      OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4cf491c5-21b0-4366-9369-7a210b431013') IS DISTINCT FROM '156200/2') AS evidence_ok
  UNION ALL
  SELECT 4 n, '8c845dc0-e644-4f86-ab36-614d62d561ab' plan_id, 'J1b' code, NOT ((SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '31d8fbc4-0fb3-487d-90d1-0c98359f5cf9' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 716 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '31d8fbc4-0fb3-487d-90d1-0c98359f5cf9' AND category = 'access_fee_collected')
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '31d8fbc4-0fb3-487d-90d1-0c98359f5cf9')
      OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
      OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
      OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3') AS evidence_ok
  UNION ALL
  SELECT 5 n, '8c845dc0-e644-4f86-ab36-614d62d561ab' plan_id, 'J1b' code, NOT ((SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '553e8bd5-ea79-422c-88a4-fb8623f6f378' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 716 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '553e8bd5-ea79-422c-88a4-fb8623f6f378' AND category = 'access_fee_collected')
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '553e8bd5-ea79-422c-88a4-fb8623f6f378')
      OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
      OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
      OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3') AS evidence_ok
  UNION ALL
  SELECT 6 n, '8c845dc0-e644-4f86-ab36-614d62d561ab' plan_id, 'J1b' code, NOT ((SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '6ed2036d-d2c3-4766-9950-7bb0cbf8af9c' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 716 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '6ed2036d-d2c3-4766-9950-7bb0cbf8af9c' AND category = 'access_fee_collected')
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '6ed2036d-d2c3-4766-9950-7bb0cbf8af9c')
      OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
      OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
      OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3') AS evidence_ok
  UNION ALL
  SELECT 7 n, '8c845dc0-e644-4f86-ab36-614d62d561ab' plan_id, 'J1b' code, NOT ((SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '0a0e9648-75be-495f-b267-ffd18f32586e' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 316 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '0a0e9648-75be-495f-b267-ffd18f32586e' AND category = 'access_fee_collected')
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '0a0e9648-75be-495f-b267-ffd18f32586e')
      OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
      OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
      OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3') AS evidence_ok
  UNION ALL
  SELECT 8 n, '8c845dc0-e644-4f86-ab36-614d62d561ab' plan_id, 'J1b' code, NOT ((SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = '1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 600 AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') <> 1
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = '1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964' AND category = 'access_fee_collected')
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = '1b1b5fca-bbe4-4006-8dd6-5c9dfbe98964')
      OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
      OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM '2026-09-21'
      OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM '54601/3') AS evidence_ok
  UNION ALL
  SELECT 9 n, '8c845dc0-e644-4f86-ab36-614d62d561ab' plan_id, 'J7' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'cf004e45-e7de-4b6b-92cd-40c3c2c9dc19' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab') IS DISTINCT FROM 54601
      OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = '8c845dc0-e644-4f86-ab36-614d62d561ab' AND category = 'merchandise_recovery_receivable_opening') <> 1
      OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = '4b4d8c8a-09a3-49c4-af42-5122693b9ef8') IS DISTINCT FROM 35000) AS evidence_ok
  UNION ALL
  SELECT 10 n, 'ed33ae8b-c9e2-4eea-ae80-46c726830107' plan_id, 'J7' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'bdd9ba3d-4430-4a94-a18c-9601cef90d2f' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = 'ed33ae8b-c9e2-4eea-ae80-46c726830107') IS DISTINCT FROM 78001
      OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = 'ed33ae8b-c9e2-4eea-ae80-46c726830107' AND category = 'merchandise_recovery_receivable_opening') <> 1
      OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = 'c70edae6-f131-4304-98d1-36af8d0e8680') IS DISTINCT FROM 50000) AS evidence_ok
  UNION ALL
  SELECT 11 n, '48c09a3f-b128-4671-8e01-8a9a88af429f' plan_id, 'J5' code, NOT ((SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('48c09a3f-b128-4671-8e01-8a9a88af429f'::uuid, 'bf923bdc-27a6-4a13-b1f0-f54dca6e5355'::uuid) OR reference_id IN ('48c09a3f-b128-4671-8e01-8a9a88af429f', 'bf923bdc-27a6-4a13-b1f0-f54dca6e5355'))) IS DISTINCT FROM 'c23a68a4-2056-4301-a9d7-781d8c0054d9'
      OR (SELECT order_status FROM public.merchandise_sales WHERE id = 'bf923bdc-27a6-4a13-b1f0-f54dca6e5355') IS DISTINCT FROM 'rejected') AS evidence_ok
  UNION ALL
  SELECT 12 n, '08f711e2-927a-43dd-bce0-73831c4dd16a' plan_id, 'J5' code, NOT ((SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('08f711e2-927a-43dd-bce0-73831c4dd16a'::uuid, 'dddc2333-efb2-4855-9ab7-f3d5c3793873'::uuid) OR reference_id IN ('08f711e2-927a-43dd-bce0-73831c4dd16a', 'dddc2333-efb2-4855-9ab7-f3d5c3793873'))) IS DISTINCT FROM '363d3c7e-8383-47c6-8a37-eefba64bcde5,3c3bbd25-f18b-4c6d-9b08-7a7174bfb685,45350348-c291-49d1-82ed-6abfddf193f9,559cb590-9d29-486c-bdf7-044dad0698bc,638fa018-b433-4d6d-87cb-758ffe667f14,64b3d9c2-882c-40e0-918f-51cbc08cb2ad,64e05571-8428-45aa-9fd7-14023861c88a,87ce086f-d205-47c5-8ab4-fedb0e9149ed,a08feb5b-df7e-4b29-88dc-f195476e1eec,cec2fc54-b8e7-4181-9ddf-f60f89b86af6,d2fa50c7-dc6f-4e99-a543-438a663ee01e,d678e01a-55d4-4b1f-b326-2d64c7ca48e0,ebd60b55-fd44-4e67-893d-2b108613be06,fa6d7234-bfda-467e-843b-6b010ae07f4b'
      OR (SELECT order_status FROM public.merchandise_sales WHERE id = 'dddc2333-efb2-4855-9ab7-f3d5c3793873') IS DISTINCT FROM 'rejected') AS evidence_ok
  UNION ALL
  SELECT 13 n, '9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0' plan_id, 'J5' code, NOT ((SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0'::uuid, '54c4c664-6004-4aab-a56c-b285050633cd'::uuid) OR reference_id IN ('9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0', '54c4c664-6004-4aab-a56c-b285050633cd'))) IS DISTINCT FROM '58019236-67f8-4701-a2a7-2a09307034e3,6286223b-54b7-4625-bb18-02445328278c'
      OR (SELECT order_status FROM public.merchandise_sales WHERE id = '54c4c664-6004-4aab-a56c-b285050633cd') IS DISTINCT FROM 'rejected') AS evidence_ok
  UNION ALL
  SELECT 14 n, '85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297' plan_id, 'J7' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = '47e2056e-e27a-4831-95d6-983ec3e58229' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = '85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297') IS DISTINCT FROM 70200
      OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = '85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297' AND category = 'merchandise_recovery_receivable_opening') <> 1
      OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = '6681828a-7449-4af0-9e71-972d8ba54a98') IS DISTINCT FROM 45000) AS evidence_ok
  UNION ALL
  SELECT 15 n, 'fdb05fd5-e17c-49b6-a1f9-dd1d238edb85' plan_id, 'J6' code, NOT ((SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('fdb05fd5-e17c-49b6-a1f9-dd1d238edb85'::uuid, '3a82618b-7d49-4015-ad72-7a1e06dbb5ab'::uuid) OR reference_id IN ('fdb05fd5-e17c-49b6-a1f9-dd1d238edb85', '3a82618b-7d49-4015-ad72-7a1e06dbb5ab'))) IS DISTINCT FROM '13b424d1-cd40-4511-b49c-ba55109036d2,42890207-99e5-47e4-8ec0-67c17b17ef0c,50dd123f-1881-4c4a-87ed-cf8ade764cad,704ea639-a2c6-467f-9ed9-c2397fc3f288,715b39e2-571f-4bef-8241-b967ccc442b4,7956e554-5e59-43ad-adc4-e8e5e0ac728e,929957f8-fc53-431e-98d2-1a1bab0ee644,9f890350-4e57-44e0-a611-ab5a7e4ecb67,9feb412c-d89b-4429-955c-76102c3c1544,a06a3292-c0be-4d7d-9621-034e24e6313c,aa97b0fc-3f33-4525-b8c9-09c252139145,b4462f82-b723-41d1-bf57-238b290bf615,ba2d87dc-a13c-4cbd-b9dd-1b869e590214,c5bf9a39-fea0-403e-a575-66595d3a3092,dded5e1b-49cf-43d0-a2fe-cadc6f217015,e78dbd42-5830-4416-b3b3-37ec08a866ca'
      OR (SELECT order_status FROM public.merchandise_sales WHERE id = '3a82618b-7d49-4015-ad72-7a1e06dbb5ab') IS DISTINCT FROM 'pending_approval') AS evidence_ok
  UNION ALL
  SELECT 16 n, 'c75a2acc-6dcf-47ba-bce3-2213bfb40ad1' plan_id, 'J7' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'c9e2f448-7523-4df7-9018-1af7783f9893' AND ledger_scope = 'bridge' AND category = 'merchandise_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = 'c75a2acc-6dcf-47ba-bce3-2213bfb40ad1') IS DISTINCT FROM 257400
      OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = 'c75a2acc-6dcf-47ba-bce3-2213bfb40ad1' AND category = 'merchandise_recovery_receivable_opening') <> 1
      OR (SELECT COALESCE(NULLIF(disbursed_amount, 0), total_revenue) FROM public.merchandise_sales WHERE id = '9b704619-2d97-44cb-a61e-5ba7ac6525f6') IS DISTINCT FROM 165000) AS evidence_ok
  UNION ALL
  SELECT 17 n, '71570ebd-b43a-4dd6-8f96-e7b0ab982475' plan_id, 'J3' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = '8905a91c-f154-4754-84a2-5f46b04f37e6' AND ledger_scope = 'platform' AND category = 'equipment_expense' AND direction = 'cash_out' AND source_id = '27842d46-9467-4852-853e-c4100fbbc516') IS DISTINCT FROM 145000
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE (source_id IN ('71570ebd-b43a-4dd6-8f96-e7b0ab982475'::uuid, '27842d46-9467-4852-853e-c4100fbbc516'::uuid) OR reference_id IN ('71570ebd-b43a-4dd6-8f96-e7b0ab982475', '27842d46-9467-4852-853e-c4100fbbc516')) AND category IN ('merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'smartphone_advance_receivable'))
      OR (SELECT order_status FROM public.merchandise_sales WHERE id = '27842d46-9467-4852-853e-c4100fbbc516') IS DISTINCT FROM 'approved') AS evidence_ok
  UNION ALL
  SELECT 18 n, '16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb' plan_id, 'J2' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'bbfbff6a-3cb9-4af4-af84-cd6179ef04aa' AND ledger_scope = 'platform' AND category = 'equipment_expense' AND direction = 'cash_out' AND source_id = '893e5dde-cad2-4745-a607-5b94d9e087a4') IS DISTINCT FROM 650000
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE (source_id IN ('16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb'::uuid, '893e5dde-cad2-4745-a607-5b94d9e087a4'::uuid) OR reference_id IN ('16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb', '893e5dde-cad2-4745-a607-5b94d9e087a4')) AND category IN ('merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'smartphone_advance_receivable'))
      OR (SELECT order_status FROM public.merchandise_sales WHERE id = '893e5dde-cad2-4745-a607-5b94d9e087a4') IS DISTINCT FROM 'issued') AS evidence_ok
  UNION ALL
  SELECT 19 n, 'd8bbd824-7a74-4f79-acdb-3ef542558cfc' plan_id, 'J2' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'e946ce59-bcd3-4af1-9807-70cf41cfe94d' AND ledger_scope = 'platform' AND category = 'equipment_expense' AND direction = 'cash_out' AND source_id = '97534451-ca4e-42e1-9f49-d45fd44031f9') IS DISTINCT FROM 75000
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE (source_id IN ('d8bbd824-7a74-4f79-acdb-3ef542558cfc'::uuid, '97534451-ca4e-42e1-9f49-d45fd44031f9'::uuid) OR reference_id IN ('d8bbd824-7a74-4f79-acdb-3ef542558cfc', '97534451-ca4e-42e1-9f49-d45fd44031f9')) AND category IN ('merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'smartphone_advance_receivable'))
      OR (SELECT order_status FROM public.merchandise_sales WHERE id = '97534451-ca4e-42e1-9f49-d45fd44031f9') IS DISTINCT FROM 'issued') AS evidence_ok
  UNION ALL
  SELECT 20 n, 'a238c808-c566-473d-8094-4b25731c021a' plan_id, 'J2' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'f44c69ed-a61e-4754-b014-9180dc44d18e' AND ledger_scope = 'platform' AND category = 'equipment_expense' AND direction = 'cash_out' AND source_id = '136b32fb-5b28-496d-96d4-ba2eb3b9f8bb') IS DISTINCT FROM 500000
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE (source_id IN ('a238c808-c566-473d-8094-4b25731c021a'::uuid, '136b32fb-5b28-496d-96d4-ba2eb3b9f8bb'::uuid) OR reference_id IN ('a238c808-c566-473d-8094-4b25731c021a', '136b32fb-5b28-496d-96d4-ba2eb3b9f8bb')) AND category IN ('merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'smartphone_advance_receivable'))
      OR (SELECT order_status FROM public.merchandise_sales WHERE id = '136b32fb-5b28-496d-96d4-ba2eb3b9f8bb') IS DISTINCT FROM 'issued') AS evidence_ok
  UNION ALL
  SELECT 21 n, 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9' plan_id, 'J7' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = '7be1c065-8577-43cd-abda-d2d07697df4f' AND ledger_scope = 'bridge' AND category = 'bike_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9') IS DISTINCT FROM 710000
      OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9' AND category = 'bike_recovery_receivable_opening') <> 1
      OR (SELECT principal_total FROM public.merchandise_recovery_plans WHERE id = 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9') IS DISTINCT FROM 500000) AS evidence_ok
  UNION ALL
  SELECT 22 n, '673c0f25-1ec1-4824-aed9-f4e8c18db472' plan_id, 'J1b' code, NOT ((SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = 'e74fdaa4-7f79-42ba-b1e4-26c5c648942f' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 216 AND source_id = '673c0f25-1ec1-4824-aed9-f4e8c18db472') <> 1
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = 'e74fdaa4-7f79-42ba-b1e4-26c5c648942f' AND category = 'access_fee_collected')
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = 'e74fdaa4-7f79-42ba-b1e4-26c5c648942f')
      OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '673c0f25-1ec1-4824-aed9-f4e8c18db472') IS DISTINCT FROM 1386004
      OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '673c0f25-1ec1-4824-aed9-f4e8c18db472') IS DISTINCT FROM '2026-10-13'
      OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = '3d11c494-31b9-468a-a638-24921a83a0b5') IS DISTINCT FROM '1386004/6') AS evidence_ok
  UNION ALL
  SELECT 23 n, '93d95269-34da-45f0-9845-fff6b7312220' plan_id, 'J7' code, NOT ((SELECT sum(amount) FROM public.general_ledger WHERE transaction_group_id = 'c1597078-16c5-41f2-9bde-5dd7fcd8ff64' AND ledger_scope = 'bridge' AND category = 'bike_recovery_receivable_opening' AND direction = 'cash_in' AND source_id = '93d95269-34da-45f0-9845-fff6b7312220') IS DISTINCT FROM 710000
      OR (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE source_id = '93d95269-34da-45f0-9845-fff6b7312220' AND category = 'bike_recovery_receivable_opening') <> 1
      OR (SELECT principal_total FROM public.merchandise_recovery_plans WHERE id = '93d95269-34da-45f0-9845-fff6b7312220') IS DISTINCT FROM 500000) AS evidence_ok
  UNION ALL
  SELECT 24 n, '973c6ecb-3c1a-4f3d-8471-106fc460aec7' plan_id, 'J1b' code, NOT ((SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = 'c349303f-3e74-47f1-bffe-0ebca15edcc2' AND ledger_scope = 'platform' AND category IN ('agent_repayment', 'merchandise_recovery_repayment') AND direction = 'cash_in' AND amount = 639 AND source_id = '973c6ecb-3c1a-4f3d-8471-106fc460aec7') <> 1
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE transaction_group_id = 'c349303f-3e74-47f1-bffe-0ebca15edcc2' AND category = 'access_fee_collected')
      OR EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = 'c349303f-3e74-47f1-bffe-0ebca15edcc2')
      OR (SELECT original_amount FROM public.merchandise_recovery_plans WHERE id = '973c6ecb-3c1a-4f3d-8471-106fc460aec7') IS DISTINCT FROM 1482001
      OR (SELECT starts_on::text FROM public.merchandise_recovery_plans WHERE id = '973c6ecb-3c1a-4f3d-8471-106fc460aec7') IS DISTINCT FROM '2026-10-26'
      OR (SELECT COALESCE(sum(total_due), 0)::numeric(14,0)::text || '/' || count(*) FROM public.smartphone_repayment_schedules WHERE sale_id = 'c60db3db-334d-453e-89b8-aa1557535778') IS DISTINCT FROM '1482001/3') AS evidence_ok
  UNION ALL
  SELECT 25 n, '2edc40be-671b-4b1f-a00e-cb0e71b08482' plan_id, 'J5' code, NOT ((SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('2edc40be-671b-4b1f-a00e-cb0e71b08482'::uuid) OR reference_id IN ('2edc40be-671b-4b1f-a00e-cb0e71b08482'))) IS DISTINCT FROM 'e331dd0a-4f23-47a3-a144-1609ac1be143'
      OR EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = '2edc40be-671b-4b1f-a00e-cb0e71b08482')) AS evidence_ok
  UNION ALL
  SELECT 26 n, 'bc2acdbe-8e2c-4c90-aab4-5e922bf50c93' plan_id, 'J5' code, NOT ((SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('bc2acdbe-8e2c-4c90-aab4-5e922bf50c93'::uuid) OR reference_id IN ('bc2acdbe-8e2c-4c90-aab4-5e922bf50c93'))) IS DISTINCT FROM 'f58ca836-4720-4f41-913a-72a3eccb110d'
      OR EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = 'bc2acdbe-8e2c-4c90-aab4-5e922bf50c93')) AS evidence_ok
  UNION ALL
  SELECT 27 n, 'c95555c7-6363-4f09-b7c4-220a272db6ab' plan_id, 'J5' code, NOT ((SELECT string_agg(DISTINCT transaction_group_id::text, ',' ORDER BY transaction_group_id::text) FROM public.general_ledger WHERE (source_id IN ('c95555c7-6363-4f09-b7c4-220a272db6ab'::uuid) OR reference_id IN ('c95555c7-6363-4f09-b7c4-220a272db6ab'))) IS DISTINCT FROM '1f8e69d7-f976-456b-ab69-95888a063f45'
      OR EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = 'c95555c7-6363-4f09-b7c4-220a272db6ab')) AS evidence_ok
), items(plan_id, sale_id, acct) AS (VALUES
    ('712a5bf8-943b-4a62-a874-c9b96af19ad2'::uuid, 'd5de3e6f-8f55-4423-8d95-01b067eb5613'::uuid, 'A12'),
    ('d5de9505-864f-441d-bf14-5bc9765e8877'::uuid, '6b4250aa-0d31-4b3a-962e-917441b1df10'::uuid, 'A12'),
    ('cd8a34e2-cea8-42f4-9a54-cd2f7f632aca'::uuid, '64f52cb2-fbee-4491-ad70-e57de570d19d'::uuid, 'A12'),
    ('03372202-64b1-449c-9fc0-24667d50e67a'::uuid, 'cdd40f43-a361-4e2e-b5a3-b5e5a8049d00'::uuid, 'A12'),
    ('ad7f535c-30fe-454a-a834-8e5be5ac58fb'::uuid, 'a8db01e9-02f2-4e4d-95bd-c5be59701b05'::uuid, 'A12'),
    ('4196c331-9e7f-41c3-b28c-ff087fed8577'::uuid, 'ddbb0533-43d4-47e8-abd4-b4a4d88b0abe'::uuid, 'A12'),
    ('7284104f-de79-4a02-a0f0-4ce86b24b6dc'::uuid, '1af2f78e-66b2-41fd-b88e-adb10e569245'::uuid, 'A12'),
    ('be6648d8-f50f-4ded-9150-f4f0efeb714e'::uuid, '52f9c14a-b7f3-4b91-806a-773677ff7d1e'::uuid, 'A12'),
    ('f843e0bd-d97b-4b47-a77f-32885183ea15'::uuid, '96096f9d-9fa0-4cdb-84c9-6b83442d411b'::uuid, 'A12'),
    ('79148848-5615-4a9b-8a87-de6909fce8ea'::uuid, '2d8fc79b-5e70-4599-8b88-ff16d415a284'::uuid, 'A12'),
    ('eee8413b-5be5-49cc-b4cf-33997ff0676c'::uuid, '9555c0dd-c5ca-43ec-8af1-9831ceb1bd00'::uuid, 'A12'),
    ('44bd1183-e4fc-4311-9feb-744f6b25378e'::uuid, '0420e585-bd33-4437-b14a-dc04e6f0c171'::uuid, 'A12'),
    ('81565b62-f6b8-4623-8d51-894ea5eb4389'::uuid, '491dcacc-ec7e-42e2-b226-66505560a12e'::uuid, 'A12'),
    ('04fc78ae-dc12-4023-ace6-dd5e293ccbd4'::uuid, 'f0fc21f4-987e-44db-833b-66a2eb17b03d'::uuid, 'A12'),
    ('c34f4427-c153-43fa-891b-519be48101ef'::uuid, '1b31572e-0731-4eae-bb8f-7902a3dfa3d9'::uuid, 'A12'),
    ('d168a0d9-a5e1-4cdf-9277-fe48b5b990d8'::uuid, '4cfe7a01-0488-4228-b099-13b985c3e2e3'::uuid, 'A12'),
    ('be9ee964-7f38-4f43-8939-0fe17a8e52b9'::uuid, '3f13d137-4b44-4676-a0ae-1e4b729aa1cb'::uuid, 'A12'),
    ('e81aa7b4-726a-4fdc-953b-b81104120ff6'::uuid, '4060dda0-4a88-492c-964c-4191654fc6a2'::uuid, 'A12'),
    ('9eb9b775-489e-4801-a010-41b3b8bbfeef'::uuid, '95dddca1-10a0-4cd5-848b-e2bd7205b2fa'::uuid, 'A12'),
    ('b9f74787-e5b1-4597-9584-755babf8458d'::uuid, '0cc4b6c2-d22d-4042-8cfa-f86668a7e5bd'::uuid, 'A12'),
    ('6d9d3a96-05f3-4bf1-a231-e04c352e0a40'::uuid, '3bc99bf6-1a37-47f5-a185-4aedf49ddbad'::uuid, 'A12'),
    ('9faf9ae5-1e25-49d7-8f4b-00930c363351'::uuid, '53642290-529a-404b-98eb-147337cfb2a5'::uuid, 'A12'),
    ('11122865-8eb7-40b9-a522-e6c49e1cca27'::uuid, NULL::uuid, 'A12'),
    ('fab23939-51ea-4d8a-a427-87de31c546e0'::uuid, 'd99c3173-a6c9-4168-af94-02e695cb398c'::uuid, 'A12'),
    ('51ac8da0-0a50-462c-b9a3-d38c0d14487e'::uuid, '9a9b927a-0818-4bcd-9f4c-bcd2bdec40ce'::uuid, 'A12'),
    ('fe79bd6a-f959-4d70-8046-5a90dbd484b1'::uuid, 'b33e0889-7f68-4bd0-becc-0fff87468330'::uuid, 'A12'),
    ('15cfbcce-3b17-495e-bfe8-cebf79a13f7c'::uuid, '344206e9-b027-45cd-a028-5f3aade13f12'::uuid, 'A12'),
    ('c48e3826-3c49-4323-a8d2-75200b1c87dc'::uuid, '881f546a-edb8-4d8e-af63-1ba9658e9083'::uuid, 'A12'),
    ('0adb2a3b-6fed-43d4-ae2f-06ef82a6e25f'::uuid, '8f8c61ee-b7a6-4a0a-a50a-5210489c81be'::uuid, 'A12'),
    ('59f36643-268c-47c2-a9d7-0ce1d42c7b52'::uuid, '4d4488f9-1fe8-41ac-96c0-1470a09dba58'::uuid, 'A12'),
    ('aec3dd25-002e-4af7-8105-f9c596c81583'::uuid, '4cf491c5-21b0-4366-9369-7a210b431013'::uuid, 'A12'),
    ('3594eee9-ed05-4eae-a01f-e48e11f27d2f'::uuid, '75ff4cdc-2f55-4fc0-9ce9-c6729afa6dac'::uuid, 'A12'),
    ('2699504c-53de-4415-a508-71828172e479'::uuid, '82ab5fc8-4399-42b8-b70c-e4b6d5dd1ee0'::uuid, 'A12'),
    ('fbab6aa0-08e4-4af4-a7f1-46aa24227974'::uuid, '8cd1f37f-4db7-43fb-9bb2-c86f898fe2b5'::uuid, 'A12'),
    ('8c845dc0-e644-4f86-ab36-614d62d561ab'::uuid, '4b4d8c8a-09a3-49c4-af42-5122693b9ef8'::uuid, 'A12'),
    ('4e4f878f-c61f-438a-8ba5-4942a50c03be'::uuid, NULL::uuid, 'A12'),
    ('d82378d6-f8d1-4d1a-9523-dda48542310f'::uuid, 'e4f53b28-c3f1-4676-8122-5c9002fe0d35'::uuid, 'A12'),
    ('6a78f458-d539-45d6-bb97-c29d1c25b920'::uuid, 'd9eaf7a6-99dc-4eab-8882-b197f7a054c6'::uuid, 'A12'),
    ('9e8f9263-e3ca-405b-8bef-1fa5002ea124'::uuid, '22e27241-f55a-4f26-a55b-a1032f21a288'::uuid, 'A12'),
    ('98a66c05-d53b-4c50-952f-d8b75e28a89b'::uuid, '3e020e70-b3fb-4c42-ad3b-4f181926d5ce'::uuid, 'A12'),
    ('ed33ae8b-c9e2-4eea-ae80-46c726830107'::uuid, 'c70edae6-f131-4304-98d1-36af8d0e8680'::uuid, 'A12'),
    ('6ecfe49f-af17-4599-bdf6-36a923cd8deb'::uuid, 'ded6710e-1a30-4f17-9f24-463de40081d4'::uuid, 'A12'),
    ('b8b473bc-31a1-480c-b54b-0758fb505efb'::uuid, 'cdd33740-b2ee-47ab-b49d-1c7a4e23db7b'::uuid, 'A12'),
    ('fe28fe0f-85a0-428f-a58c-305affed9178'::uuid, '223c0da2-15b9-4eb6-bb8b-84b47ad3c113'::uuid, 'A12'),
    ('d8c684e1-e0f6-4b56-982a-87c1ddaee3e5'::uuid, '00dc13dd-2f41-401b-acba-bcd29f06641d'::uuid, 'A12'),
    ('39976b64-2f4e-49ff-8887-7cf76d8b6286'::uuid, 'c800e2c6-171c-4f96-8740-931ddbe79786'::uuid, 'A12'),
    ('c5fb915f-d91e-486b-99e3-9e19a3060a0f'::uuid, '4b091cc0-6746-4fef-8ac1-f9fa4b1dc6bd'::uuid, 'A12'),
    ('93c2c020-983c-4439-a770-4de9316de4eb'::uuid, '00dd93f3-37f2-4ad7-bfc8-b4df2b63d25e'::uuid, 'A12'),
    ('bc9639a5-8330-4152-bc34-e57d42e322af'::uuid, 'e79e2001-f68d-4528-b74f-d0ef08145c57'::uuid, 'A12'),
    ('de704e19-2cb9-4da1-a03e-c4cd7859ed14'::uuid, 'bed0e4c8-e87d-414b-8332-3dae2e05eb4f'::uuid, 'A12'),
    ('957d8105-e630-4848-9a48-287726f182dc'::uuid, 'b8a443df-48cf-47b2-be06-3c3d9bbadaf2'::uuid, 'A12'),
    ('48c09a3f-b128-4671-8e01-8a9a88af429f'::uuid, 'bf923bdc-27a6-4a13-b1f0-f54dca6e5355'::uuid, 'A13'),
    ('13937b4d-65cb-4649-924d-57f88915cc14'::uuid, '66e3da4c-d593-46cc-961e-02fc4897cf10'::uuid, 'A12'),
    ('dea188e4-d340-4cca-b044-38bde1f11961'::uuid, '2d996922-8ccb-423c-a249-25efd3478827'::uuid, 'A12'),
    ('08f711e2-927a-43dd-bce0-73831c4dd16a'::uuid, 'dddc2333-efb2-4855-9ab7-f3d5c3793873'::uuid, 'A13'),
    ('9be1f0c5-c24a-4ea1-a4fc-c65fab57c2e0'::uuid, '54c4c664-6004-4aab-a56c-b285050633cd'::uuid, 'A13'),
    ('3a1b29b7-6eb0-4810-920f-ee38ec57b543'::uuid, '517f605f-b235-4528-8d0b-9e0c6889a6b4'::uuid, 'A12'),
    ('3c12f6b8-4286-457f-ab9f-6a2cf332b765'::uuid, '693f571d-6bdf-42c3-9240-1df54a77ad89'::uuid, 'A12'),
    ('041db80d-bf92-4424-88c4-0881a1846992'::uuid, '68471258-dcb1-4062-b5b7-03816ae9f280'::uuid, 'A12'),
    ('0a5990cd-2449-41ad-81dd-aab59a12d3e7'::uuid, '7fd0edc9-ca1c-4b14-bc71-1b44bdaf0b9b'::uuid, 'A12'),
    ('a3299284-8321-4d8d-aaac-5d924eaff8c2'::uuid, '3107bc48-7d50-4505-a14d-d5011166166e'::uuid, 'A12'),
    ('85a8a9c0-fb1d-48e9-ac3c-0f03bc8cc297'::uuid, '6681828a-7449-4af0-9e71-972d8ba54a98'::uuid, 'A12'),
    ('991c2de0-e926-4c16-9c2d-02c229620810'::uuid, '9a8b2824-1241-40a1-b2ec-77519a66d2d4'::uuid, 'A12'),
    ('396faf0c-120b-43e6-b971-e35f76c8a205'::uuid, 'bf40085c-dedc-44ef-9e38-d6170a57209a'::uuid, 'A12'),
    ('bad5e10b-bc0a-43ed-b62e-a9a7a27ba12e'::uuid, '882c5336-b5b0-4108-bbc3-11b004dde5c3'::uuid, 'A12'),
    ('b427081b-68dd-4af8-99af-a0ecb11a80b4'::uuid, 'dc61a02a-1d28-47b7-8171-853f4520c439'::uuid, 'A12'),
    ('bfadf1bb-802a-4248-b06d-bbecdbc5a1cb'::uuid, '6491cc32-a61e-425f-845d-cf00a963d156'::uuid, 'A12'),
    ('c5c70974-6cc6-4132-99e1-f91a9a81c055'::uuid, 'c7f03cba-8764-4b35-94ab-d01f2c4b9e59'::uuid, 'A12'),
    ('eab6500c-cec5-401b-afc1-d20eac6ec378'::uuid, '9bc4e223-3f86-4b61-bc46-11904d443c58'::uuid, 'A12'),
    ('f35d6434-6fff-4ff8-b352-38586363ccd0'::uuid, 'eae7ab9d-769d-49b8-9bfb-c5ea000948da'::uuid, 'A12'),
    ('3c285b40-c3b8-4219-92be-6eabed01bfd5'::uuid, 'c3b415c8-8a57-4140-ab5f-332749c91c57'::uuid, 'A12'),
    ('6f2e1a32-9914-4610-9336-0945332fee59'::uuid, '87811383-cbe3-43de-b525-4de7064191d2'::uuid, 'A12'),
    ('fdb05fd5-e17c-49b6-a1f9-dd1d238edb85'::uuid, '3a82618b-7d49-4015-ad72-7a1e06dbb5ab'::uuid, 'A12'),
    ('cfd13149-2688-4f30-a160-5868ea0d901e'::uuid, 'a8ddec04-4fcb-412c-acb9-b0af8b7e0f99'::uuid, 'A12'),
    ('bf02eb5f-ffd1-4df0-ad18-b5ee0dd24d9d'::uuid, 'e97a4a6a-d518-4dee-9279-201b31144659'::uuid, 'A12'),
    ('c75a2acc-6dcf-47ba-bce3-2213bfb40ad1'::uuid, '9b704619-2d97-44cb-a61e-5ba7ac6525f6'::uuid, 'A12'),
    ('a3bdb250-ba3c-4c8e-bec6-a438a062cf97'::uuid, '85bce373-09ee-4d15-b130-8380e81fea0a'::uuid, 'A12'),
    ('b8ced835-c5f8-4660-b6a2-51362cc9cc7e'::uuid, 'dbce884d-3159-4682-81e7-73f4bbc7f367'::uuid, 'A12'),
    ('71570ebd-b43a-4dd6-8f96-e7b0ab982475'::uuid, '27842d46-9467-4852-853e-c4100fbbc516'::uuid, 'A13'),
    ('16a47f1c-07e8-47bb-ac44-dd8bbd18ebcb'::uuid, '893e5dde-cad2-4745-a607-5b94d9e087a4'::uuid, 'A12'),
    ('d8bbd824-7a74-4f79-acdb-3ef542558cfc'::uuid, '97534451-ca4e-42e1-9f49-d45fd44031f9'::uuid, 'A12'),
    ('a238c808-c566-473d-8094-4b25731c021a'::uuid, '136b32fb-5b28-496d-96d4-ba2eb3b9f8bb'::uuid, 'A12'),
    ('bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9'::uuid, 'a3228b88-6f28-459b-9ef4-48bfd11d3e44'::uuid, 'A13'),
    ('673c0f25-1ec1-4824-aed9-f4e8c18db472'::uuid, '3d11c494-31b9-468a-a638-24921a83a0b5'::uuid, 'A12'),
    ('93d95269-34da-45f0-9845-fff6b7312220'::uuid, 'a544f375-e454-4ed6-a794-81a500916c8a'::uuid, 'A13'),
    ('9feb42a7-f2c5-4239-85dc-77c349d6e808'::uuid, '548c49eb-d62b-4901-a3dd-7f745377a469'::uuid, 'A12'),
    ('86042e77-62c4-49b6-824d-5ac162cbc4ad'::uuid, '0a128951-9353-47c3-b51a-203e257ab582'::uuid, 'A12'),
    ('1cab4fe8-136d-493b-b74c-d9ac28e4e77c'::uuid, '561e4919-4a93-4961-a33f-5900d0f11276'::uuid, 'A12'),
    ('973c6ecb-3c1a-4f3d-8471-106fc460aec7'::uuid, 'c60db3db-334d-453e-89b8-aa1557535778'::uuid, 'A12'),
    ('f055c5bb-cbc4-4ce7-9dc9-dd4c5f66fdb1'::uuid, '8c6a5ae9-8b38-42cd-a8aa-486dc95a298e'::uuid, 'A12'),
    ('2edc40be-671b-4b1f-a00e-cb0e71b08482'::uuid, NULL::uuid, 'A13'),
    ('bc2acdbe-8e2c-4c90-aab4-5e922bf50c93'::uuid, NULL::uuid, 'A13'),
    ('c95555c7-6363-4f09-b7c4-220a272db6ab'::uuid, NULL::uuid, 'A13')
), item_groups AS MATERIALIZED (
  SELECT DISTINCT i.plan_id, g.transaction_group_id gid FROM items i
  JOIN public.general_ledger g ON g.source_id IN (i.plan_id, i.sale_id) OR g.reference_id IN (i.plan_id::text, i.sale_id::text)
  UNION
  SELECT DISTINCT i.plan_id, x.transaction_group_id FROM items i
  JOIN public.general_ledger g ON g.source_id IN (i.plan_id, i.sale_id) OR g.reference_id IN (i.plan_id::text, i.sale_id::text)
  JOIN public.general_ledger x ON x.reference_id = g.transaction_group_id::text AND x.transaction_group_id <> g.transaction_group_id
), res AS MATERIALIZED (
  SELECT s.transaction_group_id gid, s.account_code acct, sum(s.dr - s.cr) net FROM public.sofp_ledger_legs(now()) s
  WHERE s.transaction_group_id IN (SELECT gid FROM item_groups) AND s.account_code IN ('A12', 'A13') GROUP BY 1, 2
), now_bal AS (
  SELECT i.plan_id, i.acct, COALESCE(sum(r.net), 0) bal FROM items i LEFT JOIN item_groups ig ON ig.plan_id = i.plan_id
  LEFT JOIN res r ON r.gid = ig.gid AND r.acct = i.acct GROUP BY 1, 2
), adj AS (
  SELECT plan_id::uuid plan_id, sum(CASE WHEN side = 'DR' THEN amount ELSE -amount END) FILTER (WHERE leg_acct = acct) d FROM planned GROUP BY 1
)
SELECT json_build_object(
  'as_at', now(),
  'evidence_failures', (SELECT json_agg(c) FROM checks c WHERE NOT c.evidence_ok),
  'evidence_checked', (SELECT count(*) FROM checks),
  'already_applied', EXISTS (SELECT 1 FROM public.general_ledger WHERE left(COALESCE(idempotency_key, ''), 34) = 'merch_a12_a13_correction_20261104:'),
  'groups', (SELECT count(DISTINCT n) FROM planned),
  'groups_balanced', (SELECT bool_and(ok) FROM (SELECT n, sum(CASE WHEN side = 'DR' THEN amount ELSE -amount END) = 0
       AND sum(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END) = 0 AS ok FROM planned GROUP BY n) z),
  'by_account', (SELECT json_object_agg(leg_acct, net) FROM (SELECT leg_acct, sum(CASE WHEN side = 'DR' THEN amount ELSE -amount END) net FROM planned GROUP BY 1) z),
  'by_code', (SELECT json_object_agg(code, n) FROM (SELECT code, count(DISTINCT n) n FROM planned GROUP BY 1) z),
  'legs', (SELECT json_agg(p ORDER BY p.n, p.side) FROM planned p),
  'items', (SELECT json_agg(json_build_object('plan', b.plan_id, 'acct', b.acct, 'now', b.bal, 'adjust', COALESCE(a.d, 0), 'after', b.bal + COALESCE(a.d, 0)) ORDER BY b.acct, b.plan_id)
            FROM now_bal b LEFT JOIN adj a ON a.plan_id = b.plan_id),
  'ledger_now', (SELECT json_object_agg(account_code, n) FROM (SELECT account_code, sum(dr - cr) n FROM public.sofp_ledger_legs(now()) WHERE account_code IN ('A12', 'A13') GROUP BY 1) z)
) AS dry_run;
