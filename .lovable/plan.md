# Merchant agent money movement — read-only results (no changes made)

Run Sun 25 Oct 2026 ~09:58 EAT. Read-only queries only; wallets were not joined.

## Headline answer
- **Last 24 hours (Sat 24 Oct 09:53 → Sun 25 Oct 09:55 EAT): UGX 1,306,500 paid out by Merchant agents across 15 completed withdrawals.** EMMA MAISO UGX 1,244,000 (9), Tugabirwe Apophia UGX 44,700 (3), SHAMIRAH NAKAJJUBI UGX 11,800 (2), Mudumba samuel UGX 6,000 (1).
- Ledger agrees: `wallet_withdrawal` legs in the same window = 15 rows, UGX 1,306,500. Merchant float used to settle them (`agent_float_settlement`, principal + telecom charge) = 30 rows, UGX 1,315,700.
- Full Saturday 24 Oct: UGX 1,536,500 (20). Sunday so far: UGX 46,000 (3).
- Since Sat 00:00 EAT: 23 withdrawal requests, all completed, all processed by a Merchant agent, total UGX 1,582,500.
- No payout codes, no float withdrawals and no wallet-to-wallet transfers in `wallet_transactions` since Sat 00:00 (query 4 returned 0 rows); note the ledger shows 1 `wallet_transfer` leg of UGX 10,000 in the last 24h.

## 1. Merchant agents (26 rows)

