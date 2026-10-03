-- ============================================================================
-- Stage 14D — Batch 1 correction executor (APPROVAL-GATED)
-- STATUS: PENDING REVIEW. NOT APPLIED. NOT REGISTERED IN THE MIGRATION JOURNAL.
--
-- Preview and production share ONE database, so applying this file IS a
-- production change. It must not be applied until the CFO approves the code,
-- and creating these objects moves no money by itself. Money moves only when
-- cfo_s14b1_execute(<approval_id>, true, <phrase>, <fingerprint>) is called by the Batch 1 executor after
-- cfo_s14b1_approve() has recorded an approval for the exact fingerprint.
--
-- Frozen package: version s14b1-v2 (regenerated 2026-10-03 18:25 UTC from a fresh snapshot; supersedes s14b1-v1 / 274de655…, now stale), 20 collections (UGX 483,685),
-- 20 cash entries + 13 commission entries = 33 entries / 66 legs,
-- debits = credits = UGX 523,085.42, 13 Rent Plans (UGX 479,685).
-- Fingerprint (sha256): 274de6552922cbdc2f7d346903ef5ac0300681646fd6e35f9b781959e422a385
-- (Rebuilt 2026-10-03: commission contra leg relabelled system_balance_correction -> agent_commission_earned; supersedes 16d1ae84...)
-- Held open (NOT in this package, no transaction of any kind): UGX 6,132.40
--   status "Held Open — Unrecoverable at Current Wallet Balance" — not recovered,
--   not written off, not moved, not expensed.
-- Single-CFO workflow (2026-10-03): the approving CFO may also execute, but only
-- Angwen Sarah's account (29a0cfa8-…) may execute this Batch 1 tool, only between
-- 5 minutes and 24 hours after approval, and only with the typed phrase
-- 'EXECUTE BATCH 1 CORRECTION' plus the fingerprint supplied again. Approval never
-- accepts the phrase and never executes. is_cfo_approver is NOT changed.
-- Audit/event identifier: ACCOUNTING_CORRECTION_BATCH_1_DUPLICATE_COLLECTIONS
-- Recruiter commission (UGX 2,835.68) and unrecoverable collecting commission
-- (UGX 6,132.40) have NO lines: they are neither recovered nor written off.
-- ============================================================================

-- 1. Frozen package (append-only) --------------------------------------------
CREATE TABLE public.fin_s14b1_package_lines (
  entry_key            text PRIMARY KEY,
  kind                 text NOT NULL CHECK (kind IN ('cash','commission')),
  case_position        int  NOT NULL,
  collection_id        uuid NOT NULL,
  rent_request_id      uuid NOT NULL,
  recipient_user_id    uuid,
  origin_group_id      uuid NOT NULL,
  origin_leg_ids       text NOT NULL,
  debit_account        text NOT NULL,
  credit_account       text NOT NULL,
  amount               numeric(18,2) NOT NULL CHECK (amount > 0),
  origin_leg_amount    numeric(18,2)
);
CREATE TABLE public.fin_s14b1_package_plans (
  rent_request_id      uuid PRIMARY KEY,
  amount_repaid_before numeric(18,2) NOT NULL,
  total_repayment      numeric(18,2) NOT NULL,
  status_before        text NOT NULL,
  restore_amount       numeric(18,2) NOT NULL CHECK (restore_amount > 0),
  amount_repaid_after  numeric(18,2) NOT NULL CHECK (amount_repaid_after >= 0),
  status_after         text NOT NULL
);
CREATE TABLE public.fin_s14b1_approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_version  text NOT NULL,
  package_hash     text NOT NULL,
  approved_by      uuid NOT NULL,
  approved_at      timestamptz NOT NULL DEFAULT now(),
  approved_totals  jsonb NOT NULL,
  reason           text NOT NULL CHECK (length(btrim(reason)) >= 10),
  executed_at      timestamptz,
  executed_by      uuid,
  execution_result jsonb
);
CREATE UNIQUE INDEX fin_s14b1_one_execution ON public.fin_s14b1_approvals ((true)) WHERE executed_at IS NOT NULL;

GRANT SELECT ON public.fin_s14b1_package_lines, public.fin_s14b1_package_plans, public.fin_s14b1_approvals TO authenticated;
GRANT ALL ON public.fin_s14b1_package_lines, public.fin_s14b1_package_plans, public.fin_s14b1_approvals TO service_role;
ALTER TABLE public.fin_s14b1_package_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_s14b1_package_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_s14b1_approvals     ENABLE ROW LEVEL SECURITY;
CREATE POLICY s14b1_lines_cfo ON public.fin_s14b1_package_lines FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));
CREATE POLICY s14b1_plans_cfo ON public.fin_s14b1_package_plans FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));
CREATE POLICY s14b1_appr_cfo  ON public.fin_s14b1_approvals     FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));

