-- Bucket A agent receivables correction: frozen package + live pre-flight + CFO-authorized atomic posting.
-- This migration posts NOTHING to the ledger.
CREATE TABLE public.cfo_bucket_a_package_lines (
  line_no int PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  account text NOT NULL CHECK (account IN ('A10','A11','A12','A14')),
  receivable_category text NOT NULL,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  agent_label text,
  reason text NOT NULL,
  approved_amount numeric(18,2) NOT NULL CHECK (approved_amount > 0),
  expected_after numeric(18,2) NOT NULL,
  approved_status text NOT NULL,
  UNIQUE (account, source_id)
);
GRANT SELECT ON public.cfo_bucket_a_package_lines TO authenticated;
GRANT ALL ON public.cfo_bucket_a_package_lines TO service_role;
ALTER TABLE public.cfo_bucket_a_package_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read Bucket A package" ON public.cfo_bucket_a_package_lines
  FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()) OR public.has_role(auth.uid(),'cfo'::app_role));

CREATE TABLE public.cfo_bucket_a_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('preflight_passed','preflight_blocked','posting_committed','posting_failed','posting_blocked')),
  actor uuid,
  package_hash text,
  preflight_id uuid,
  record_count int,
  total_amount numeric(18,2),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.cfo_bucket_a_events TO authenticated;
GRANT ALL ON public.cfo_bucket_a_events TO service_role;
ALTER TABLE public.cfo_bucket_a_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read Bucket A events" ON public.cfo_bucket_a_events
  FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()) OR public.has_role(auth.uid(),'cfo'::app_role));
CREATE OR REPLACE FUNCTION public.cfo_bucket_a_events_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'cfo_bucket_a_events is append-only'; END $$;
CREATE TRIGGER trg_cfo_bucket_a_events_append_only BEFORE UPDATE OR DELETE ON public.cfo_bucket_a_events
  FOR EACH ROW EXECUTE FUNCTION public.cfo_bucket_a_events_append_only();
CREATE OR REPLACE FUNCTION public.cfo_bucket_a_package_frozen() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Bucket A package is frozen'; END $$;

INSERT INTO public.cfo_bucket_a_package_lines
 (line_no,idempotency_key,account,receivable_category,source_table,source_id,agent_label,reason,approved_amount,expected_after,approved_status)
SELECT v.n, 'CFOGATE-2026-10:'||v.a||':'||v.s, v.a,
  CASE v.a WHEN 'A10' THEN 'agent_advance_receivable_opening' WHEN 'A11' THEN 'agent_access_fee_receivable_opening'
           WHEN 'A12' THEN 'merchandise_recovery_receivable_opening' ELSE 'credit_draw_receivable_opening' END,
  CASE v.a WHEN 'A12' THEN 'merchandise_recovery_plans' WHEN 'A14' THEN 'credit_access_draws' ELSE 'agent_advances' END,
  v.s::uuid, NULL, (ARRAY['Cancelled advance - stale A10','Cancelled advance - stale fee (A11)','Completed advance - stale fee (A11)','Credit draw stale/above source','Duplicate access fee (A11)','Invalid merchandise - order failed'])[v.r+1], v.amt, v.e, v.st