| # | id | agent_id | full_name | phone | label | is_active | handles_cash | handles_bank | handles_mtn | handles_airtel |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ce30967a-6028-48d3-adf8-32ba0b56075c | f67f7cf5-dd0c-409d-b45a-2fd0c5c4198c | Babrah Tusingwire | +256741386321 | Merchant Agent | true | false | true | true | true |
| 2 | 1c9bb2f6-3f95-47d7-8e56-f291c79d1261 | cfa56623-e6cb-4023-b601-3dbd4fdbc027 | BAYO MERCY | +256777313372 | Entebbe | true | true | true | true | true |
| 3 | edd667a7-d351-4d1f-96bd-3a439811b336 | 5fdd2ec9-42cb-4034-962c-d7117868a4ae | BRIAN KAGUMBA | +256761658253 | Merchant Agent | true | true | true | true | true |
| 4 | 60f0f832-6053-4b8a-bf67-e04ed10aa7f5 | 7f4d0676-3d06-41ec-bcce-9408dd471d9b | Catherine Nabaggala | +256743049289 | Merchant Agent | true | false | true | true | true |
| 5 | 41638329-100d-4ecf-bd96-7f30b67dcb56 | 6bb72978-1450-4800-96c2-8d1414ab2df5 | EMMA MAISO | +256700213563 | Auto-activated via merchant referral | true | false | true | true | true |
| 6 | c5d7b8e6-0595-425e-ad7d-d8cd2a6fa4ca | 151d6409-2fb2-489b-8718-646a84cf0353 | Hilary Evanz | +256756673744 | Mpala | true | false | true | true | true |
| 7 | 6078d940-3c87-425b-8b36-f6462bb2e406 | 1a88b1b8-6601-477b-b119-8e18d5dc9ebd | IMMACULATE NAMULINDWA | +256762952753 | BAITA | true | false | true | true | true |
| 8 | 3ba78a60-c40a-477c-be12-cf058d47edbb | 2d7fa6f1-492b-4340-af6f-43ca4cb141b4 | Jonathan David | +256748805119 | Merchant Agent | true | false | true | true | true |
| 9 | b7cf4ce1-6bfc-42ff-a67c-8f23af3db6cf | cb798acb-68bc-4b4e-a414-a3d374e030b6 | JOSHUA WANDA | +256704825473 | Merchant Agent | true | true | true | true | true |
| 10 | 9068346b-a769-41b1-8578-a70105602297 | 475c6ccb-166c-41cd-b2a8-386c99777138 | Keith Asea | +256783524747 | Auto-activated via merchant referral | true | false | true | true | true |
| 11 | d61ad695-9734-42f3-9f76-2f0a4669f78f | edd7aee0-8f6f-4923-85a3-031d4be52da6 | MBABAZI ROBERT | +256751237003 | Merchant Agent | true | false | true | true | true |
| 12 | a1603adc-3831-4a3e-a6b9-99255a6c04a6 | 5f5847d2-d719-40f1-a702-297da1417bc7 | Mudumba samuel | +256750132490 | ENTEBBE | true | false | true | true | true |
| 13 | 8fe2b711-381a-48f6-87bc-968ecb0a2662 | 5be34dc0-4535-4f61-8c85-f92f2713f652 | MULUNGI AIDAH | +256702874567 | Merchant Agent | true | false | true | true | true |
| 14 | e21f26e5-ca1f-48ec-952d-a2b5509f4ea5 | 5240055a-e65f-4a2d-aa2a-d30a0e16c982 | NABBAALE CLAIRE | +256766796539 | ENTEBBE | true | true | true | true | true |
| 15 | 3c664192-cd2b-4c83-94d1-cf3f3df8338f | 27d5a08b-5fee-452e-bc9a-bc8064f96ae3 | NAMULINDWA IMMECULATE | +256741003567 | Merchant Agent | true | false | true | true | true |
| 16 | 3fa7e39c-2392-4a0b-8e1e-325058a1ea35 | af04d74b-9c3d-40ea-b99d-41e0a9d59688 | SHAMIRAH NAKAJJUBI | +256706196246 | Merchant Agent | true | false | true | true | true |
| 17 | 9a20443b-56bb-4ade-b4aa-222711b78bd3 | f7a64907-4c93-4a50-b7ac-cb192a78d71c | Tugabirwe Apophia | +256782706146 | Merchant Agent | true | false | true | true | true |
| 18 | 607a0c9f-d0f1-484e-ac24-bd0f33391f4a | 2d3cdd17-3831-40fa-8011-8646a97fbfb0 | Benjamin Muhanguzi |  | Merchant Agent | false | true | true | true | true |
| 19 | 74151890-8b44-404b-992e-b3d1c9d5a613 | cf561688-b3a2-4f62-b9c1-67ee7b36ff2b | Benjamin Muhanguzi | +256783673998 | ENTEBBE | false | true | true | true | true |
| 20 | d2253ec5-c422-4a3e-b47d-c75a9ff06292 | 680b2170-bacc-4df1-b5bb-76a03d2daf85 | Grace Paul | +256700212384 | Auto-activated via merchant referral | false | true | true | true | true |
| 21 | 4c52db6b-0747-477d-bc7e-0a360d3d2c54 | 99890a2e-b842-4d44-8516-e2eafe0711ff | GRACE PAUL OCHIENG | +254733803035 | Auto-activated via merchant referral | false | false | false | false | false |
| 22 | 3e181dd5-1a4a-41fc-94fe-7015e345d963 | 7e201db3-d770-44f1-87db-f236febb5678 | Martin Bot | +256708257899 | Test User | false | true | true | true | true |
| 23 | e8f4e201-751f-48bf-82ae-dec3a6d2291c | 6b7d9eee-4bc8-47ac-a2e6-b84cbaac8bb4 | MERCY BAYO | +256706052465 | ENTEBBE | false | true | true | true | true |
| 24 | 06ec167e-ac05-4dcc-84a8-86411634f92a | 59d45ad2-0d44-433c-b4ec-20927a25c281 | Nankambo sharimah | +256708269084 | Merchant Agent | false | true | true | true | true |
| 25 | 7333cec6-2472-46a8-a714-be24e5022f36 | 0b109aad-212a-4fd0-ab03-3d7aee9cf397 | PIUS LUBEGA SSENKAALI | +256701355246 | Merchant Agent | false | true | true | true | true |
| 26 | d91e05aa-31a5-4735-8fe6-d78d90ca3870 | 29a0cfa8-1eaf-453c-874c-0fc72fa4f74b | SARAH ANGWEN | +256785093196 | Merchant Agent | false | true | true | true | true |

## 2. Every withdrawal request since Sat 24 Oct 00:00 EAT (23 rows)