INSERT INTO public.fin_s14b1_package_lines
 (entry_key,kind,case_position,collection_id,rent_request_id,recipient_user_id,origin_group_id,origin_leg_ids,debit_account,credit_account,amount,origin_leg_amount) VALUES
  ('s14b1:05dbd02c-720e-465b-9eb3-cdb60a35420f:receipt','cash',7,'05dbd02c-720e-465b-9eb3-cdb60a35420f'::uuid,'090754f1-99eb-4f45-9493-a1fdc0cb3906'::uuid,NULL::uuid,'2985ae1c-31a9-42e2-b3aa-47a44316b6f0'::uuid,'ef565ef6-7215-42af-925a-e4dfddb8823a,39c51013-b54f-45a0-b218-be0b32a9fe0d','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',10000.00,NULL),
  ('s14b1:122ed10b-942f-4516-9921-a82b369c98c9:receipt','cash',11,'122ed10b-942f-4516-9921-a82b369c98c9'::uuid,'7dc8482b-85ef-4d40-b08f-d6e04745af92'::uuid,NULL::uuid,'7b08df89-1c5e-4d7c-8a66-399551942d3e'::uuid,'c8a060bd-f6e1-4cbc-8d2e-5b2b3d950104,f6a5a5d0-84d7-4bea-b2db-23cc3f92c368','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',9200.00,NULL),
  ('s14b1:267072bb-0d2c-48bd-ae25-f954a982bae1:receipt','cash',16,'267072bb-0d2c-48bd-ae25-f954a982bae1'::uuid,'1240a589-088c-43e3-aee0-3dfab6ea576f'::uuid,NULL::uuid,'0c063a63-de80-482d-bb3c-0eefef2bd558'::uuid,'5fda10ac-46ac-4cd4-b5cd-5aa163823a42,7cde5a21-3c44-4ffb-9193-4b36aa31abbc','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',13967.00,NULL),
  ('s14b1:298d14ff-6bf5-4702-8642-147de0a414fb:commission','commission',11,'122ed10b-942f-4516-9921-a82b369c98c9'::uuid,'7dc8482b-85ef-4d40-b08f-d6e04745af92'::uuid,'e1bb1b7c-14a6-4a25-a82c-dffe345b7170'::uuid,'7b08df89-1c5e-4d7c-8a66-399551942d3e'::uuid,'298d14ff-6bf5-4702-8642-147de0a414fb','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',736.00,736.00),
  ('s14b1:2c370a19-60b4-4193-b376-520cb9f4717a:commission','commission',16,'267072bb-0d2c-48bd-ae25-f954a982bae1'::uuid,'1240a589-088c-43e3-aee0-3dfab6ea576f'::uuid,'dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa'::uuid,'0c063a63-de80-482d-bb3c-0eefef2bd558'::uuid,'2c370a19-60b4-4193-b376-520cb9f4717a','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',1396.70,1396.70),
  ('s14b1:31ebfec0-171b-417d-9658-b62f2cbcb683:commission','commission',14,'38b9135a-92ba-4b4e-a46a-57c6f99ef3fc'::uuid,'1240a589-088c-43e3-aee0-3dfab6ea576f'::uuid,'dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa'::uuid,'6ab92af7-a5ee-46d7-bf68-12a1d93f74ab'::uuid,'31ebfec0-171b-417d-9658-b62f2cbcb683','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',1396.70,1396.70),
  ('s14b1:38b9135a-92ba-4b4e-a46a-57c6f99ef3fc:receipt','cash',14,'38b9135a-92ba-4b4e-a46a-57c6f99ef3fc'::uuid,'1240a589-088c-43e3-aee0-3dfab6ea576f'::uuid,NULL::uuid,'6ab92af7-a5ee-46d7-bf68-12a1d93f74ab'::uuid,'030ada49-836d-4430-b142-3b34dc4c5d31,9dce5544-274e-4944-9487-934ba3f3b783','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',13967.00,NULL),
  ('s14b1:45ebae2e-dfd6-4e92-8495-155fad2cd8cf:commission','commission',20,'57b8065f-acf1-4e00-986d-8279dcc69926'::uuid,'2ca84e52-973b-4ed6-a5b8-5bc28ba6cd84'::uuid,'dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa'::uuid,'214acc5c-7b94-483c-828e-7dcb4a08e153'::uuid,'45ebae2e-dfd6-4e92-8495-155fad2cd8cf','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',10000.00,10000.00),
  ('s14b1:48153fbd-3786-4dd6-9826-967c2af0c71a:receipt','cash',9,'48153fbd-3786-4dd6-9826-967c2af0c71a'::uuid,'9256fe0a-b320-4c84-9212-f645ef5a422b'::uuid,NULL::uuid,'a80559ed-201c-450d-b219-c77741e6931f'::uuid,'01578c7d-2def-41b2-9bf2-161a22829108,51444d11-65bd-4ef6-8eaf-40835c91f065','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',10000.00,NULL),
  ('s14b1:57b8065f-acf1-4e00-986d-8279dcc69926:receipt','cash',20,'57b8065f-acf1-4e00-986d-8279dcc69926'::uuid,'2ca84e52-973b-4ed6-a5b8-5bc28ba6cd84'::uuid,NULL::uuid,'214acc5c-7b94-483c-828e-7dcb4a08e153'::uuid,'8346b185-863d-43a9-a7c5-da9b039e18e0,6fa036d4-719b-4066-a0cd-0ccb737fa739','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',100000.00,NULL),
  ('s14b1:66270144-9167-4105-8b65-48641d010e41:commission','commission',9,'48153fbd-3786-4dd6-9826-967c2af0c71a'::uuid,'9256fe0a-b320-4c84-9212-f645ef5a422b'::uuid,'d5304353-9b99-42e5-bcda-28ba96cc0bbc'::uuid,'a80559ed-201c-450d-b219-c77741e6931f'::uuid,'66270144-9167-4105-8b65-48641d010e41','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',800.00,800.00),
  ('s14b1:68339a67-5b41-42aa-995d-68c76ebce18d:commission','commission',13,'918490bf-4ce5-4136-8c4f-1eeb5ce31fe6'::uuid,'9256fe0a-b320-4c84-9212-f645ef5a422b'::uuid,'d5304353-9b99-42e5-bcda-28ba96cc0bbc'::uuid,'fa56fc7e-12cf-4d76-a62c-80558ceb1abe'::uuid,'68339a67-5b41-42aa-995d-68c76ebce18d','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',800.00,800.00),
  ('s14b1:72dd634c-49ba-4733-95ac-f0ff8921d792:receipt','cash',6,'72dd634c-49ba-4733-95ac-f0ff8921d792'::uuid,'1019b84b-b964-4d38-a97e-5d56978499e0'::uuid,NULL::uuid,'b86ce6e0-9859-4790-8564-a7c4721ad57d'::uuid,'10c3b9d2-c8d1-4fc7-ab37-92106dbe2765,d840111b-ea8b-4d78-a16c-ac0aa1b98e58','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',9000.00,NULL),
  ('s14b1:74cfb3aa-9941-45c9-90de-591f700fab29:receipt','cash',18,'74cfb3aa-9941-45c9-90de-591f700fab29'::uuid,'3948339e-609c-4bc2-bf1f-cea49ff2be2c'::uuid,NULL::uuid,'06b490fc-6de4-405b-ad4e-c354998f1f57'::uuid,'d3767688-1656-4614-afa4-c3975b6c7c77,d7ae716c-937d-4102-a0a8-cd4f5ea22049','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',100000.00,NULL),
  ('s14b1:75d0e6ec-aa79-4334-836a-582307c268de:receipt','cash',17,'75d0e6ec-aa79-4334-836a-582307c268de'::uuid,'5dd7fff9-258c-4c12-98f9-0693a9cb8ec3'::uuid,NULL::uuid,'a0497bd7-25b0-427d-bc07-2f19190c6ecd'::uuid,'149ac11d-d52a-496d-8c8a-cd64fa621328,017b7772-f327-4202-864b-938f82899330','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',13967.00,NULL),
  ('s14b1:7b405673-db1c-421f-85d8-074a5c2dd598:receipt','cash',1,'7b405673-db1c-421f-85d8-074a5c2dd598'::uuid,'be7f78ad-1b16-4c7f-ba23-5af2886fd9a6'::uuid,NULL::uuid,'8036a0e6-6d50-4c50-84eb-1622769f2698'::uuid,'fdf884c2-0db2-4f4c-aafe-1ddc8560009a,37d363c8-0702-49fe-8f9d-f690ecc8cacf','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',11000.00,NULL),
  ('s14b1:88e42817-d3cc-4a82-8472-325d5f456be6:receipt','cash',5,'88e42817-d3cc-4a82-8472-325d5f456be6'::uuid,'1019b84b-b964-4d38-a97e-5d56978499e0'::uuid,NULL::uuid,'4af0966a-1408-4955-a780-628b6c85c27a'::uuid,'bcfa7e5e-9106-4191-9d89-028e5d7e7a6b,9005aefc-5d97-415a-afb2-b59708de1fb9','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',9000.00,NULL),
  ('s14b1:8c55afd2-07ac-4076-b0a7-f520e187980b:receipt','cash',3,'8c55afd2-07ac-4076-b0a7-f520e187980b'::uuid,'1019b84b-b964-4d38-a97e-5d56978499e0'::uuid,NULL::uuid,'837eb140-7c92-41ab-b783-0ec3012ce4f2'::uuid,'370a1b8a-1bcc-4834-9448-e58bc55d24bf,90ae39b6-1b4c-4b16-98bd-6c513431e24a','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',9000.00,NULL),
  ('s14b1:8f8c5943-a943-4a78-bb14-ea3d60b87ff2:receipt','cash',10,'8f8c5943-a943-4a78-bb14-ea3d60b87ff2'::uuid,'cd49828e-3635-4631-a015-5676342a9e4f'::uuid,NULL::uuid,'3b1bbfdc-d9a2-4983-bc3f-8a0174d70907'::uuid,'d180fbed-d1d1-4c83-8b12-fa8ff4458e8a,45fb76fb-a7b5-455c-91b2-0ea8f68768df','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',6984.00,NULL),
  ('s14b1:918490bf-4ce5-4136-8c4f-1eeb5ce31fe6:receipt','cash',13,'918490bf-4ce5-4136-8c4f-1eeb5ce31fe6'::uuid,'9256fe0a-b320-4c84-9212-f645ef5a422b'::uuid,NULL::uuid,'fa56fc7e-12cf-4d76-a62c-80558ceb1abe'::uuid,'74411360-c383-4d49-bc96-80dc461cd8b2,cb8781a2-d223-4eff-ae76-aa99a2403b69','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',10000.00,NULL),
  ('s14b1:91e20d2a-26f5-48ed-8455-2f4d2ce31e00:commission','commission',19,'d8e2e9f6-fce4-4909-8270-90da797463ec'::uuid,'0b0b7e91-0765-4527-93aa-633828f5753a'::uuid,'dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa'::uuid,'69d4dd7e-26de-4cb6-b54d-b1637acc4b23'::uuid,'91e20d2a-26f5-48ed-8455-2f4d2ce31e00','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',10000.00,10000.00),
  ('s14b1:99b812dd-ba69-4a66-b848-105cf18021b2:receipt','cash',2,'99b812dd-ba69-4a66-b848-105cf18021b2'::uuid,'1019b84b-b964-4d38-a97e-5d56978499e0'::uuid,NULL::uuid,'58e62873-67a8-4187-83c0-fa07e35f3151'::uuid,'c18a10d1-3ac5-4c5c-8d31-c738f405a4bd,6689adbf-50ae-46c3-bf92-48283032165c','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',9000.00,NULL),
  ('s14b1:a3e3bbc5-c1ca-418e-9e4b-54ccf2239ac2:receipt','cash',4,'a3e3bbc5-c1ca-418e-9e4b-54ccf2239ac2'::uuid,'be7f78ad-1b16-4c7f-ba23-5af2886fd9a6'::uuid,NULL::uuid,'909a97aa-9969-45fd-9780-2e82fc73d24f'::uuid,'423bb9ec-3571-455c-bd69-3273f695bc61,55c22d9c-2677-4e80-87d2-3a6608d516bf','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',11000.00,NULL),
  ('s14b1:af05652d-1fdb-4916-8f91-8bf2b9f238a6:commission','commission',7,'05dbd02c-720e-465b-9eb3-cdb60a35420f'::uuid,'090754f1-99eb-4f45-9493-a1fdc0cb3906'::uuid,'d5304353-9b99-42e5-bcda-28ba96cc0bbc'::uuid,'2985ae1c-31a9-42e2-b3aa-47a44316b6f0'::uuid,'af05652d-1fdb-4916-8f91-8bf2b9f238a6','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',800.00,800.00),
  ('s14b1:b8f8f6d9-0fdf-42dd-810c-e09d3f71f079:commission','commission',10,'8f8c5943-a943-4a78-bb14-ea3d60b87ff2'::uuid,'cd49828e-3635-4631-a015-5676342a9e4f'::uuid,'e1bb1b7c-14a6-4a25-a82c-dffe345b7170'::uuid,'3b1bbfdc-d9a2-4983-bc3f-8a0174d70907'::uuid,'b8f8f6d9-0fdf-42dd-810c-e09d3f71f079','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',558.72,558.72),
  ('s14b1:c409aff9-d0a9-48df-a4b0-4b896f6d35f5:commission','commission',17,'75d0e6ec-aa79-4334-836a-582307c268de'::uuid,'5dd7fff9-258c-4c12-98f9-0693a9cb8ec3'::uuid,'dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa'::uuid,'a0497bd7-25b0-427d-bc07-2f19190c6ecd'::uuid,'c409aff9-d0a9-48df-a4b0-4b896f6d35f5','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',1396.70,1396.70),
  ('s14b1:d194258c-eee4-431b-bb5b-2655fe8b5928:commission','commission',18,'74cfb3aa-9941-45c9-90de-591f700fab29'::uuid,'3948339e-609c-4bc2-bf1f-cea49ff2be2c'::uuid,'dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa'::uuid,'06b490fc-6de4-405b-ad4e-c354998f1f57'::uuid,'d194258c-eee4-431b-bb5b-2655fe8b5928','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',10000.00,10000.00),
  ('s14b1:d46fe205-b52f-4795-ab84-8cac0fe15915:receipt','cash',12,'d46fe205-b52f-4795-ab84-8cac0fe15915'::uuid,'9d4e941e-1cfc-4506-a554-5af3d5daca5e'::uuid,NULL::uuid,'414658b4-11d9-49f9-9bc8-e36d2cbb22a5'::uuid,'f6ee0fc4-2ec5-479a-9b82-fe094e22e9f7,344cd3b2-537f-4a8a-85c0-bea7f5bdf0cf','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',18400.00,NULL),
  ('s14b1:d8e2e9f6-fce4-4909-8270-90da797463ec:receipt','cash',19,'d8e2e9f6-fce4-4909-8270-90da797463ec'::uuid,'0b0b7e91-0765-4527-93aa-633828f5753a'::uuid,NULL::uuid,'69d4dd7e-26de-4cb6-b54d-b1637acc4b23'::uuid,'432f9463-6beb-48dd-9b97-b91b1c3cff5b,4e0acbcf-0395-44bf-ac55-a39696003938','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',100000.00,NULL),
  ('s14b1:ddb33eb4-6f79-4212-af65-bd587a927dc1:receipt','cash',15,'ddb33eb4-6f79-4212-af65-bd587a927dc1'::uuid,'b76711ef-9574-49c0-b02b-57b1133c4d38'::uuid,NULL::uuid,'cd8f32da-289d-400e-b44e-1775a0686a93'::uuid,'a9c9479f-7832-4672-92fd-27875018920f,45ac16cd-064e-4d06-a052-cb00833f3379','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',9200.00,NULL),
  ('s14b1:e272754e-c6bd-4fe4-9f32-f33653322774:receipt','cash',8,'e272754e-c6bd-4fe4-9f32-f33653322774'::uuid,'090754f1-99eb-4f45-9493-a1fdc0cb3906'::uuid,NULL::uuid,'86e4148d-b628-4d83-8396-36fccb94ae8a'::uuid,'76376a3d-b0c8-4da6-b940-ff43ba849e58,1af0131b-b172-4465-b177-145816225492','tenant_repayment_collected/platform/cash_in','cash_receipt_in_transit/platform/cash_out',10000.00,NULL),
  ('s14b1:f110f18e-9165-4e09-9f7f-96e2fe76ba49:commission','commission',12,'d46fe205-b52f-4795-ab84-8cac0fe15915'::uuid,'9d4e941e-1cfc-4506-a554-5af3d5daca5e'::uuid,'e1bb1b7c-14a6-4a25-a82c-dffe345b7170'::uuid,'414658b4-11d9-49f9-9bc8-e36d2cbb22a5'::uuid,'f110f18e-9165-4e09-9f7f-96e2fe76ba49','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',715.60,1472.00),
  ('s14b1:f52b56cf-740d-4764-9f51-ba396c056c07:commission','commission',8,'e272754e-c6bd-4fe4-9f32-f33653322774'::uuid,'090754f1-99eb-4f45-9493-a1fdc0cb3906'::uuid,'d5304353-9b99-42e5-bcda-28ba96cc0bbc'::uuid,'86e4148d-b628-4d83-8396-36fccb94ae8a'::uuid,'f52b56cf-740d-4764-9f51-ba396c056c07','system_balance_correction/wallet/cash_out','agent_commission_earned/platform/cash_in',800.00,800.00);