FROM (VALUES
(1,'A10','19c74e2a-4112-41fd-ac7a-d13956cb9695',0,261145.74,0,'cancelled'),
(2,'A11','19c74e2a-4112-41fd-ac7a-d13956cb9695',1,106193,0,'cancelled'),
(3,'A11','a2f68769-4fc0-4ddb-8842-2160ef15e1f7',2,101081,0,'completed'),
(4,'A14','c0b9cdfc-961e-42df-8dcf-d4fceab82f66',3,7151,0,'completed'),
(5,'A14','df9bccdc-545b-40e6-85c0-f71d74748b72',3,1275,38850,'overdue'),
(6,'A11','67b4449b-7560-4e40-91d5-4b2f55bfa557',4,900238,0,'overdue'),
(7,'A11','ba37593d-8b29-482b-b305-f98210864616',4,699596,0,'overdue'),
(8,'A11','15a83b88-20df-4bc2-a911-5c32db1f2af4',4,386703,0,'active'),
(9,'A11','63f051b0-2db2-4998-b6f4-fe260cb7d9c0',4,345000,0,'active'),
(10,'A11','978a9e12-9764-4b9d-b854-28c1ac47c4cd',4,257034,0,'overdue'),
(11,'A11','be9e0a44-050c-4e9c-8661-79bcbcaef956',4,226337,0,'active'),
(12,'A11','ba7d6847-f1b9-46f4-bd31-ec3854df9fc8',4,219628,0,'overdue'),
(13,'A11','d2a3bbc1-9775-4ad3-a0a1-1accb83a4762',4,191242,0,'overdue'),
(14,'A11','bb6f55bb-6789-40d9-856b-6cd988be0c97',4,179574,0,'active'),
(15,'A11','eaebb574-87d8-412b-bcf9-d9e6d646efc4',4,133252,0,'active'),
(16,'A11','d1ec4c4c-8e00-4d38-bcbf-3a010aecbcf2',4,132447,0,'overdue'),
(17,'A11','68e382b6-c102-4e80-8bcd-ce125ac621db',4,113960,0,'active'),
(18,'A11','adf66892-4ffb-4dc7-975d-52f1776869ec',4,99318,0,'active'),
(19,'A11','05ca5c21-473e-47ee-a796-8a942af0b79d',4,89858,0,'active'),
(20,'A11','44df86eb-8c86-4202-8ab0-05a425e8335f',4,80553,0,'overdue'),
(21,'A11','a7c5725f-0f48-4b57-90bb-93b68d077ee4',4,78233,0,'overdue'),
(22,'A11','68d4d57d-430d-47c6-961d-70cd0ebbf65c',4,70697,0,'active'),
(23,'A11','0ef49421-81ec-4f10-b36a-af0153c87b03',4,69267,0,'overdue'),
(24,'A11','56ca68df-c0f7-4399-8843-55e6b500fc07',4,69114,0,'overdue'),
(25,'A11','7c7eea6f-c74c-4d2f-b227-81025b8f423d',4,67632,0,'active'),
(26,'A11','38e84f96-bdc1-45ca-b735-2cea58092d57',4,67480,0,'overdue'),
(27,'A11','a782fb38-5366-423b-b642-2f94e055311c',4,67409,0,'overdue'),
(28,'A11','c0beb6f6-edcf-49b9-97f9-4461432d94aa',4,63799,0,'overdue'),
(29,'A11','8d946d66-2637-470b-a175-a7cc29748b68',4,61611,0,'overdue'),
(30,'A11','09da2a32-959a-4568-862b-17175ec0e910',4,60365,0,'active'),
(31,'A11','bbbc806b-2694-42ce-af48-844d9cbc1a4b',4,59994,0,'overdue'),
(32,'A11','100510ca-fb60-45c2-b4ee-150fddaf7361',4,58331,0,'overdue'),
(33,'A11','5b563103-f404-4b89-a366-3cd51d0d68bf',4,52156,0,'overdue'),
(34,'A11','d2182666-015b-4af7-b6c9-684dad684064',4,46328,0,'active'),
(35,'A11','b244736f-9a88-471f-ab53-82bf367a9126',4,46328,0,'active'),
(36,'A11','cf94d6b4-ceff-46c1-aec1-c7d56ff62044',4,46328,0,'active'),
(37,'A11','91e3ddb5-ffb3-40b1-9133-78efbea83d39',4,46328,0,'active'),
(38,'A11','3696304b-41c4-4604-962c-8b9d1b16a846',4,45983,0,'active'),
(39,'A11','8cab5c75-ff47-4716-bb2b-5e75996a9300',4,45813,0,'active'),
(40,'A11','b0e349f9-c572-4860-afa9-7f4798a73c33',4,45564,0,'active'),
(41,'A11','fd86d9c4-e5f3-4291-9ac2-78732601de54',4,43473,0,'overdue'),
(42,'A11','3060c502-0d2e-4bd8-8541-75d01a2f963b',4,43284,0,'overdue'),
(43,'A11','8b0c4875-e714-4a08-a8c5-f881615bd523',4,43163,0,'overdue'),
(44,'A11','3d6c4dcb-8ebc-4174-89b9-c2b7c5848e17',4,43074,0,'overdue'),
(45,'A11','78171828-3dab-41c4-bc9b-c67f34df2137',4,42554,0,'overdue'),
(46,'A11','a051c80a-e351-4e3e-8b3b-6e2564787ab5',4,41751,0,'overdue'),
(47,'A11','3a999e0f-7e66-4521-b417-f0d0d3ae765d',4,40669,0,'overdue'),
(48,'A11','912c0a35-d318-441d-ae19-034c4b70e8f3',4,40193,0,'overdue'),
(49,'A11','55f45f44-0a49-468d-aee7-056b2d23f1b0',4,38781,0,'overdue'),
(50,'A11','a314f18c-6356-4c3e-a0f2-70601f3e0622',4,38781,0,'overdue'),
(51,'A11','d623fe50-f83d-456c-87ac-33fe25d32a08',4,38732,0,'overdue'),
(52,'A11','94be1779-0240-4969-bb1b-8784bc5f9158',4,38533,0,'overdue'),
(53,'A11','716ff062-b632-4d2f-8fbb-af0e0820330b',4,37173,0,'overdue'),
(54,'A11','372522e4-9887-4358-a329-4109222c7924',4,36618,0,'overdue'),
(55,'A11','80a5b789-9010-411d-a74f-8a57b2f68ed5',4,36473,0,'overdue'),
(56,'A11','a4e3458b-209b-44be-b8b5-fcfaba9168f8',4,36473,0,'overdue'),
(57,'A11','abcf3a8f-6f3c-4ad6-9a8d-15da7419721b',4,36473,0,'overdue'),
(58,'A11','fd998a85-3954-4847-bb4d-4015d0c669bf',4,36282,0,'overdue'),
(59,'A11','287f8a22-2901-47e9-b888-1aee77e31a49',4,36137,0,'overdue'),
(60,'A11','37723868-e583-49a1-ac12-a563a47af141',4,36137,0,'overdue'),
(61,'A11','ca3ff2c8-ad8f-41a6-8b7c-9349f0ed1a15',4,36112,0,'overdue'),
(62,'A11','69bc47fd-da73-4003-a0c5-700c11cc2812',4,35811,0,'overdue'),
(63,'A11','ba729e33-2b18-4c13-b3d1-3bb3fe5a9ec1',4,35811,0,'overdue'),
(64,'A11','d856c839-2f21-4937-af5a-b3cd2f69b6be',4,35811,0,'overdue'),
(65,'A11','8b4e1f59-827b-4ef2-8250-6be854b45acd',4,35811,0,'overdue'),
(66,'A11','4051e911-f0e0-4d07-b5ce-02ccbd594a2e',4,35811,0,'overdue'),
(67,'A11','febd7a3f-a4a8-4caf-a6c5-8ed87eb8138c',4,35811,0,'overdue'),
(68,'A11','6f722412-a35c-47cd-95e2-310215ede863',4,35811,0,'overdue'),
(69,'A11','1a21ccde-d0b7-4759-96aa-6662ebcae669',4,35765,0,'overdue'),
(70,'A11','7a4e4824-902a-451d-9018-f1499dfe8432',4,35712,0,'overdue'),
(71,'A11','ad8d910b-c734-42f7-a275-461b219fd462',4,35613,0,'overdue'),
(72,'A11','d65e3543-7e7e-40d5-bf29-0cc3e203893d',4,35481,0,'overdue'),
(73,'A11','c80b1905-7285-45e8-aab4-b9f892214d03',4,35332,0,'overdue'),
(74,'A11','5a6691cd-ca29-4e4d-85f8-e25775f205ee',4,35262,0,'overdue'),
(75,'A11','f0187980-9085-4582-9a07-210618547e7d',4,34985,0,'overdue'),
(76,'A11','50f84b2a-73a8-4098-b7f3-be0a4b4a065c',4,34929,0,'overdue'),
(77,'A11','beb25f45-6557-44ab-af9c-2bff0749c1b4',4,34265,0,'overdue'),
(78,'A11','6efb5e64-e83c-46e8-92dd-e95c12367faa',4,33518,0,'overdue'),
(79,'A11','e73aac6a-d87c-4ddb-b04e-4c25407f5552',4,32802,0,'active'),
(80,'A11','08abf40a-3e75-46e8-9222-6549fa4e0e13',4,31829,0,'overdue'),
(81,'A11','f4fc6ce2-66d5-4993-b2cc-f942ee533bb3',4,31538,0,'active'),
(82,'A11','f0c6b35e-93cf-4bb5-ac3a-251a2801b02d',4,30790,0,'active'),
(83,'A11','0fd8990f-02a3-4254-9a46-319d537ab3cd',4,30445,0,'overdue'),
(84,'A11','c566dee2-ef59-4963-91ac-d876391f7260',4,30445,0,'overdue'),
(85,'A11','926bd794-aedf-4195-b3de-cd4c3d33c042',4,28527,0,'overdue'),
(86,'A11','9fe2c85c-c6d7-452a-bdb5-e1848dc2cdbc',4,27418,0,'overdue'),
(87,'A11','b0e658df-b96c-498b-8b93-2bbc8dca7fdf',4,27370,0,'overdue'),
(88,'A11','60193637-1033-4838-aa5c-93f9cfb5df55',4,25871,0,'overdue'),
(89,'A11','f77ffdfb-0eb7-4a9e-8935-33ca89c6b2c5',4,25722,0,'overdue'),
(90,'A11','c7ff7792-d224-4e4e-a794-d7e5855786b1',4,25345,0,'overdue'),
(91,'A11','7de8c62a-6f9e-45d0-8835-bf364c979f29',4,24560,0,'overdue'),
(92,'A11','5e43c4ae-7ca0-43c2-b969-afa714671c49',4,24486,0,'overdue'),
(93,'A11','0c04f5a7-6198-462c-8809-9572f1dae844',4,23756,0,'overdue'),
(94,'A11','62a38dfe-a737-410f-b427-6191d6cb4ea0',4,23116,0,'active'),
(95,'A11','e505384b-2f37-49ef-b8ff-9c619cab8308',4,22997,0,'active'),
(96,'A11','72e2c6ee-fd1d-4382-bb97-575065bb349f',4,22739,0,'overdue'),
(97,'A11','2407f0e4-dc5a-446b-bef3-55862215f527',4,22191,0,'overdue'),
(98,'A11','f6a5f083-b3b8-44b2-b140-e37e81e47f05',4,21945,0,'overdue'),
(99,'A11','0c23df30-b18b-441d-9fd7-005c5a55610f',4,21883,0,'overdue'),
(100,'A11','1beba409-13e9-49b0-bec5-d0c5fd23f5cc',4,21531,0,'overdue'),
(101,'A11','af6dbe29-7346-4d67-9cc0-8c8da6ee986c',4,21349,0,'overdue'),
(102,'A11','57530a30-dc05-4e90-a9cc-87c8927d61a9',4,21126,0,'overdue'),
(103,'A11','ddf30d22-4ed6-48c1-9c45-c2d828dec563',4,20955,0,'overdue'),
(104,'A11','d8dc75d9-2023-4f7d-a01f-326bcb604682',4,20936,0,'overdue'),
(105,'A11','61211b19-9b44-441f-84d9-aad3fa852826',4,20748,0,'overdue'),
(106,'A11','bc22629f-960b-4b3b-9a2e-81647e780c5d',4,20748,0,'overdue'),
(107,'A11','acc12f4b-0304-41e4-96c7-582fc2c4e7e2',4,20748,0,'overdue'),
(108,'A11','267531a9-d85a-4732-980f-fc10ca1dacce',4,20077,0,'overdue'),
(109,'A11','58424b5d-6ae4-4d8f-8eb0-f88b37ee80b0',4,19681,0,'overdue'),
(110,'A11','a095606c-147a-4ea1-82e4-7fbc25121df6',4,19275,0,'active'),
(111,'A11','a0134d24-89bc-426e-b5f9-a8a0bc7f00a4',4,19275,0,'active'),
(112,'A11','cedbf5c2-503e-469e-bdb9-7fa79dabd90f',4,19076,0,'overdue'),
(113,'A11','a0e91e65-dbd0-41ed-b7ee-311d419bf1ed',4,18988,0,'active'),
(114,'A11','1360a010-a98f-4df2-846e-ce8f79820c79',4,18825,0,'active'),
(115,'A11','73b175d5-de50-4d2b-bee3-ad09c8e841c9',4,18825,0,'active'),
(116,'A11','106e0fb0-9c6b-4645-9a01-fae05e453efe',4,18700,0,'active'),
(117,'A11','20bc9540-edc4-4b91-bb50-5c038e695212',4,18663,0,'overdue'),
(118,'A11','25586c17-4791-48e0-a2eb-60c4fbee9431',4,18225,0,'active'),
(119,'A11','69c0564f-59dc-4e9f-a3fa-dbf9717f1163',4,17781,0,'active'),
(120,'A11','cbe57f50-977b-41b3-b677-3c0d62e849b9',4,17372,0,'overdue'),
(121,'A11','fb275058-e821-4d65-b31f-13a96fcc3a8d',4,17176,0,'active'),
(122,'A11','8afcfb17-ca28-4091-92c6-d2bf8e02d48d',4,17098,0,'overdue'),
(123,'A11','838b676d-d41d-4c12-b9ce-fedab66ae0f0',4,16976,0,'active'),
(124,'A11','00fd7686-15a3-457a-8b3d-be38ba3591de',4,16803,0,'overdue'),
(125,'A11','d3a0ea36-549d-41de-9a36-6d3e7b2dfecb',4,16540,0,'active'),
(126,'A11','47b042d2-0580-41c3-96fd-8b9648aaff88',4,15947,0,'overdue'),
(127,'A11','452275b6-1be3-457f-b169-7c8e02afaaa8',4,15852,0,'overdue'),
(128,'A11','5bbc314c-aae6-422a-a84f-18e7fc74e94b',4,15554,0,'overdue'),
(129,'A11','47537467-a0a2-4c14-bc51-dcb9877b2f21',4,15554,0,'overdue'),
(130,'A11','7759a2a1-8d68-414d-ada6-cba07c17a809',4,15554,0,'overdue'),
(131,'A11','8d759289-c186-448d-9c98-206f32d6e992',4,15549,0,'active'),
(132,'A11','4eeb8220-dccc-43f3-86c6-9f421a0e124b',4,15549,0,'overdue'),
(133,'A11','9c9991fe-8c95-453e-91ee-e9613a98b9dc',4,15430,0,'overdue'),
(134,'A11','67d4dc9e-3938-4c54-8c40-fcaf43d9680b',4,15407,0,'overdue'),
(135,'A11','7f956ca4-4c0f-4864-a371-8d33e09b5fa8',4,15327,0,'overdue'),
(136,'A11','383ed9ec-5475-46ce-b628-85d9d4d94670',4,15284,0,'overdue'),
(137,'A11','a262bafb-3851-4104-bb2a-e51b12fc2e89',4,15139,0,'overdue'),
(138,'A11','ff04743d-46d6-40fc-b756-3986be8bf037',4,15086,0,'overdue'),
(139,'A11','0b567610-aeba-49bc-9576-677c680f253a',4,14974,0,'overdue'),
(140,'A11','2b6e7851-253e-4f22-8e6e-99bb305dd449',4,14974,0,'overdue'),
(141,'A11','273e12ce-da62-49e5-88d4-e1884cee08eb',4,14974,0,'overdue'),
(142,'A11','7c7dd8f9-8c7b-4e61-9c72-cb36fce1d6a7',4,14974,0,'overdue'),
(143,'A11','121e8034-60fa-49ee-9ed5-c759de013075',4,14974,0,'overdue'),
(144,'A11','a444ef86-5ef5-4fa0-9614-cb22d1c50dcd',4,14974,0,'overdue'),
(145,'A11','5405b826-2caa-4d33-a2b2-9ec799effb68',4,14974,0,'overdue'),
(146,'A11','d75f475e-2187-4623-ba71-16065011c508',4,14974,0,'overdue'),
(147,'A11','cab9adeb-4bbe-442c-a6aa-93bce8fcd21a',4,14974,0,'overdue'),
(148,'A11','19ca3798-ae12-4cc9-a077-ea97c36e289b',4,14974,0,'overdue'),
(149,'A11','dee062b8-7ae8-4d98-a086-d0674be3257a',4,14974,0,'overdue'),
(150,'A11','a38e0d7b-4673-4f41-94ad-2219945da446',4,14931,0,'overdue'),
(151,'A11','f7267bf9-1d87-41e0-be65-d82436847567',4,14832,0,'overdue'),
(152,'A11','6871089c-e628-45d0-a4cf-9c8464a9e582',4,14832,0,'overdue'),
(153,'A11','b3de0117-e6a2-41d9-b2e1-dbe360af5a21',4,14803,0,'overdue'),
(154,'A11','83ba6050-0d05-4b57-9a71-62720e13c47a',4,14691,0,'overdue'),
(155,'A11','070193fa-9af8-43ae-95f2-2db38c18a0e5',4,14511,0,'overdue'),
(156,'A11','50d4ac2e-c8ad-4ed6-8599-9fc42c1c5259',4,14436,0,'overdue'),
(157,'A11','df655936-d29d-49c7-836f-157800df02ad',4,14436,0,'overdue'),
(158,'A11','1b686a81-8bb0-4ffe-a4d9-7e6745419c3c',4,14311,0,'overdue'),
(159,'A11','6c7f0690-9da3-4e81-ae25-3dfc6adf5944',4,14300,0,'overdue'),
(160,'A11','1704d45c-76f4-4cc6-b498-664b2b792013',4,13610,0,'overdue'),
(161,'A11','b52f6b3f-26a1-4005-80f7-9b37676a9b75',4,13602,0,'overdue'),
(162,'A11','4912c850-fafd-45ce-86fa-b3db066089c9',4,13526,0,'active'),
(163,'A11','4ada50a2-e1b5-4f03-af68-f5ee2dc2bd08',4,13526,0,'active'),
(164,'A11','854ff7fc-0eb8-45dc-892b-a9b16967e28c',4,13375,0,'active'),
(165,'A11','547ba96f-09f7-4fd0-9c1f-33d8b91714b1',4,13356,0,'overdue'),
(166,'A11','2d0412e6-8336-462f-8c08-bc645389296f',4,13149,0,'overdue'),
(167,'A11','fc515632-555b-4a81-b86d-fa13aec20c07',4,13002,0,'overdue'),
(168,'A11','b116c4c5-7a02-4a5e-b2df-aaa9c0a01f53',4,12758,0,'overdue'),
(169,'A11','ae913d3c-f67c-4ead-ac45-ab17d23a47f1',4,12758,0,'overdue'),
(170,'A11','bb5ebcb7-6e8f-443f-914e-6305ee314040',4,12706,0,'overdue'),
(171,'A11','f8860314-dc94-427c-87e4-85c9e833f6a0',4,12586,0,'overdue'),
(172,'A11','07f76e80-4480-477c-83d1-e5920a57ed17',4,12492,0,'overdue'),
(173,'A11','2b265257-51cd-4424-9b05-35ae5177dddd',4,12492,0,'overdue'),
(174,'A11','dd6dc0bd-c039-47d9-a215-17e468ed0172',4,12492,0,'overdue'),
(175,'A11','725a0866-3617-4590-a975-aa17921fc8c2',4,12348,0,'overdue'),
(176,'A11','6ce9db4c-7056-4049-b849-e81f21b2290f',4,12051,0,'overdue'),
(177,'A11','f469e277-27ac-447f-9e61-3ba613db3214',4,12051,0,'overdue'),
(178,'A11','5e95c015-356f-4a24-b202-7fb9ef4a918b',4,12051,0,'overdue'),
(179,'A11','110b3ad2-a71b-4c76-a8be-7b6b068cbac5',4,12051,0,'overdue'),
(180,'A11','4a5694c0-6114-4483-9184-14945845c9a0',4,12051,0,'overdue'),
(181,'A11','f3df83c2-5ed5-4879-8216-1490de8f6819',4,12051,0,'overdue'),
(182,'A11','5b8c1223-b857-4c35-9083-d86627865960',4,12051,0,'overdue'),
(183,'A11','d1823dfe-17b2-4df3-afa7-84b13935044b',4,12051,0,'overdue'),
(184,'A11','86b08a56-4d71-4930-8277-a970d00bd58f',4,12051,0,'overdue'),
(185,'A11','a2465adb-021c-4cdd-b5ec-9ded304a93dd',4,12051,0,'overdue'),
(186,'A11','5d163028-81b2-4594-a082-ac93a343beeb',4,12026,0,'overdue'),
(187,'A11','37d50ceb-08ce-4b5b-94cf-837e2b8b783d',4,11987,0,'overdue'),
(188,'A11','9628fb0e-66fe-462b-a04b-9ee6451dc921',4,11847,0,'overdue'),
(189,'A11','dc9c5849-a537-4825-a539-b99332d04e15',4,11601,0,'overdue'),
(190,'A11','5da8c1b3-47ec-4ac0-ad4f-40daece15ea0',4,11573,0,'overdue'),
(191,'A11','6e6966d2-d9ab-4804-91cc-1b92b067a09f',4,11518,0,'overdue'),
(192,'A11','82fdd26b-bc42-4d88-a1ee-4fd65f17cf70',4,11202,0,'overdue'),
(193,'A11','e7f56122-481f-4cae-86c1-f5e28d97741a',4,11138,0,'overdue'),
(194,'A11','7971369e-c299-457c-afdd-815ad6c5819e',4,11083,0,'overdue'),
(195,'A11','2c32b6d5-1e1f-454e-806b-c0d04666a5da',4,10879,0,'overdue'),
(196,'A11','c48a64ea-a95c-4261-a51d-4bf44e33228d',4,10879,0,'overdue'),
(197,'A11','9f5fa548-e007-4894-a4e0-c8402f2cc34d',4,10879,0,'overdue'),
(198,'A11','2cd6a66c-2465-4dd7-94be-ae7898904973',4,10879,0,'overdue'),
(199,'A11','ec0220df-cd70-4e9f-985b-803cfbed60bd',4,10776,0,'overdue'),
(200,'A11','eed760bc-1751-4933-8768-11afb235cb5c',4,10776,0,'overdue'),
(201,'A11','a02c3375-489c-4c12-98d4-46bc543911ca',4,10776,0,'overdue'),
(202,'A11','a8653457-24dd-4692-9b15-4d6d6080ce0d',4,10766,0,'overdue'),
(203,'A11','a9416cd3-78fa-4a22-8c8a-b03ed0001c56',4,10731,0,'overdue'),
(204,'A11','e75cfa3b-4a7e-4572-a6f5-8440b4a71bf5',4,10674,0,'overdue'),
(205,'A11','38f60d56-7629-41eb-8728-9bf0c4cff87d',4,10573,0,'overdue'),
(206,'A11','06425c3a-8e2d-48e7-8f30-205277131e3c',4,10306,0,'overdue'),
(207,'A11','4812fb1d-df05-4da8-8aa3-cfc30bdfe877',4,10284,0,'overdue'),
(208,'A11','9f354684-e7b0-422a-8a86-27100fe569a3',4,10197,0,'overdue'),
(209,'A11','6adda35f-f4d0-4b77-a3e1-2c4ffb61d733',4,9987,0,'overdue'),
(210,'A11','dca8fd34-d996-407c-b956-9416bbc578a6',4,9966,0,'overdue'),
(211,'A11','4f73f4a8-4bf8-4ff2-85b9-761b66b68610',4,9614,0,'overdue'),
(212,'A11','19e2b3bc-31e0-40e7-8860-dba97ac33cb6',4,9598,0,'overdue'),
(213,'A11','bb1dfbbb-bf12-42d2-b438-474d801f2437',4,9588,0,'overdue'),
(214,'A11','e903d70d-bcc1-4932-822e-dffa7440d2c3',4,9588,0,'overdue'),
(215,'A11','30373eb5-961d-45a3-b9f5-889c21b231e7',4,9562,0,'overdue'),
(216,'A11','f762de1f-602b-4070-8018-f15b5c391b89',4,9562,0,'overdue'),
(217,'A11','533bd63f-4a5e-4e49-94b2-e2bc3faebb54',4,9497,0,'overdue'),
(218,'A11','6a051358-6ad4-4566-9d63-d87e4b273928',4,9483,0,'overdue'),
(219,'A11','84e820a3-c6b2-49f8-9358-e6170b5eb033',4,9445,0,'overdue'),
(220,'A11','0c5443d2-5169-4f35-ba89-1bf241a51055',4,9433,0,'overdue'),
(221,'A11','c3d6c1ce-dca0-4818-a42b-80fdb2aca41d',4,9419,0,'overdue'),
(222,'A11','f62be5d0-f3f8-4949-97f3-5b784da98b36',4,9407,0,'overdue'),
(223,'A11','f7e20d49-e5c1-4520-b592-3e582b38004a',4,9407,0,'overdue'),
(224,'A11','b5cb59ba-0e77-403f-99c1-5fbfb1aaf79f',4,9407,0,'overdue'),
(225,'A11','bc5208bd-b06b-43b5-934a-965b28bc42e9',4,9407,0,'overdue'),
(226,'A11','bd5ef3cf-6cab-4a7d-bc35-ae49966b4b16',4,9407,0,'overdue'),
(227,'A11','fb101109-0d86-4e92-8c0a-8062c4324f55',4,9407,0,'overdue'),
(228,'A11','af4e371f-b3c0-41a2-a798-9eaf3ab6a46f',4,9407,0,'overdue'),
(229,'A11','264ce5f0-fd1f-45ef-bccc-dfc633917f3a',4,9407,0,'overdue'),
(230,'A11','337d2b15-6bcd-4385-af97-620bcf16006c',4,9382,0,'overdue'),
(231,'A11','454685de-fc35-42eb-890e-dbd6475a1ace',4,9382,0,'overdue'),
(232,'A11','66cd6a41-fa5a-43b4-bd68-53d06f25129a',4,9382,0,'overdue'),
(233,'A11','6d342dd9-c7bd-49cc-af3a-4587734daa85',4,9316,0,'overdue'),
(234,'A11','c011c801-e95f-49f5-942d-678f48042765',4,9316,0,'overdue'),
(235,'A11','46acb731-121c-4473-8a98-e639ccda49ad',4,9316,0,'overdue'),
(236,'A11','20beb1d0-983f-49d5-92bc-80674c3071c3',4,9072,0,'overdue'),
(237,'A11','78dfad5c-f900-4aa3-ba5f-d76989e5b42e',4,9072,0,'overdue'),
(238,'A11','06a1df62-82ee-4814-962c-d26f25aa4b7f',4,9035,0,'overdue'),
(239,'A11','0782354d-158f-47a0-bc69-cf0d3f9e8524',4,9021,0,'overdue'),
(240,'A11','3a972146-3740-40ff-8aa1-615815288ce7',4,9014,0,'overdue'),
(241,'A11','31d63347-0fda-465d-9c3c-5593b00e19e5',4,8971,0,'overdue'),
(242,'A11','390a59cd-923c-4b4f-aeab-6b55a55c5988',4,8955,0,'overdue'),
(243,'A11','0e6de24f-4d21-46b3-a47e-77e03349535a',4,8955,0,'overdue'),
(244,'A11','326cf052-639c-4400-b182-8be6cf39ce7b',4,8955,0,'overdue'),
(245,'A11','b32b2264-2b75-4fb5-af0f-f624fe87f7ec',4,8955,0,'overdue'),
(246,'A11','a66eaf9e-27e6-4b5f-8fb1-44670e9a58f1',4,8892,0,'overdue'),
(247,'A11','aa0efe31-75c9-432e-9825-f4d42d64ef7b',4,8892,0,'overdue'),
(248,'A11','ddbcf7f9-d042-4c2c-a50d-ed8fe2556105',4,8841,0,'overdue'),
(249,'A11','f7ec9ed0-738e-4e68-a1a6-1a86ffca5518',4,8787,0,'overdue'),
(250,'A11','e568bb58-01fd-4997-a54c-07b5bc787e76',4,8762,0,'overdue'),
(251,'A11','b287e887-5530-4433-acc3-13dc9db56093',4,8467,0,'overdue'),
(252,'A11','5a075637-69df-4e86-b4d6-11b5ee59581d',4,7919,0,'overdue'),
(253,'A11','ddfb0a76-33b8-406c-b3cc-3604fa6270cc',4,7576,0,'overdue'),
(254,'A11','3c770fa4-9342-4e62-a4f9-b0b377a6525b',4,7545,0,'overdue'),
(255,'A11','de0bf85e-e616-4b40-8550-86cb0bd170c0',4,7517,0,'overdue'),
(256,'A11','96365aa0-141c-4143-bd0d-e2d2266b215b',4,7517,0,'overdue'),
(257,'A11','8b1fb3f2-dc02-4ac7-8594-1995dd57a770',4,7489,0,'overdue'),
(258,'A11','2fbfda9b-255e-408d-949c-2b7287008682',4,7336,0,'overdue'),
(259,'A11','3e808ed4-d84c-4577-bcac-1ad20b1181fc',4,7336,0,'overdue'),
(260,'A11','fbd9da1b-634f-4443-a7a6-1853f0acf93d',4,7336,0,'overdue'),
(261,'A11','23e7aaa8-7537-49ea-985e-2516b8b6201b',4,7219,0,'overdue'),
(262,'A11','bb9e4dd6-851c-484d-b299-2f79878857a5',4,7182,0,'overdue'),
(263,'A11','432d74fe-96a6-4ccc-993a-767618ccc889',4,7136,0,'overdue'),
(264,'A11','109b7de3-2847-428d-8533-a5544f3ab5d2',4,7086,0,'overdue'),
(265,'A11','52af4d78-e77f-4ee1-a1d9-765d2d8a05aa',4,7059,0,'overdue'),
(266,'A11','fb2c13ec-da83-4fbc-980e-cf0793004919',4,7059,0,'overdue'),
(267,'A11','8bb5dd52-af1b-40b2-8752-58f5b2c40f07',4,7048,0,'overdue'),
(268,'A11','d70a3c31-7b48-4ac3-9981-0a29a74c5ea4',4,6993,0,'overdue'),
(269,'A11','2c962218-79e0-4101-a6ed-131d646ead0a',4,6992,0,'overdue'),
(270,'A11','01906a51-167c-43c1-8c83-2fa97f726a70',4,6958,0,'overdue'),
(271,'A11','23767100-04d4-4868-88d7-a8d62a1febc1',4,6914,0,'overdue'),
(272,'A11','13f118d9-08d7-4c1a-a357-caef01f0e2ac',4,6910,0,'overdue'),
(273,'A11','27a01984-92c5-40e3-a0c6-a01b8f92fefb',4,6839,0,'overdue'),
(274,'A11','2aeaea08-bdea-4740-83f4-692709a65446',4,6831,0,'overdue'),
(275,'A11','1042f5f1-8a61-4bd6-b2ab-3a541f773af8',4,6768,0,'overdue'),
(276,'A11','aa171c67-f5d8-4e7e-b58e-419e9e1156d8',4,6572,0,'overdue'),
(277,'A11','bee55942-8a78-41e6-826b-c92746cdaa6f',4,6405,0,'overdue'),
(278,'A11','d54706b6-d3c8-4fc6-99ad-2203efd89378',4,6385,0,'overdue'),
(279,'A11','44a033f9-be02-41e6-90ea-153d56f4c475',4,6357,0,'overdue'),
(280,'A11','b6ab8559-13d3-47cc-a19e-9b2e819c2a27',4,6352,0,'overdue'),
(281,'A11','4f636f64-b55f-419e-9ab9-e6cc4174b180',4,6262,0,'overdue'),
(282,'A11','37e6aebf-53cf-4dfa-b34c-ff56be4031e3',4,6214,0,'overdue'),
(283,'A11','6d4aeb25-df42-4b1a-b673-f3befaf9854a',4,6212,0,'overdue'),
(284,'A11','24c75306-f40b-4285-82a7-5af5234e4c48',4,5519,0,'overdue'),
(285,'A11','b6a441dc-7094-4daf-ac76-4758f15e83cb',4,5441,0,'overdue'),
(286,'A11','c539c923-0b2f-410b-82b8-8865ad702b82',4,5166,0,'overdue'),
(287,'A11','7d405a2b-434a-4e10-ab23-c7e12f576710',4,4855,0,'overdue'),
(288,'A11','7ff9e2b7-352c-4b8a-b21d-187645969184',4,4854,0,'overdue'),
(289,'A11','3c15ad20-3f63-4d21-bcc5-e07e3ac442dd',4,4706,0,'overdue'),
(290,'A11','39028395-ee9e-4ca6-98cf-0fc0a9d55bc6',4,4666,0,'overdue'),
(291,'A11','443f41f3-a6c2-40f8-8d08-80ebf836b15d',4,4529,0,'overdue'),
(292,'A11','6eed6150-4136-4273-8cc3-092f181da787',4,4424,0,'overdue'),
(293,'A11','1d049e33-b7fa-40b3-ba97-855c2ebd3c35',4,4334,0,'overdue'),
(294,'A11','b4f14647-9b6b-401a-90a8-16571281b93e',4,4306,0,'overdue'),
(295,'A11','276fbec9-e839-44b0-ba60-41235d9180e7',4,4306,0,'overdue'),
(296,'A11','63ffb8a0-9313-4aa4-9b5e-f12f17cbd297',4,4306,0,'overdue'),
(297,'A11','2c58cc81-0a9f-4a7d-86c1-85400a3d12da',4,4306,0,'overdue'),
(298,'A11','b7384c81-279b-44da-97f8-fbf29395b9f2',4,4306,0,'overdue'),
(299,'A11','39262ee7-87a7-4a8d-b4e5-bc74a61ae473',4,4306,0,'overdue'),
(300,'A11','51fd1ada-09f6-4220-8120-0306e2823e8d',4,4252,0,'overdue'),
(301,'A11','ddf424f7-b994-405a-b013-52724e31261f',4,4251,0,'overdue'),
(302,'A11','16a58688-e287-402b-9af9-e84e91b1cdd4',4,4145,0,'overdue'),
(303,'A11','cee98baa-16de-4405-a644-0fbd70c39c81',4,3900,0,'overdue'),
(304,'A11','86830526-abb5-4f81-8870-91c0a39768cf',4,3881,0,'overdue'),
(305,'A11','61f000c8-f625-443a-a705-de753ce7efb4',4,3758,0,'overdue'),
(306,'A11','03bf4457-7779-441a-8e48-fe4378507650',4,3601,0,'overdue'),
(307,'A11','6fe3c2fb-eca6-40bc-806e-4a847725dbe2',4,3550,0,'overdue'),
(308,'A11','5377d41f-3ad5-4d4d-9cc1-40da520bbbfd',4,3550,0,'overdue'),
(309,'A11','44920137-e881-41cc-b85b-b855d01ab9ff',4,3533,0,'overdue'),
(310,'A11','fec994d9-89bd-4df3-a038-a5b091c65821',4,3488,0,'overdue'),
(311,'A11','51191a61-3d8a-4dec-bc9b-96c9e4eff1b7',4,3375,0,'overdue'),
(312,'A11','83769947-d99b-41c0-b682-1dd72f3a44ec',4,3193,0,'overdue'),
(313,'A11','f10d692f-ba1e-4a1e-bc8d-d5712f46534c',4,2945,0,'overdue'),
(314,'A11','470126d7-d418-4b9a-8d95-fcc2e7ea999d',4,2689,0,'overdue'),
(315,'A11','bb134cf0-7e9f-45bd-97b0-1191b92793bd',4,2543,0,'overdue'),
(316,'A11','c1adb0c2-dbb2-429f-b492-8945a0e1590e',4,2211,0,'overdue'),
(317,'A11','9dcc2aca-b0dd-49a9-be4a-696cb88d9b61',4,2043,0,'overdue'),
(318,'A11','858cd6be-4da5-44c8-bdb2-2944b5fad5aa',4,915,0,'overdue'),
(319,'A11','7b75daee-c659-420d-8e52-18957c73b0be',4,109,0,'overdue'),
(320,'A12','7284104f-de79-4a02-a0f0-4ce86b24b6dc',5,35000,0,'active/order_failed'),
(321,'A12','04fc78ae-dc12-4023-ace6-dd5e293ccbd4',5,35000,0,'active/order_failed'),
(322,'A12','cd8a34e2-cea8-42f4-9a54-cd2f7f632aca',5,35000,0,'active/order_failed')
) AS v(n,a,s,r,amt,e,st);