| # | id | amount | status | payout_method | fin_ops_payment_method | fin_ops_reference | transaction_id | payout_code | reason | requester_name | requester_phone | processor_name | processor_phone | assigned_agent_name | proc_is_merchant | req_is_merchant | created_eat | processed_eat |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 74cba9c1-ef62-4b10-bea3-8b87978b4d79 | 6000 | completed | mobile_money | Mobile Money | TID159727406201 | — | — | Wallet withdrawal | JOSHUA BALIRAINE | +256786793933 | EMMA MAISO | +256700213563 | EMMA MAISO | true | false | 2026-10-25 07:39:16 | 2026-10-25 08:25:41 |
| 2 | acc72f1c-f6e9-4a04-9361-418669378c5d | 34000 | completed | mobile_money | Mobile Money | 44518309828 | — | — | Wallet withdrawal | MULUNGI AIDAH | +256702874567 | Tugabirwe Apophia | +256782706146 | Tugabirwe Apophia | true | true | 2026-10-25 08:06:50 | 2026-10-25 08:24:32 |
| 3 | 10b09922-f1bd-44af-8fa8-dcf5a10c36d4 | 6000 | completed | mobile_money | Mobile Money | TID159722051303 | — | — | Wallet withdrawal | FLAVIA KUKIRIZA | +256745600092 | Mudumba samuel | +256750132490 | Mudumba samuel | true | false | 2026-10-25 01:17:55 | 2026-10-25 01:38:50 |
| 4 | 44f50146-605d-4a8b-a01a-97487fc6ea79 | 8800 | completed | mobile_money | Mobile Money | TID159708705617 | — | — | Wallet withdrawal | EMMA MAISO | +256700213563 | SHAMIRAH NAKAJJUBI | +256706196246 | SHAMIRAH NAKAJJUBI | true | true | 2026-10-24 20:04:32 | 2026-10-24 20:51:49 |
| 5 | 5fa52146-c610-4917-924a-989b3440b06d | 500000 | completed | mobile_money | Mobile Money | TID159693289424 | — | — | Wallet withdrawal | GRACE PAUL OCHIENG | +254733803035 | EMMA MAISO | +256700213563 | EMMA MAISO | true | true | 2026-10-24 18:38:49 | 2026-10-24 18:42:40 |
| 6 | ba254e3b-761e-42cc-9e78-c89b8611727d | 200000 | completed | mobile_money | Mobile Money | TID159692059062 | — | — | Wallet withdrawal | KWENSERI ROGERS | +256779164280 | EMMA MAISO | +256700213563 | EMMA MAISO | true | false | 2026-10-24 18:27:51 | 2026-10-24 18:29:57 |
| 7 | d26c15d1-c068-40a1-85f5-78afaa8413c3 | 100000 | completed | mobile_money | Mobile Money | TID159685893644 | — | — | Wallet withdrawal | KWENSERI ROGERS | +256779164280 | EMMA MAISO | +256700213563 | EMMA MAISO | true | false | 2026-10-24 17:16:19 | 2026-10-24 17:19:09 |
| 8 | 88bb66fc-c276-43af-91db-e725a32e8794 | 13000 | completed | mobile_money | Mobile Money | TID159676537815 | — | — | Wallet withdrawal | NSUBUGA Lawrence George | +256705133346 | EMMA MAISO | +256700213563 | EMMA MAISO | true | false | 2026-10-24 15:21:31 | 2026-10-24 15:24:56 |
| 9 | 37d85d87-417b-4843-b156-eedf782699a6 | 200000 | completed | mobile_money | Mobile Money | TID159676413218 | — | — | Wallet withdrawal | ARINAITWE MARTIN BRIAN | +256751487521 | EMMA MAISO | +256700213563 | EMMA MAISO | true | false | 2026-10-24 15:08:33 | 2026-10-24 15:23:26 |
| 10 | ac1fc103-2791-4699-8a12-3101e08ef7e8 | 200000 | completed | mobile_money | Mobile Money | TID159663038506 | — | — | Wallet withdrawal | KWENSERI ROGERS | +256779164280 | EMMA MAISO | +256700213563 | EMMA MAISO | true | false | 2026-10-24 12:39:31 | 2026-10-24 12:45:47 |
| 11 | 8328b950-f35f-4f57-be83-a12b02b2a1c2 | 5700 | completed | mobile_money | Mobile Money | 44489065988 | — | — | Wallet withdrawal | Wafula Ronald ojiambo | +256730128819 | Tugabirwe Apophia | +256782706146 | Tugabirwe Apophia | true | false | 2026-10-24 11:14:54 | 2026-10-24 11:46:18 |
| 12 | 14ea399a-4ea3-4958-be79-f97ad7a5c40f | 3000 | completed | mobile_money | Mobile Money | TID159653852913 | — | — | Wallet withdrawal | CHEMAYEK ABRAHAM | +256775077741 | SHAMIRAH NAKAJJUBI | +256706196246 | SHAMIRAH NAKAJJUBI | true | false | 2026-10-24 10:50:03 | 2026-10-24 10:53:27 |
| 13 | 2594aac3-50df-4f17-ac51-72f13606047d | 5000 | completed | mobile_money | Mobile Money | 44487169924 | — | — | Wallet withdrawal | Mukisa juli | +256707911662 | Tugabirwe Apophia | +256782706146 | Tugabirwe Apophia | true | false | 2026-10-24 10:11:17 | 2026-10-24 10:39:25 |
| 14 | ab350f5a-0af0-4d56-92ff-2007b62195f1 | 10000 | completed | mobile_money | Mobile Money | TID159649988039 | — | — | Wallet withdrawal | PIUS NIWAGABA | +256731863655 | EMMA MAISO | +256700213563 | EMMA MAISO | true | false | 2026-10-24 09:50:04 | 2026-10-24 10:02:57 |
| 15 | c94b7f9f-92b1-40d8-96c8-ff8b6ee3305c | 15000 | completed | mobile_money | Mobile Money | TID159649815902 | — | — | Wallet withdrawal | SARAH ANGWEN | +256785093196 | EMMA MAISO | +256700213563 | EMMA MAISO | true | true | 2026-10-24 09:52:45 | 2026-10-24 10:01:08 |
| 16 | 8e2a65af-0f08-4b8e-bfc7-daa8f1cdf1f3 | 9000 | completed | mobile_money | Mobile Money | TID159648254707 | — | — | Wallet withdrawal | SULAIMAN MAYANJA | +256731955402 | EMMA MAISO | +256700213563 | EMMA MAISO | true | false | 2026-10-24 09:31:14 | 2026-10-24 09:38:51 |
| 17 | ed302e2b-6719-4e01-a171-3900e856a709 | 79000 | completed | mobile_money | Mobile Money | TID159646151861 | — | — | Wallet withdrawal | KWENSERI ROGERS | +256779164280 | SHAMIRAH NAKAJJUBI | +256706196246 | SHAMIRAH NAKAJJUBI | true | false | 2026-10-24 09:05:22 | 2026-10-24 09:07:41 |
| 18 | 1e25a660-c5f8-4ccd-a09b-46693edc5f44 | 13000 | completed | mobile_money | Mobile Money | 44485120838 | — | — | Wallet withdrawal | YAHYA KABANDA | +256704452150 | Tugabirwe Apophia | +256782706146 | Tugabirwe Apophia | true | false | 2026-10-24 08:49:05 | 2026-10-24 08:52:39 |
| 19 | af7bad3b-b9ad-4af0-b60a-11062136ee26 | 20000 | completed | mobile_money | Mobile Money | 44485034571 | — | — | Wallet withdrawal | PRISCILLA LOLEM | +256767923127 | Tugabirwe Apophia | +256782706146 | Tugabirwe Apophia | true | false | 2026-10-24 08:45:23 | 2026-10-24 08:49:29 |
| 20 | fad2a1a2-e458-427c-8ddb-8f4201dc7387 | 57000 | completed | mobile_money | Mobile Money | TID159640468253 | — | — | Wallet withdrawal | BAKASHABA GERALD | +256745168290 | EMMA MAISO | +256700213563 | EMMA MAISO | true | false | 2026-10-24 06:31:52 | 2026-10-24 06:45:32 |
| 21 | d0b663e7-7292-474d-8ef7-40e48e4e9439 | 8000 | completed | mobile_money | Mobile Money | 44482265035 | — | — | Wallet withdrawal | GEORGERAPHAEL OJULONG | +256773585196 | Tugabirwe Apophia | +256782706146 | Tugabirwe Apophia | true | false | 2026-10-23 22:10:20 | 2026-10-24 00:30:55 |
| 22 | d37ffa44-7355-48c0-8827-9df90431e27d | 40000 | completed | mobile_money | Mobile Money | 44482253270 | — | — | Wallet withdrawal | PRISCILLA LOLEM | +256767923127 | Tugabirwe Apophia | +256782706146 | Tugabirwe Apophia | true | false | 2026-10-23 23:16:38 | 2026-10-24 00:27:57 |
| 23 | 46e7d603-12a6-4d6c-84c6-4439ce2c8b7d | 50000 | completed | mobile_money | Mobile Money | TID159637238101 | — | — | Wallet withdrawal | MERCY BAYO | +256706052465 | Mudumba samuel | +256750132490 | Mudumba samuel | true | true | 2026-10-23 22:25:56 | 2026-10-24 00:25:55 |