INSERT INTO public.fin_s14b1_package_plans
 (rent_request_id,amount_repaid_before,total_repayment,status_before,restore_amount,amount_repaid_after,status_after) VALUES
  ('090754f1-99eb-4f45-9493-a1fdc0cb3906'::uuid,137231.00,143000.00,'repaying',20000.00,117231.00,'repaying'),
  ('0b0b7e91-0765-4527-93aa-633828f5753a'::uuid,389000.00,419000.00,'repaying',100000.00,289000.00,'repaying'),
  ('1019b84b-b964-4d38-a97e-5d56978499e0'::uuid,128500.00,352500.00,'repaying',36000.00,92500.00,'repaying'),
  ('1240a589-088c-43e3-aee0-3dfab6ea576f'::uuid,361000.00,419000.00,'repaying',27934.00,333066.00,'repaying'),
  ('2ca84e52-973b-4ed6-a5b8-5bc28ba6cd84'::uuid,419000.00,419000.00,'completed',96000.00,323000.00,'repaying'),
  ('3948339e-609c-4bc2-bf1f-cea49ff2be2c'::uuid,238793.00,419000.00,'repaying',100000.00,138793.00,'repaying'),
  ('5dd7fff9-258c-4c12-98f9-0693a9cb8ec3'::uuid,325000.00,419000.00,'repaying',13967.00,311033.00,'repaying'),
  ('7dc8482b-85ef-4d40-b08f-d6e04745af92'::uuid,276000.00,276000.00,'completed',9200.00,266800.00,'repaying'),
  ('9256fe0a-b320-4c84-9212-f645ef5a422b'::uuid,99920.00,209500.00,'repaying',20000.00,79920.00,'repaying'),
  ('9d4e941e-1cfc-4506-a554-5af3d5daca5e'::uuid,234189.00,552000.00,'repaying',18400.00,215789.00,'repaying'),
  ('b76711ef-9574-49c0-b02b-57b1133c4d38'::uuid,101600.00,276000.00,'repaying',9200.00,92400.00,'repaying'),
  ('be7f78ad-1b16-4c7f-ba23-5af2886fd9a6'::uuid,276000.00,276000.00,'completed',22000.00,254000.00,'repaying'),
  ('cd49828e-3635-4631-a015-5676342a9e4f'::uuid,60888.00,209500.00,'repaying',6984.00,53904.00,'repaying');