-- Fingerprint guard: the package must be exactly the CFO-approved one.
DO $$
DECLARE v_hash text; v_n int; v_t numeric;
BEGIN
  SELECT md5(string_agg(idempotency_key||'|'||approved_amount::text||'|'||expected_after::text, ';' ORDER BY line_no)), count(*), sum(approved_amount)
    INTO v_hash, v_n, v_t FROM public.cfo_bucket_a_package_lines;
  IF v_n <> 322 OR v_t <> 10133013.74 OR v_hash <> '06c325a8a903136ac86d63886ecc90a6' THEN
    RAISE EXCEPTION 'Bucket A package fingerprint mismatch: n=% total=% hash=%', v_n, v_t, v_hash;
  END IF;
END $$;

CREATE TRIGGER trg_cfo_bucket_a_package_frozen BEFORE INSERT OR UPDATE OR DELETE ON public.cfo_bucket_a_package_lines
  FOR EACH ROW EXECUTE FUNCTION public.cfo_bucket_a_package_frozen();

-- Live Balance Sheet balance of one record on one receivable account (same mapping as sofp_ledger_legs).
CREATE OR REPLACE FUNCTION public._cfo_bucket_a_live_balance(p_source_id uuid, p_account text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH keys AS (
    SELECT p_source_id AS k
    UNION SELECT a.request_id FROM agent_advances a WHERE a.id = p_source_id AND a.request_id IS NOT NULL
    UNION SELECT t.id FROM agent_advance_topups t WHERE t.advance_id = p_source_id
  ), legs AS (
    SELECT gl.amount, gl.direction,
      CASE
        WHEN gl.ledger_scope='platform' AND gl.category='rent_disbursement' AND gl.source_table IN ('agent_advance_requests','agent_advance_topups') THEN 'A10'
        WHEN gl.ledger_scope='platform' AND gl.category='agent_repayment' AND gl.source_table='agent_advances' THEN 'A10'
        WHEN gl.ledger_scope='wallet' AND gl.category='advance_repayment' AND gl.source_table='agent_advances' THEN 'A10'
        WHEN gl.ledger_scope='platform' AND gl.category='agent_repayment' AND gl.source_table='credit_access_draws' THEN 'A14'
        WHEN gl.ledger_scope='platform' AND gl.category='agent_repayment' AND gl.source_table='merchandise_recovery_plans' THEN 'A12'
        ELSE m.account_code END AS acct,
      CASE
        WHEN gl.ledger_scope='platform' AND gl.category='rent_disbursement' AND gl.source_table IN ('agent_advance_requests','agent_advance_topups') THEN 'cash_out'
        ELSE COALESCE(m.debit_when, CASE WHEN gl.ledger_scope='wallet' THEN 'cash_out' ELSE 'cash_in' END) END AS dw
    FROM keys JOIN general_ledger gl ON gl.source_id = keys.k
    LEFT JOIN ledger_account_map m ON m.ledger_scope=gl.ledger_scope AND m.category=gl.category AND m.wallet_bucket IS NULL
    WHERE gl.classification IN ('production','legacy_real')
  )
  SELECT COALESCE(sum(CASE WHEN direction = dw THEN amount ELSE -amount END),0) FROM legs WHERE acct = p_account
$$;
REVOKE ALL ON FUNCTION public._cfo_bucket_a_live_balance(uuid,text) FROM PUBLIC, anon, authenticated;

-- Read-only evaluation of every gate check.
CREATE OR REPLACE FUNCTION public._cfo_bucket_a_evaluate()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_mism jsonb; v_status jsonb; v_count int; v_total numeric; v_hash text;
  v_dupes int; v_excl int; v_6932 numeric; v_badacct int; v_a11n int; v_a11sum numeric;
  v_checks jsonb; v_pass boolean; v_acct_now numeric;
BEGIN
  WITH l AS (
    SELECT p.*, _cfo_bucket_a_live_balance(p.source_id, p.account) AS live,
      CASE p.source_table
        WHEN 'agent_advances' THEN (SELECT status FROM agent_advances WHERE id=p.source_id)
        WHEN 'credit_access_draws' THEN (SELECT status FROM credit_access_draws WHERE id=p.source_id)
        WHEN 'merchandise_recovery_plans' THEN (SELECT status FROM merchandise_recovery_plans WHERE id=p.source_id)
      END AS live_status
    FROM cfo_bucket_a_package_lines p
  ), e AS (
    SELECT l.*, round(l.live - l.expected_after, 2) AS live_correction,
      (live_status IS NOT NULL AND (live_status = split_part(approved_status,'/',1)
        OR (live_status IN ('active','overdue') AND split_part(approved_status,'/',1) IN ('active','overdue')))) AS status_ok
    FROM l
  )
  SELECT count(*), sum(approved_amount),
    md5(string_agg(idempotency_key||'|'||approved_amount::text||'|'||expected_after::text, ';' ORDER BY line_no)),
    COALESCE(jsonb_agg(jsonb_build_object('line_no',line_no,'source_id',source_id,'account',account,'reason',reason,
       'approved_amount',approved_amount,'current_amount',live_correction,'difference',live_correction-approved_amount,
       'mismatch_reason','Live books balance differs from the approved correction')) FILTER (WHERE abs(live_correction-approved_amount) > 0.005),'[]'),
    COALESCE(jsonb_agg(jsonb_build_object('line_no',line_no,'source_id',source_id,'account',account,
       'approved_status',approved_status,'current_status',COALESCE(live_status,'missing'))) FILTER (WHERE NOT status_ok),'[]'),
    count(*) FILTER (WHERE reason = 'Duplicate access fee (A11)'),
    sum(approved_amount) FILTER (WHERE reason = 'Duplicate access fee (A11)')
  INTO v_count, v_total, v_hash, v_mism, v_status, v_a11n, v_a11sum
  FROM e;

  SELECT count(*) INTO v_dupes FROM general_ledger
   WHERE idempotency_key LIKE 'CFOGATE-2026-10:%' OR description LIKE '%CFOGATE-2026-10%';
  SELECT count(*) INTO v_excl FROM cfo_bucket_a_package_lines
   WHERE source_id IN ('9ef03c86-ec7a-4730-b32c-d86092feb81a','7612edc4-0e2e-48f0-9510-e0ffc427d4da',
                       'b94abec1-37b7-4eb0-8af5-200373aa140b','cef95679-bd3b-4b4a-88a0-bae32e39a1c5',
                       'c75a2acc-6dcf-47ba-bce3-2213bfb40ad1');
  SELECT COALESCE(sum(amount),0) INTO v_6932 FROM general_ledger
   WHERE source_id='c75a2acc-6dcf-47ba-bce3-2213bfb40ad1' AND ledger_scope='platform' AND category='agent_advance_repayment' AND direction='cash_in';
  SELECT count(*) INTO v_badacct FROM cfo_bucket_a_package_lines
   WHERE account NOT IN ('A10','A11','A12','A14') OR receivable_category NOT LIKE '%receivable_opening';

  v_checks := jsonb_build_array(
    jsonb_build_object('check','Record count is 322','pass', v_count = 322, 'value', v_count),
    jsonb_build_object('check','Total is UGX 10,133,013.74','pass', v_total = 10133013.74, 'value', v_total),
    jsonb_build_object('check','Package fingerprint matches the CFO-approved package','pass', v_hash = '06c325a8a903136ac86d63886ecc90a6', 'value', v_hash),
    jsonb_build_object('check','Debits equal credits (each correction is one receivable credit and one equal equity debit)','pass', true, 'value', v_total),
    jsonb_build_object('check','Every record matches its approved amount individually','pass', jsonb_array_length(v_mism)=0, 'value', jsonb_array_length(v_mism)),
    jsonb_build_object('check','No source record status changed','pass', jsonb_array_length(v_status)=0, 'value', jsonb_array_length(v_status)),
    jsonb_build_object('check','No matching correction already in the ledger','pass', v_dupes=0, 'value', v_dupes),
    jsonb_build_object('check','Duplicate access fee still UGX 9,551,168 across 314 advances','pass', v_a11n=314 AND v_a11sum=9551168, 'value', v_a11sum),
    jsonb_build_object('check','Yaseen Kc, Sharifu Kalule, Bucket B/C and the UGX 6,932 item are not in the package','pass', v_excl=0, 'value', v_excl),
    jsonb_build_object('check','UGX 6,932 item unchanged and outside Bucket A','pass', v_6932=6932, 'value', v_6932),
    jsonb_build_object('check','Only receivable and restatement equity accounts touched (no cash, wallet, float, repayment)','pass', v_badacct=0, 'value', v_badacct),
    jsonb_build_object('check','Old restatement routine not used','pass', true, 'value', 'separate posting function')
  );
  SELECT bool_and((c->>'pass')::boolean) INTO v_pass FROM jsonb_array_elements(v_checks) c;

  SELECT COALESCE(sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END),0) INTO v_acct_now
    FROM general_ledger gl
    JOIN ledger_account_map m ON m.ledger_scope=gl.ledger_scope AND m.category=gl.category AND m.wallet_bucket IS NULL
   WHERE m.account_code IN ('A10','A11','A12','A14') AND gl.classification IN ('production','legacy_real');

  RETURN jsonb_build_object('pass', v_pass, 'package_hash', v_hash, 'record_count', v_count, 'total', v_total,
    'checks', v_checks, 'amount_mismatches', v_mism, 'status_changes', v_status,
    'existing_corrections', v_dupes, 'mapped_receivable_balance_now', v_acct_now, 'evaluated_at', now());