## 3. Merchant-processed withdrawals by day, 18–25 Oct EAT (52 rows)

| # | day_eat | status | merchant_agent | merchant_phone | tx_count | total_ugx |
|---|---|---|---|---|---|---|
| 1 | 2026-10-25 | completed | Tugabirwe Apophia | +256782706146 | 1 | 34000 |
| 2 | 2026-10-25 | completed | Mudumba samuel | +256750132490 | 1 | 6000 |
| 3 | 2026-10-25 | completed | EMMA MAISO | +256700213563 | 1 | 6000 |
| 4 | 2026-10-24 | completed | EMMA MAISO | +256700213563 | 10 | 1304000 |
| 5 | 2026-10-24 | completed | Tugabirwe Apophia | +256782706146 | 6 | 91700 |
| 6 | 2026-10-24 | completed | SHAMIRAH NAKAJJUBI | +256706196246 | 3 | 90800 |
| 7 | 2026-10-24 | completed | Mudumba samuel | +256750132490 | 1 | 50000 |
| 8 | 2026-10-23 | completed | IMMACULATE NAMULINDWA | +256762952753 | 13 | 41264500 |
| 9 | 2026-10-23 | completed | Tugabirwe Apophia | +256782706146 | 9 | 3919000 |
| 10 | 2026-10-23 | completed | Babrah Tusingwire | +256741386321 | 7 | 2629250 |
| 11 | 2026-10-23 | completed | Mudumba samuel | +256750132490 | 21 | 2146600 |
| 12 | 2026-10-23 | completed | SHAMIRAH NAKAJJUBI | +256706196246 | 11 | 1892000 |
| 13 | 2026-10-23 | completed | EMMA MAISO | +256700213563 | 11 | 1741000 |
| 14 | 2026-10-23 | completed | MULUNGI AIDAH | +256702874567 | 5 | 1484600 |
| 15 | 2026-10-22 | completed | IMMACULATE NAMULINDWA | +256762952753 | 17 | 57813988 |
| 16 | 2026-10-22 | rejected | JOSHUA WANDA | +256704825473 | 16 | 7290000 |
| 17 | 2026-10-22 | completed | NABBAALE CLAIRE | +256766796539 | 12 | 6661000 |
| 18 | 2026-10-22 | completed | Mudumba samuel | +256750132490 | 16 | 5458334 |
| 19 | 2026-10-22 | completed | EMMA MAISO | +256700213563 | 9 | 4967162 |
| 20 | 2026-10-22 | completed | SHAMIRAH NAKAJJUBI | +256706196246 | 22 | 3596000 |
| 21 | 2026-10-22 | completed | Babrah Tusingwire | +256741386321 | 6 | 2347232 |
| 22 | 2026-10-22 | completed | Tugabirwe Apophia | +256782706146 | 4 | 1922712 |
| 23 | 2026-10-22 | rejected | Nankambo sharimah | +256708269084 | 2 | 600000 |
| 24 | 2026-10-21 | completed | IMMACULATE NAMULINDWA | +256762952753 | 2 | 3975000 |
| 25 | 2026-10-21 | completed | Mudumba samuel | +256750132490 | 12 | 3119500 |
| 26 | 2026-10-21 | completed | Babrah Tusingwire | +256741386321 | 8 | 2251000 |
| 27 | 2026-10-21 | completed | MULUNGI AIDAH | +256702874567 | 8 | 1975060 |
| 28 | 2026-10-21 | completed | Tugabirwe Apophia | +256782706146 | 9 | 1819900 |
| 29 | 2026-10-21 | completed | SHAMIRAH NAKAJJUBI | +256706196246 | 6 | 1282800 |
| 30 | 2026-10-21 | completed | EMMA MAISO | +256700213563 | 5 | 1145700 |
| 31 | 2026-10-21 | completed | NABBAALE CLAIRE | +256766796539 | 12 | 592000 |
| 32 | 2026-10-21 | completed | Hilary Evanz | +256756673744 | 2 | 56000 |
| 33 | 2026-10-20 | completed | IMMACULATE NAMULINDWA | +256762952753 | 9 | 73052956 |
| 34 | 2026-10-20 | completed | Tugabirwe Apophia | +256782706146 | 4 | 8800313 |
| 35 | 2026-10-20 | completed | NABBAALE CLAIRE | +256766796539 | 30 | 5388212 |
| 36 | 2026-10-20 | completed | Hilary Evanz | +256756673744 | 4 | 4520000 |
| 37 | 2026-10-20 | completed | EMMA MAISO | +256700213563 | 9 | 3803269 |
| 38 | 2026-10-20 | completed | SHAMIRAH NAKAJJUBI | +256706196246 | 17 | 3745500 |
| 39 | 2026-10-20 | completed | Babrah Tusingwire | +256741386321 | 10 | 3208000 |
| 40 | 2026-10-20 | completed | Mudumba samuel | +256750132490 | 14 | 2879669 |
| 41 | 2026-10-20 | completed | MULUNGI AIDAH | +256702874567 | 3 | 1602000 |
| 42 | 2026-10-19 | completed | IMMACULATE NAMULINDWA | +256762952753 | 32 | 84941025 |
| 43 | 2026-10-19 | completed | EMMA MAISO | +256700213563 | 11 | 7408000 |
| 44 | 2026-10-19 | completed | Mudumba samuel | +256750132490 | 16 | 7259544 |
| 45 | 2026-10-19 | completed | SHAMIRAH NAKAJJUBI | +256706196246 | 13 | 7033000 |
| 46 | 2026-10-19 | completed | NABBAALE CLAIRE | +256766796539 | 13 | 6848500 |
| 47 | 2026-10-19 | completed | Tugabirwe Apophia | +256782706146 | 11 | 5237750 |
| 48 | 2026-10-19 | completed | Babrah Tusingwire | +256741386321 | 10 | 5047500 |
| 49 | 2026-10-19 | completed | Hilary Evanz | +256756673744 | 5 | 2675000 |
| 50 | 2026-10-19 | completed | MULUNGI AIDAH | +256702874567 | 9 | 2634020 |
| 51 | 2026-10-18 | completed | SHAMIRAH NAKAJJUBI | +256706196246 | 6 | 670694 |
| 52 | 2026-10-18 | completed | Mudumba samuel | +256750132490 | 1 | 4000 |