-- Package rows are frozen: no UPDATE/DELETE ever; approvals may only gain execution stamps once.
CREATE OR REPLACE FUNCTION public.fin_s14b1_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $f$
BEGIN
  IF TG_TABLE_NAME = 'fin_s14b1_approvals' AND TG_OP = 'UPDATE' THEN
    IF OLD.executed_at IS NULL AND NEW.executed_at IS NOT NULL
       AND (NEW.id, NEW.package_version, NEW.package_hash, NEW.approved_by, NEW.approved_at, NEW.approved_totals, NEW.reason)
         = (OLD.id, OLD.package_version, OLD.package_hash, OLD.approved_by, OLD.approved_at, OLD.approved_totals, OLD.reason)
       AND current_setting('s14b1.executing', true) = 'on' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'S14B1_FROZEN: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $f$;
CREATE TRIGGER trg_s14b1_lines_frozen BEFORE UPDATE OR DELETE ON public.fin_s14b1_package_lines FOR EACH ROW EXECUTE FUNCTION public.fin_s14b1_freeze();
CREATE TRIGGER trg_s14b1_plans_frozen BEFORE UPDATE OR DELETE ON public.fin_s14b1_package_plans FOR EACH ROW EXECUTE FUNCTION public.fin_s14b1_freeze();
CREATE TRIGGER trg_s14b1_appr_frozen  BEFORE UPDATE OR DELETE ON public.fin_s14b1_approvals     FOR EACH ROW EXECUTE FUNCTION public.fin_s14b1_freeze();
CREATE OR REPLACE FUNCTION public.fin_s14b1_no_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $f$
BEGIN RAISE EXCEPTION 'S14B1_FROZEN: package rows cannot be added'; END $f$;
CREATE TRIGGER trg_s14b1_lines_noins AFTER INSERT ON public.fin_s14b1_package_lines FOR EACH STATEMENT EXECUTE FUNCTION public.fin_s14b1_no_insert();
CREATE TRIGGER trg_s14b1_plans_noins AFTER INSERT ON public.fin_s14b1_package_plans FOR EACH STATEMENT EXECUTE FUNCTION public.fin_s14b1_no_insert();
-- (These two INSERT blockers are created AFTER the seed above, so they block every later insert.)