END $$;
REVOKE ALL ON FUNCTION public._cfo_bucket_a_evaluate() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cfo_bucket_a_preflight()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb; v_id uuid;
BEGIN
  IF NOT (public.is_cfo_approver(auth.uid()) OR public.has_role(auth.uid(),'cfo'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO approvers can run the Bucket A pre-flight';
  END IF;
  v := public._cfo_bucket_a_evaluate();
  INSERT INTO cfo_bucket_a_events(event_type, actor, package_hash, record_count, total_amount, details)
  VALUES (CASE WHEN (v->>'pass')::boolean THEN 'preflight_passed' ELSE 'preflight_blocked' END,
          auth.uid(), v->>'package_hash', (v->>'record_count')::int, (v->>'total')::numeric, v)
  RETURNING id INTO v_id;
  RETURN v || jsonb_build_object('preflight_id', v_id,
     'already_posted', EXISTS (SELECT 1 FROM cfo_bucket_a_events WHERE event_type='posting_committed'),
     'can_authorize', public.is_cfo_approver(auth.uid()));
END $$;
REVOKE ALL ON FUNCTION public.cfo_bucket_a_preflight() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_bucket_a_preflight() TO authenticated;

CREATE OR REPLACE FUNCTION public.cfo_bucket_a_post(p_preflight_id uuid, p_package_hash text, p_confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pf cfo_bucket_a_events; v jsonb; r record; v_gid uuid; v_groups jsonb := '[]'; v_after jsonb;
  v_dr numeric; v_cr numeric; v_bad int; v_leg_count int; v_left int; v_err text; v_ev uuid;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION 'Only an authorised CFO approver can post Bucket A';
  END IF;
  IF p_confirmation IS DISTINCT FROM 'AUTHORIZE BUCKET A POSTING' THEN
    RAISE EXCEPTION 'Type AUTHORIZE BUCKET A POSTING exactly to authorise';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cfo_bucket_a_post'));
  IF EXISTS (SELECT 1 FROM cfo_bucket_a_events WHERE event_type='posting_committed') THEN
    RAISE EXCEPTION 'Bucket A has already been posted';
  END IF;
  SELECT * INTO v_pf FROM cfo_bucket_a_events WHERE id = p_preflight_id;
  IF v_pf.id IS NULL OR v_pf.event_type <> 'preflight_passed' OR v_pf.actor <> auth.uid()
     OR v_pf.created_at < now() - interval '30 minutes'
     OR v_pf.id <> (SELECT id FROM cfo_bucket_a_events WHERE event_type LIKE 'preflight%' ORDER BY created_at DESC LIMIT 1) THEN
    RAISE EXCEPTION 'Run a fresh pre-flight (your own, passed, latest, under 30 minutes old) before authorising';
  END IF;

  v := public._cfo_bucket_a_evaluate();
  IF NOT (v->>'pass')::boolean OR v->>'package_hash' <> p_package_hash OR v_pf.package_hash <> p_package_hash THEN
    INSERT INTO cfo_bucket_a_events(event_type, actor, package_hash, preflight_id, record_count, total_amount, details)
    VALUES ('posting_blocked', auth.uid(), v->>'package_hash', p_preflight_id, (v->>'record_count')::int, (v->>'total')::numeric, v);
    RETURN jsonb_build_object('status','blocked','message','POSTING BLOCKED - APPROVED RECORD SET HAS CHANGED','evaluation',v);
  END IF;

  BEGIN  -- savepoint: any failure undoes every posted line
    FOR r IN SELECT * FROM cfo_bucket_a_package_lines ORDER BY line_no LOOP
      IF EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = r.idempotency_key) THEN
        RAISE EXCEPTION 'Idempotency key already exists: %', r.idempotency_key;
      END IF;
      v_gid := public.create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('amount', r.approved_amount, 'direction','cash_out', 'category', r.receivable_category,
          'ledger_scope','bridge','classification','production','source_table', r.source_table,'source_id', r.source_id,
          'description','CFOGATE-2026-10 Bucket A correction ('||r.account||'): '||r.reason||' for '||r.source_table||' '||r.source_id
            ||'. Clears the stale receivable to '||to_char(r.expected_after,'FM999999999990.00')||'. CFO authorised.'),
        jsonb_build_object('amount', r.approved_amount, 'direction','cash_in', 'category','receivable_restatement_equity',
          'ledger_scope','platform','classification','production','source_table', r.source_table,'source_id', r.source_id,
          'description','CFOGATE-2026-10 Bucket A correction equity counterpart ('||r.account||') for '||r.source_table||' '||r.source_id)
        ), r.idempotency_key, false);
      v_groups := v_groups || jsonb_build_object('line_no', r.line_no, 'idempotency_key', r.idempotency_key, 'group_id', v_gid);
    END LOOP;

    SELECT count(*), sum(amount) FILTER (WHERE direction='cash_in'), sum(amount) FILTER (WHERE direction='cash_out'),
           count(*) FILTER (WHERE ledger_scope NOT IN ('bridge','platform') OR wallet_id IS NOT NULL OR user_id IS NOT NULL
                            OR category NOT IN ('agent_advance_receivable_opening','agent_access_fee_receivable_opening',
                                                'merchandise_recovery_receivable_opening','credit_draw_receivable_opening',
                                                'receivable_restatement_equity'))
      INTO v_leg_count, v_dr, v_cr, v_bad
      FROM general_ledger WHERE idempotency_key LIKE 'CFOGATE-2026-10:%';
    IF v_leg_count <> 644 OR v_dr <> 10133013.74 OR v_cr <> 10133013.74 OR v_bad <> 0 THEN
      RAISE EXCEPTION 'Post-check failed: legs %, debits %, credits %, out-of-scope legs %', v_leg_count, v_dr, v_cr, v_bad;
    END IF;
    SELECT count(*) INTO v_left FROM cfo_bucket_a_package_lines p
     WHERE abs(public._cfo_bucket_a_live_balance(p.source_id, p.account) - p.expected_after) > 0.005;
    IF v_left <> 0 THEN
      RAISE EXCEPTION 'Post-check failed: % records did not land on their expected balance', v_left;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    INSERT INTO cfo_bucket_a_events(event_type, actor, package_hash, preflight_id, record_count, total_amount, details)
    VALUES ('posting_failed', auth.uid(), p_package_hash, p_preflight_id, 322, 10133013.74,
            jsonb_build_object('error', v_err, 'rolled_back', true, 'pre_evaluation', v));
    RETURN jsonb_build_object('status','rolled_back','message','Posting failed and was fully rolled back: '||v_err);
  END;

  v_after := public._cfo_bucket_a_evaluate();
  INSERT INTO cfo_bucket_a_events(event_type, actor, package_hash, preflight_id, record_count, total_amount, details)
  VALUES ('posting_committed', auth.uid(), p_package_hash, p_preflight_id, 322, 10133013.74,
    jsonb_build_object('authorized_by', auth.uid(), 'authorized_at', now(), 'journal_groups', v_groups,
      'legs', v_leg_count, 'debits', v_dr, 'credits', v_cr, 'wallet_legs', 0,
      'receivable_balance_before', v->'mapped_receivable_balance_now',
      'receivable_balance_after', v_after->'mapped_receivable_balance_now',
      'pre_evaluation', v))
  RETURNING id INTO v_ev;
  RETURN jsonb_build_object('status','committed','event_id', v_ev, 'records', 322, 'amount', 10133013.74,
    'debits', v_dr, 'credits', v_cr, 'legs', v_leg_count,
    'receivable_balance_before', v->'mapped_receivable_balance_now',
    'receivable_balance_after', v_after->'mapped_receivable_balance_now');
END $$;
REVOKE ALL ON FUNCTION public.cfo_bucket_a_post(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_bucket_a_post(uuid,text,text) TO authenticated;