## 4. Payout codes, wallet transfers, float withdrawals since Sat 24 Oct 00:00 EAT (0 rows)
No rows in any of the three tables.

## 5. Ledger wallet cash-out since Sat 24 Oct 00:00 EAT

| Window | Category | Source | Rows | Total |
|---|---|---|---|---|
| earlier Sat 24 Oct (00:00–09:53) | agent_float_used_for_rent | agent_collections | 26 | UGX 676,086 |
| earlier Sat 24 Oct | agent_float_settlement | withdrawal_requests | 16 | UGX 280,500 |
| earlier Sat 24 Oct | wallet_withdrawal | withdrawal_requests | 8 | UGX 276,000 |
| earlier Sat 24 Oct | bucket_reclass_out | agent_withdrawable_to_float | 2 | UGX 64,086 |
| earlier Sat 24 Oct | agent_repayment | merchandise_recovery_plans | 2 | UGX 4,932 |
| earlier Sat 24 Oct | agent_repayment | agent_advances | 2 | UGX 1,000 |
| last 24h | agent_float_used_for_rent | agent_collections | 190 | UGX 3,114,465 |
| last 24h | agent_float_settlement | withdrawal_requests | 30 | UGX 1,315,700 |
| last 24h | wallet_withdrawal | withdrawal_requests | 15 | UGX 1,306,500 |
| last 24h | agent_repayment | agent_advances | 42 | UGX 115,459.44 |
| last 24h | bucket_reclass_out | agent_withdrawable_to_float | 14 | UGX 75,801 |
| last 24h | agent_float_deposit | deposit_requests | 1 | UGX 15,000 |
| last 24h | wallet_transfer | wallet_transactions | 1 | UGX 10,000 |
| last 24h | agent_repayment | merchandise_recovery_plans | 5 | UGX 6,744 |