-- 2. Fingerprint of the frozen package -------------------------------------
CREATE OR REPLACE FUNCTION public.fin_s14b1_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT encode(sha256(convert_to(
    's14b1-v2' || '|' ||
    (SELECT string_agg(entry_key||';'||kind||';'||collection_id||';'||rent_request_id||';'||coalesce(recipient_user_id::text,'')||';'||
                       origin_leg_ids||';'||debit_account||';'||credit_account||';'||amount::numeric(18,2)::text, '|' ORDER BY entry_key)
       FROM public.fin_s14b1_package_lines) || '|' ||
    (SELECT string_agg('plan;'||rent_request_id||';'||amount_repaid_before::numeric(18,2)::text||';'||status_before||';'||
                       restore_amount::numeric(18,2)::text||';'||amount_repaid_after::numeric(18,2)::text||';'||status_after, '|' ORDER BY rent_request_id)
       FROM public.fin_s14b1_package_plans), 'UTF8')), 'hex')
$f$;
-- The hashed string is built exactly as in the Stage 14 review (tag 's14b1-v2').
-- The constant below is what fin_s14b1_fingerprint() must return; it is re-checked at apply time.

-- 3. Live validation (read-only; returns every check) ----------------------
CREATE OR REPLACE FUNCTION public.fin_s14b1_validate() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $f$
DECLARE
  v jsonb := '{}'::jsonb; ok boolean := true; n int; s numeric; bad int;
BEGIN
  -- Package shape
  SELECT count(*), sum(amount) INTO n, s FROM fin_s14b1_package_lines;
  v := v || jsonb_build_object('entries', n, 'lines', n*2, 'total', s);
  ok := ok AND n = 33 AND s = 523085.42;
  SELECT count(*), sum(amount) INTO n, s FROM fin_s14b1_package_lines WHERE kind='cash';
  ok := ok AND n = 20 AND s = 483685;
  SELECT count(*), sum(amount) INTO n, s FROM fin_s14b1_package_lines WHERE kind='commission';
  ok := ok AND n = 13 AND s = 39400.42;
  SELECT count(*), sum(restore_amount) INTO n, s FROM fin_s14b1_package_plans;
  ok := ok AND n = 13 AND s = 479685;

  -- Collections: same 20, still in frozen Stage 14 batch 1, unreversed, same amounts
  SELECT count(*) INTO bad FROM fin_s14b1_package_lines l
   WHERE l.kind='cash' AND NOT EXISTS (
     SELECT 1 FROM agent_collections ac JOIN fin_s14_batch_cases b ON b.collection_id=ac.id AND b.batch_no=1
      JOIN fin_s14_cases c ON c.collection_id=ac.id AND c.case_type='duplicate'
      WHERE ac.id=l.collection_id AND ac.reversed_at IS NULL AND ac.amount=l.amount AND ac.rent_request_id=l.rent_request_id);
  v := v || jsonb_build_object('collections_invalid', bad); ok := ok AND bad = 0;
  SELECT count(*) INTO n FROM fin_s14_batch_cases WHERE batch_no=1;
  v := v || jsonb_build_object('batch1_size', n); ok := ok AND n = 20;

  -- Original legs still present and unchanged
  SELECT count(*) INTO bad FROM fin_s14b1_package_lines l
   WHERE (l.kind='cash' AND (SELECT count(*) FROM general_ledger g WHERE g.transaction_group_id=l.origin_group_id
            AND ((g.category='cash_receipt_in_transit' AND g.direction='cash_in') OR (g.category='tenant_repayment_collected' AND g.direction='cash_out'))
            AND g.amount=l.amount AND g.id::text = ANY(string_to_array(l.origin_leg_ids, ','))) <> 2)
      OR (l.kind='commission' AND NOT EXISTS (SELECT 1 FROM general_ledger g WHERE g.id::text=l.origin_leg_ids
            AND g.transaction_group_id=l.origin_group_id AND g.user_id=l.recipient_user_id
            AND g.category='agent_commission_earned' AND g.ledger_scope='wallet' AND g.amount=l.origin_leg_amount));
  v := v || jsonb_build_object('origin_legs_invalid', bad); ok := ok AND bad = 0;

  -- Protected corrections
  SELECT count(*), sum(amount) INTO n, s FROM agent_collections WHERE reversed_at='2026-09-16 14:08:40.882504+00';
  v := v || jsonb_build_object('sep16_count', n, 'sep16_amount', s); ok := ok AND n = 1210 AND s = 92656683;
  SELECT count(*) INTO bad FROM fin_s14b1_package_lines l JOIN agent_collections ac ON ac.id=l.collection_id
   WHERE ac.reversed_at='2026-09-16 14:08:40.882504+00';
  ok := ok AND bad = 0;
  SELECT count(*), coalesce(sum(amount),0) INTO n, s FROM general_ledger
   WHERE category='cash_receipt_in_transit' AND direction='cash_out' AND coalesce(reference_id,'') NOT LIKE 's14b1:%';
  v := v || jsonb_build_object('receipt_reversals_other', n, 'receipt_reversals_other_amount', s); ok := ok AND n = 6 AND s = 94523683;
  SELECT count(*) INTO n FROM agent_collections WHERE id='dab3bc9f-1ba2-4151-a344-fdd09132b7f8' AND amount=10000 AND reversed_at='2026-09-16 14:08:40.882504+00';
  v := v || jsonb_build_object('sep29_collection_ok', n=1); ok := ok AND n = 1;
  SELECT count(*) INTO bad FROM fin_s14b1_package_lines WHERE collection_id='dab3bc9f-1ba2-4151-a344-fdd09132b7f8';
  ok := ok AND bad = 0;

  -- Rent Plans unchanged since the package
  SELECT count(*) INTO bad FROM fin_s14b1_package_plans p JOIN rent_requests rr ON rr.id=p.rent_request_id
   WHERE rr.amount_repaid::numeric(18,2) <> p.amount_repaid_before OR rr.status <> p.status_before OR rr.total_repayment::numeric(18,2) <> p.total_repayment;
  v := v || jsonb_build_object('plans_changed', bad); ok := ok AND bad = 0;
  -- Case 20 UGX 4,000 stays excluded
  SELECT count(*) INTO n FROM fin_s14b1_package_plans WHERE rent_request_id='2ca84e52-973b-4ed6-a5b8-5bc28ba6cd84' AND restore_amount=96000;
  ok := ok AND n = 1;

  -- Idempotency
  SELECT count(*) INTO n FROM general_ledger WHERE reference_id IN (SELECT entry_key FROM fin_s14b1_package_lines) OR idempotency_key IN (SELECT entry_key FROM fin_s14b1_package_lines);
  v := v || jsonb_build_object('keys_used', n); ok := ok AND n = 0;

  -- Commission: live safe recovery must equal the package, line by line (collection order)
  WITH c AS (
    SELECT l.entry_key, l.recipient_user_id, l.amount, l.origin_leg_amount,
           sum(l.origin_leg_amount) OVER (PARTITION BY l.recipient_user_id ORDER BY l.case_position, l.entry_key) - l.origin_leg_amount AS before_cum,
           greatest(coalesce(public.get_user_available_balance(l.recipient_user_id),0),0) AS avail
      FROM fin_s14b1_package_lines l WHERE l.kind='commission')
  SELECT count(*) INTO bad FROM c
   WHERE round(least(origin_leg_amount, greatest(avail - before_cum, 0)),2) <> amount;
  v := v || jsonb_build_object('commission_mismatch_lines', bad); ok := ok AND bad = 0;
  -- No wallet below zero
  SELECT count(*) INTO bad FROM (SELECT recipient_user_id, sum(amount) a FROM fin_s14b1_package_lines WHERE kind='commission' GROUP BY 1) x
   WHERE greatest(coalesce(public.get_user_available_balance(x.recipient_user_id),0),0) < x.a;
  v := v || jsonb_build_object('wallets_insufficient', bad); ok := ok AND bad = 0;
  -- Recruiters never present
  SELECT count(*) INTO bad FROM fin_s14b1_package_lines WHERE recipient_user_id IN
   ('98ee118b-06d1-47a4-aa2b-76bd12170b70','ebd985fb-dc19-43f8-b5f4-4e8cf1150fd4','ebf0897b-dfdf-4403-ad5c-1c988c72e67c');
  ok := ok AND bad = 0;

  -- Unexpected commission payment: no new commission to the three collecting agents
  -- after the last commission leg included in the reviewed snapshot. Never recalculated.
  SELECT count(*) INTO bad FROM general_ledger g
   WHERE g.category='agent_commission_earned' AND g.ledger_scope='wallet' AND g.direction='cash_in'
     AND g.created_at > '2026-10-03 17:15:08.846739+00'::timestamptz
     AND g.user_id IN (SELECT DISTINCT recipient_user_id FROM fin_s14b1_package_lines WHERE kind='commission');
  v := v || jsonb_build_object('new_commission_payments', bad); ok := ok AND bad = 0;

  -- Tenant-balance safety (before): every plan in range now and after the planned restore
  SELECT count(*) INTO bad FROM fin_s14b1_package_plans p JOIN rent_requests rr ON rr.id=p.rent_request_id
   WHERE rr.amount_repaid < 0 OR rr.total_repayment - rr.amount_repaid < 0
      OR p.amount_repaid_after < 0 OR p.amount_repaid_after > rr.total_repayment
      OR p.amount_repaid_after <> p.amount_repaid_before - p.restore_amount;
  v := v || jsonb_build_object('tenant_balance_unsafe', bad); ok := ok AND bad = 0;

  v := v || jsonb_build_object('fingerprint', public.fin_s14b1_fingerprint(), 'all_ok', ok);
  RETURN v;