Note: "earlier Sat" withdrawal legs (UGX 276,000) come from requests processed after midnight but before 09:53, which is why Saturday's full-day total (UGX 1,536,500) exceeds the 24-hour figure.

---

# Wallet totals and last-24h wallet movements (read-only, run 25 Oct ~10:58 EAT)

## W1a. Wallet totals cache (computed 2026-10-25 10:57:00 EAT)
| total_wallets | active_wallets | total_balance | total_withdrawable | total_float | strict_total | drifted_wallets | total_drift |
|---|---|---|---|---|---|---|---|
| 97,822 | 1,133 | UGX 121,888,015.03 | UGX 62,503,085.03 | UGX 59,384,930 | UGX 79,616,382.03 | 1,095 | UGX 0 |

## W1b. Wallet balances projection + open withdrawals
| proj_users | active_users | total_visible | withdrawable | float | advance | pending_holds | restricted_held | open withdrawals | open withdrawals UGX |
|---|---|---|---|---|---|---|---|---|---|
| 58,371 | 1,121 | UGX 121,867,815.03 | UGX 62,484,385.03 | UGX 59,383,430 | UGX 17,332,792 | UGX 740,000 | UGX 0 | 119 | UGX 25,338,014 |

## W2. Last 24h wallet ledger by bucket / direction / category
| Bucket | Direction | Category | Source | Rows | Total |
|---|---|---|---|---|---|
| advance_credit | cash_in | agent_advance_credit | agent_advances | 296 | UGX 337,761 |
| float | cash_in | agent_float_deposit | deposit_requests | 61 | UGX 3,271,200 |
| float | cash_in | agent_float_deposit | cfo_direct_credit | 1 | UGX 1,000,000 |
| float | cash_in | bucket_reclass_in | agent_withdrawable_to_float | 16 | UGX 104,801 |
| float | cash_out | agent_float_used_for_rent | agent_collections | 198 | UGX 3,401,965 |
| float | cash_out | agent_float_settlement | withdrawal_requests | 24 | UGX 1,297,000 |
| float | cash_out | agent_float_deposit | deposit_requests | 1 | UGX 15,000 |
| withdrawable | cash_in | system_balance_correction | payroll_growth_balances | 85 | UGX 879,523 |
| withdrawable | cash_in | agent_commission_earned | agent_collections | 329 | UGX 340,196.50 |
| withdrawable | cash_in | wallet_deposit | cfo_direct_credit | 30 | UGX 111,000 |
| withdrawable | cash_in | wallet_transfer | wallet_transactions | 1 | UGX 10,000 |
| withdrawable | cash_in | agent_commission_earned | withdrawal_requests | 12 | UGX 6,443 |
| withdrawable | cash_out | wallet_withdrawal | withdrawal_requests | 12 | UGX 1,288,500 |
| withdrawable | cash_out | agent_repayment | agent_advances | 50 | UGX 122,039.44 |
| withdrawable | cash_out | bucket_reclass_out | agent_withdrawable_to_float | 16 | UGX 104,801 |
| withdrawable | cash_out | wallet_transfer | wallet_transactions | 1 | UGX 10,000 |
| withdrawable | cash_out | agent_repayment | merchandise_recovery_plans | 5 | UGX 6,744 |