END $f$;

-- 4. Manifest (read-only) -------------------------------------------------
CREATE OR REPLACE FUNCTION public.cfo_s14b1_manifest() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $f$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'S14B1_NOT_CFO'; END IF;
  RETURN jsonb_build_object(
    'version','S14B1-v2',
    'fingerprint', public.fin_s14b1_fingerprint(),
    'latest_approval', (SELECT to_jsonb(a) FROM fin_s14b1_approvals a ORDER BY approved_at DESC LIMIT 1),
    'entries', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.kind, l.case_position, l.entry_key) FROM fin_s14b1_package_lines l),
    'plans',   (SELECT jsonb_agg(to_jsonb(p)) FROM fin_s14b1_package_plans p),
    'protected', jsonb_build_array('16 Sep: 1,210 reversed collections, UGX 92,656,683','29 Sep: collection dab3bc9f UGX 10,000'),
    'not_in_package', jsonb_build_object('recruiter_commission', 2835.68, 'unrecoverable_collecting_commission', 6132.40),
    'validation', public.fin_s14b1_validate());
END $f$;

-- 5. CFO approval (records a decision only; moves no money) ----------------
CREATE OR REPLACE FUNCTION public.cfo_s14b1_approve(p_package_hash text, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE v_id uuid; v jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'S14B1_NOT_CFO'; END IF;
  IF p_package_hash IS DISTINCT FROM public.fin_s14b1_fingerprint() THEN RAISE EXCEPTION 'S14B1_HASH_MISMATCH'; END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'S14B1_REASON_REQUIRED'; END IF;
  v := public.fin_s14b1_validate();
  IF NOT (v->>'all_ok')::boolean THEN RAISE EXCEPTION 'S14B1_VALIDATION_FAILED: %', v; END IF;
  INSERT INTO fin_s14b1_approvals (package_version, package_hash, approved_by, approved_totals, reason)
  VALUES ('S14B1-v2', p_package_hash, auth.uid(),
          jsonb_build_object('entries',33,'lines',66,'debits',523085.42,'credits',523085.42,'cash',483685,'commission',39400.42,'tenant_restoration',479685),
          p_reason)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 's14b1_package_approved', 'fin_s14b1_approvals', v_id::text, p_reason, jsonb_build_object('hash', p_package_hash));
  RETURN v_id;
END $f$;

-- 6. Executor (atomic; one function call = one transaction) ----------------
CREATE OR REPLACE FUNCTION public.cfo_s14b1_execute(p_approval_id uuid, p_approved boolean, p_confirmation text, p_package_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE
  a record; l record; p record; v jsonb; v_grp uuid; v_avail numeric;
  n_ref bigint; n_entries int := 0; n_legs int := 0; v_dr numeric := 0; v_cr numeric := 0; n_coll int; n_plans int;
BEGIN
  -- Gate 1: explicit flag, no default
  IF p_approved IS DISTINCT FROM true THEN RAISE EXCEPTION 'S14B1_NOT_APPROVED_FLAG'; END IF;
  -- Gate 2: caller is a CFO approver AND is the single designated Batch 1 executor (Angwen Sarah)
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'S14B1_NOT_CFO'; END IF;
  IF auth.uid() IS DISTINCT FROM '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'::uuid THEN RAISE EXCEPTION 'S14B1_NOT_BATCH1_EXECUTOR'; END IF;
  -- Gate 2b: deliberate confirmation — exact phrase and fingerprint supplied again
  IF p_confirmation IS DISTINCT FROM 'EXECUTE BATCH 1 CORRECTION' THEN RAISE EXCEPTION 'S14B1_CONFIRMATION_PHRASE_MISMATCH'; END IF;
  IF p_package_hash IS DISTINCT FROM '274de6552922cbdc2f7d346903ef5ac0300681646fd6e35f9b781959e422a385' THEN RAISE EXCEPTION 'S14B1_CONFIRMATION_HASH_MISMATCH'; END IF;
  -- Serialise: only one executor at a time
  PERFORM pg_advisory_xact_lock(hashtext('s14b1_execute'));
  -- Gate 3: stored approval for this exact fingerprint, never executed
  SELECT * INTO a FROM fin_s14b1_approvals WHERE id = p_approval_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'S14B1_APPROVAL_NOT_FOUND'; END IF;
  IF a.executed_at IS NOT NULL THEN RAISE EXCEPTION 'S14B1_ALREADY_EXECUTED'; END IF;
  IF EXISTS (SELECT 1 FROM fin_s14b1_approvals WHERE executed_at IS NOT NULL) THEN RAISE EXCEPTION 'S14B1_ALREADY_EXECUTED'; END IF;
  IF a.approved_by IS NULL OR NOT public.is_cfo_approver(a.approved_by) THEN RAISE EXCEPTION 'S14B1_APPROVER_INVALID'; END IF;
  -- Gate 3b: timing, server clock — at least 5 minutes after approval, expires after 24 hours
  IF clock_timestamp() < a.approved_at + interval '5 minutes' THEN RAISE EXCEPTION 'S14B1_WAITING_PERIOD'; END IF;
  IF clock_timestamp() > a.approved_at + interval '24 hours' THEN RAISE EXCEPTION 'S14B1_APPROVAL_EXPIRED'; END IF;
  IF a.package_version <> 'S14B1-v2' OR a.package_hash <> public.fin_s14b1_fingerprint() OR a.package_hash <> p_package_hash THEN RAISE EXCEPTION 'S14B1_HASH_MISMATCH'; END IF;
  IF (a.approved_totals->>'debits')::numeric <> 523085.42 THEN RAISE EXCEPTION 'S14B1_TOTALS_MISMATCH'; END IF;

  -- Lock every affected wallet owner, collection and plan before re-validating
  PERFORM pg_advisory_xact_lock(hashtext('bucket_reclass:' || u::text))
     FROM (SELECT DISTINCT recipient_user_id u FROM fin_s14b1_package_lines WHERE kind='commission' ORDER BY 1) x;
  PERFORM 1 FROM agent_collections WHERE id IN (SELECT collection_id FROM fin_s14b1_package_lines) FOR UPDATE;
  PERFORM 1 FROM rent_requests WHERE id IN (SELECT rent_request_id FROM fin_s14b1_package_plans) FOR UPDATE;

  -- Gate 4: full re-validation inside the same transaction
  v := public.fin_s14b1_validate();
  IF NOT (v->>'all_ok')::boolean THEN RAISE EXCEPTION 'S14B1_VALIDATION_FAILED: %', v; END IF;

  -- Gate 5: referral hard stop. No unpaid referral bonus may exist for the recovered agents
  -- or the 13 plans' agents; a bonus must never be paid inside this transaction.
  SELECT count(*) INTO n_ref FROM referrals r
   WHERE r.referred_id IN (SELECT recipient_user_id FROM fin_s14b1_package_lines WHERE kind='commission'
                           UNION SELECT rr.agent_id FROM rent_requests rr WHERE rr.id IN (SELECT rent_request_id FROM fin_s14b1_package_plans))
     AND NOT coalesce(r.unlocked,false) AND NOT coalesce(r.credited,false);
  IF n_ref > 0 THEN RAISE EXCEPTION 'S14B1_REFERRAL_PENDING %', n_ref; END IF;
  SELECT count(*) INTO n_ref FROM general_ledger WHERE source_table='referrals';

  PERFORM set_config('ledger.authorized', 'true', true);

  -- Cash entries (20): Dr tenant_repayment_collected / Cr cash_receipt_in_transit
  FOR l IN SELECT * FROM fin_s14b1_package_lines WHERE kind='cash' ORDER BY case_position LOOP
    IF EXISTS (SELECT 1 FROM general_ledger WHERE reference_id = l.entry_key) THEN RAISE EXCEPTION 'S14B1_KEY_EXISTS %', l.entry_key; END IF;
    v_grp := gen_random_uuid();
    INSERT INTO general_ledger (amount, direction, category, classification, solvency_bypass_reason, source_table, source_id,
                                reference_id, idempotency_key, rent_request_id, description, ledger_scope, transaction_group_id)
    VALUES
     (l.amount,'cash_in','tenant_repayment_collected','admin_correction','duplicate_reversal','fin_s14b1_package_lines', l.collection_id,
      l.entry_key, l.entry_key||':dr', l.rent_request_id, 'Stage 14 Batch 1 case '||l.case_position||': reverse confirmed duplicate collection '||l.collection_id||' (origin group '||l.origin_group_id||')','platform', v_grp),
     (l.amount,'cash_out','cash_receipt_in_transit','admin_correction','duplicate_reversal','fin_s14b1_package_lines', l.collection_id,
      l.entry_key, l.entry_key||':cr', l.rent_request_id, 'Stage 14 Batch 1 case '||l.case_position||': remove duplicate receipt in transit '||l.collection_id,'platform', v_grp);
    n_entries := n_entries + 1; n_legs := n_legs + 2; v_dr := v_dr + l.amount; v_cr := v_cr + l.amount;
  END LOOP;

  -- Commission entries (13): withdrawable only, re-checked per line, never negative, never float
  FOR l IN SELECT * FROM fin_s14b1_package_lines WHERE kind='commission' ORDER BY recipient_user_id, case_position, entry_key LOOP
    IF EXISTS (SELECT 1 FROM general_ledger WHERE reference_id = l.entry_key) THEN RAISE EXCEPTION 'S14B1_KEY_EXISTS %', l.entry_key; END IF;
    v_avail := coalesce(public.get_user_available_balance(l.recipient_user_id), 0);
    IF v_avail < l.amount THEN RAISE EXCEPTION 'S14B1_WALLET_INSUFFICIENT % has % needs %', l.recipient_user_id, v_avail, l.amount; END IF;
    v_grp := gen_random_uuid();
    INSERT INTO general_ledger (user_id, amount, direction, category, classification, solvency_bypass_reason, source_table, source_id,
                                reference_id, idempotency_key, recipient_type, wallet_bucket, rent_request_id, description, ledger_scope, transaction_group_id)
    VALUES
     (l.recipient_user_id, l.amount,'cash_out','system_balance_correction','admin_correction','duplicate_reversal','fin_s14b1_package_lines', l.collection_id,
      l.entry_key, l.entry_key||':dr', 'user', 'withdrawable', l.rent_request_id, 'Stage 14 Batch 1 case '||l.case_position||': recover commission (leg '||l.origin_leg_ids||') paid on confirmed duplicate collection','wallet', v_grp),
     (l.recipient_user_id, l.amount,'cash_in','agent_commission_earned','admin_correction','duplicate_reversal','fin_s14b1_package_lines', l.collection_id,
      l.entry_key, l.entry_key||':cr', NULL, NULL, l.rent_request_id, 'Contra: Stage 14 Batch 1 commission recovery, case '||l.case_position,'platform', v_grp);
    n_entries := n_entries + 1; n_legs := n_legs + 2; v_dr := v_dr + l.amount; v_cr := v_cr + l.amount;
  END LOOP;

  -- Post-condition: no wallet negative
  IF EXISTS (SELECT 1 FROM wallets WHERE user_id IN (SELECT recipient_user_id FROM fin_s14b1_package_lines WHERE kind='commission')
             AND (withdrawable_balance < 0 OR float_balance < 0)) THEN RAISE EXCEPTION 'S14B1_NEGATIVE_WALLET'; END IF;

  -- Mark the 20 collections reversed
  UPDATE agent_collections ac SET reversed_at = now(),
         notes = coalesce(ac.notes,'') || ' [REVERSED: Stage 14 Batch 1 confirmed duplicate, approval '||p_approval_id||']'
   WHERE ac.id IN (SELECT collection_id FROM fin_s14b1_package_lines WHERE kind='cash') AND ac.reversed_at IS NULL;
  GET DIAGNOSTICS n_coll = ROW_COUNT;
  IF n_coll <> 20 THEN RAISE EXCEPTION 'S14B1_COLLECTIONS_MARKED %', n_coll; END IF;

  -- Restore tenant debt on the 13 Rent Plans (UGX 479,685; case 20 net of UGX 4,000)
  FOR p IN SELECT * FROM fin_s14b1_package_plans LOOP
    UPDATE rent_requests SET amount_repaid = p.amount_repaid_after, status = p.status_after
     WHERE id = p.rent_request_id AND amount_repaid::numeric(18,2) = p.amount_repaid_before AND status = p.status_before;
    IF NOT FOUND THEN RAISE EXCEPTION 'S14B1_PLAN_CHANGED %', p.rent_request_id; END IF;
    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 's14b1_tenant_debt_restored', 'rent_requests', p.rent_request_id::text,
            'Stage 14 Batch 1: restore tenant debt reduced by confirmed duplicate collections',
            jsonb_build_object('approval_id', p_approval_id, 'before', p.amount_repaid_before, 'after', p.amount_repaid_after,
                               'restored', p.restore_amount, 'status_before', p.status_before, 'status_after', p.status_after));
  END LOOP;
  SELECT count(*) INTO n_plans FROM fin_s14b1_package_plans;
  -- Tenant-balance safety (after): no negative paid/outstanding, no overpayment, terms unchanged
  IF EXISTS (SELECT 1 FROM fin_s14b1_package_plans pp JOIN rent_requests rr ON rr.id=pp.rent_request_id
              WHERE rr.amount_repaid < 0 OR rr.total_repayment - rr.amount_repaid < 0
                 OR rr.amount_repaid::numeric(18,2) <> pp.amount_repaid_after
                 OR rr.total_repayment::numeric(18,2) <> pp.total_repayment)
  THEN RAISE EXCEPTION 'S14B1_TENANT_BALANCE_UNSAFE'; END IF;

  -- Final balance assertions
  IF n_entries <> 33 OR n_legs <> 66 OR v_dr <> 523085.42 OR v_cr <> 523085.42 THEN
    RAISE EXCEPTION 'S14B1_TOTALS_POST % % % %', n_entries, n_legs, v_dr, v_cr; END IF;
  IF (SELECT count(*) FROM general_ledger WHERE reference_id LIKE 's14b1:%') <> 66 THEN RAISE EXCEPTION 'S14B1_LEG_COUNT'; END IF;
  IF EXISTS (SELECT transaction_group_id FROM general_ledger WHERE reference_id LIKE 's14b1:%' GROUP BY 1
             HAVING sum(CASE WHEN direction='cash_in' THEN amount ELSE -amount END) <> 0) THEN RAISE EXCEPTION 'S14B1_UNBALANCED_GROUP'; END IF;

  -- Referral post-check: nothing paid from referrals during this run
  IF (SELECT count(*) FROM general_ledger WHERE source_table='referrals') <> n_ref THEN RAISE EXCEPTION 'S14B1_REFERRAL_PAID_DURING_RUN'; END IF;
  -- Mapped double-entry: every s14b1 group must balance on ledger_account_map treatment (same rules as live check)
  IF EXISTS (
    SELECT 1 FROM general_ledger gl
      LEFT JOIN ledger_account_map mb ON mb.ledger_scope=gl.ledger_scope AND mb.category=gl.category AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket=gl.wallet_bucket
      LEFT JOIN ledger_account_map mw ON mw.ledger_scope=gl.ledger_scope AND mw.category=gl.category AND mw.wallet_bucket IS NULL
     WHERE gl.reference_id LIKE 's14b1:%'
     GROUP BY gl.transaction_group_id
    HAVING abs(sum(CASE WHEN gl.direction = COALESCE(mb.debit_when, mw.debit_when,
                 CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                      WHEN gl.ledger_scope='wallet' THEN 'cash_out' ELSE 'cash_in' END)
               THEN gl.amount ELSE -gl.amount END)) > 0.005)
  THEN RAISE EXCEPTION 'S14B1_MAPPED_UNBALANCED'; END IF;

  v := jsonb_build_object('approval_id', p_approval_id, 'fingerprint', a.package_hash, 'entries', n_entries, 'legs', n_legs,
                          'debits', v_dr, 'credits', v_cr, 'collections_reversed', n_coll, 'plans_restored', n_plans);
  PERFORM set_config('s14b1.executing', 'on', true);
  UPDATE fin_s14b1_approvals SET executed_at = now(), executed_by = auth.uid(), execution_result = v WHERE id = p_approval_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 's14b1_correction_executed', 'fin_s14b1_approvals', p_approval_id::text, 'Stage 14 Batch 1 correction executed under CFO approval', v);
  INSERT INTO system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('ACCOUNTING_CORRECTION_BATCH_1_DUPLICATE_COLLECTIONS', auth.uid(), 'fin_s14b1_approvals', p_approval_id, v || jsonb_build_object('kind','s14b1_correction'));
  RETURN v;
  -- Any RAISE above aborts the whole call: all 66 legs, wallet movements, collection marks and plan updates roll back together.
END $f$;

-- 7. Access: no ordinary path can reach these ------------------------------
REVOKE ALL ON FUNCTION public.fin_s14b1_fingerprint(), public.fin_s14b1_validate(), public.cfo_s14b1_manifest(),
  public.cfo_s14b1_approve(text, text), public.cfo_s14b1_execute(uuid, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s14b1_manifest(), public.cfo_s14b1_approve(text, text), public.cfo_s14b1_execute(uuid, boolean, text, text) TO authenticated;
-- (Each of these checks is_cfo_approver(auth.uid()) itself; no app screen calls them.)

-- 8. Apply-time self-check: abort the whole file unless the frozen package hashes to the reviewed value
DO $c$ BEGIN
  IF public.fin_s14b1_fingerprint() <> '274de6552922cbdc2f7d346903ef5ac0300681646fd6e35f9b781959e422a385' THEN
    RAISE EXCEPTION 'S14B1 package fingerprint % differs from reviewed 274de6552922cbdc2f7d346903ef5ac0300681646fd6e35f9b781959e422a385', public.fin_s14b1_fingerprint();
  END IF;
END $c$;
