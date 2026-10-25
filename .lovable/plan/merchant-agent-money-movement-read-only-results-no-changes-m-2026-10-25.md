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


## W3. Latest wallet movements, last 24h (120 rows)

| # | grp | id | time_eat | full_name | phone | amount | direction | bucket | category | source_table | ref_tid | description |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1_withdrawable_key | b168df36-ff10-4837-8b8f-5bdcc66649e6 | 2026-10-25 10:37:11 | ALPHA SSEMA | +256752760263 | 24000 | cash_out | withdrawable | bucket_reclass_out | agent_withdrawable_to_float | AGT-WDR2FLT-a2bb829a-891f-47fd-9d31-732d63f87cf7 | Converted UGX 24,000 from your balance to Float (agent self-service). |
| 2 | 1_withdrawable_key | bb67f8a2-6ace-4805-95d6-29189bf87198 | 2026-10-25 10:25:57 | Wasukila Muzamilu | +256778189898 | 5000 | cash_out | withdrawable | bucket_reclass_out | agent_withdrawable_to_float | AGT-WDR2FLT-d86510f4-8416-478a-bef2-f777c88776c3 | Converted UGX 5,000 from your balance to Float (agent self-service). |
| 3 | 1_withdrawable_key | 72ea4e82-e41a-4f8e-a2cb-e1cc2fda9071 | 2026-10-25 10:15:03 | NSUBUGA Lawrence George | +256705133346 | 15000 | cash_out | withdrawable | wallet_withdrawal | withdrawal_requests | 0318942b-22cc-4103-814d-952ec83ea7e6 | Wallet withdrawal approved – Mobile Money ref: TID159734302445 |
| 4 | 1_withdrawable_key | 2d62fb54-447a-4c3e-a79d-1d28f90eef35 | 2026-10-25 09:10:11 | DERRICK LUTAMAGUZI | +256795634656 | 1850 | cash_out | withdrawable | bucket_reclass_out | agent_withdrawable_to_float | AGT-WDR2FLT-5f745c8f-041a-4324-b7ad-4d7c8da105e6 | Converted UGX 1,850 from your balance to Float (agent self-service). |
| 5 | 1_withdrawable_key | 5ef6fe7e-6848-4eb9-bdd8-d776ebf30b1f | 2026-10-25 08:46:25 | SHAKIRAH NAKIMBUGWE | +256770603906 | 1600 | cash_out | withdrawable | bucket_reclass_out | agent_withdrawable_to_float | AGT-WDR2FLT-0dfd97c6-e03e-4242-aa17-f8243fac1241 | Converted UGX 1,600 from your balance to Float (agent self-service). |
| 6 | 1_withdrawable_key | 71cb77d8-ae05-4d34-a496-6f32f844ca20 | 2026-10-25 08:43:23 | SHAKIRAH NAKIMBUGWE | +256770603906 | 8000 | cash_out | withdrawable | bucket_reclass_out | agent_withdrawable_to_float | AGT-WDR2FLT-66873ead-db1f-4c5f-ac01-9eded33392d5 | Converted UGX 8,000 from your balance to Float (agent self-service). |
| 7 | 1_withdrawable_key | e473bb80-5102-459c-97bf-4dde5d4f276b | 2026-10-25 08:25:41 | JOSHUA BALIRAINE | +256786793933 | 6000 | cash_out | withdrawable | wallet_withdrawal | withdrawal_requests | 74cba9c1-ef62-4b10-bea3-8b87978b4d79 | Wallet withdrawal approved – Mobile Money ref: TID159727406201 |
| 8 | 1_withdrawable_key | e0a736a0-2d7d-4eb2-8a63-726096593585 | 2026-10-25 08:24:31 | MULUNGI AIDAH | +256702874567 | 34000 | cash_out | withdrawable | wallet_withdrawal | withdrawal_requests | acc72f1c-f6e9-4a04-9361-418669378c5d | Wallet withdrawal approved – Mobile Money ref: 44518309828 |
| 9 | 1_withdrawable_key | 7ae76969-5345-4531-94b5-bbc5cb2aee83 | 2026-10-25 07:58:56 | Benjamin Muhanguzi | +256783673998 | 10000 | cash_out | withdrawable | wallet_transfer | wallet_transactions | WT-AF28BE1A | Transfer to BRENDA NABATEREGGA: Welile Gift |
| 10 | 1_withdrawable_key | 8a01c3c3-83bc-4c75-9c75-0383bbcaca05 | 2026-10-25 07:58:56 | BRENDA NABATEREGGA | +256731851319 | 10000 | cash_in | withdrawable | wallet_transfer | wallet_transactions | WT-AF28BE1A | Transfer from Benjamin Muhanguzi: Welile Gift |
| 11 | 1_withdrawable_key | 2b275d57-8f62-4a7a-bd44-a0618f468faf | 2026-10-25 03:00:35 | BAYO MERCY | +256777313372 | 13937 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AJB5-OD1B | Payroll loyalty bonus 0.5%/day [src=PAY-MUCMK91A-9HKY] |
| 12 | 1_withdrawable_key | bde18127-423c-4af5-bcf0-13016559fc35 | 2026-10-25 03:00:35 | PIUS LUBEGA SSENKAALI | +256701355246 | 15 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AJ80-FN6X | Payroll loyalty bonus 0.5%/day [src=PAY-MVGDRE9E-WUIO] |
| 13 | 1_withdrawable_key | cd29bf0d-ad58-483e-878a-196ee011b9f1 | 2026-10-25 03:00:35 | Nankambo sharimah | +256708269084 | 15 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AJ3B-YQRJ | Payroll loyalty bonus 0.5%/day [src=PAY-MVGDNQSX-Z803] |
| 14 | 1_withdrawable_key | 99185a50-e10e-45b7-ade3-875e629f6ff7 | 2026-10-25 03:00:35 | Muwanguzi Gideon | +256703406836 | 15 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AJ05-U26C | Payroll loyalty bonus 0.5%/day [src=PAY-MVGDJR8I-LCON] |
| 15 | 1_withdrawable_key | 54068391-851d-4fdc-88ae-1ed801264bf3 | 2026-10-25 03:00:34 | JANEHEPHZIBAR GIMONO | +256774958094 | 15 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AIVM-PBEE | Payroll loyalty bonus 0.5%/day [src=PAY-MVGD5F55-UAAD] |
| 16 | 1_withdrawable_key | 8967e057-08b8-42f6-8561-81f3f0168d0b | 2026-10-25 03:00:34 | GRACE PAUL OCHIENG | +254733803035 | 15 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AIQ1-04J3 | Payroll loyalty bonus 0.5%/day [src=PAY-MVGCZ827-H0YR] |
| 17 | 1_withdrawable_key | f4177cf1-aa71-4b9a-aebc-474598825ab4 | 2026-10-25 03:00:34 | BAYO MERCY | +256777313372 | 15 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AIK4-TTPY | Payroll loyalty bonus 0.5%/day [src=PAY-MVGCKDUN-HZ4U] |
| 18 | 1_withdrawable_key | 81f88369-6df9-4f34-a282-43894b67145c | 2026-10-25 03:00:34 | ATUHAIRE CAROLYNE | +256761135206 | 15 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AIE0-8STG | Payroll loyalty bonus 0.5%/day [src=PAY-MVGCH0SP-NK0F] |
| 19 | 1_withdrawable_key | 0bb7600f-62f9-45a4-8ac7-4730449c6281 | 2026-10-25 03:00:34 | ENOCK EUGINE LWEGABA | +256757966036 | 24448 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AI7W-MA98 | Payroll loyalty bonus 0.5%/day [src=PAY-MT17DVUK-WRO2] |
| 20 | 1_withdrawable_key | 76716de0-96e9-4c88-a98a-006f4ff9340b | 2026-10-25 03:00:33 | AINEMBABAZI KEViN | +256776850799 | 1279 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AI2U-0YLR | Payroll loyalty bonus 0.5%/day [src=PAY-MQZ89MPE-V17I] |
| 21 | 1_withdrawable_key | 6a8f7730-2e44-4fce-b662-18a60506a28d | 2026-10-25 03:00:33 | BAYO MERCY | +256777313372 | 33055 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AHWK-VN69 | Payroll loyalty bonus 0.5%/day [src=PAY-MTBE6B8W-XBRY] |
| 22 | 1_withdrawable_key | 545b0c12-d693-4ead-93e8-b88fd029da58 | 2026-10-25 03:00:33 | GRACE PAUL OCHIENG | +254733803035 | 747 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AHPG-CZOI | Payroll loyalty bonus 0.5%/day [src=PAY-MUFGPNJF-UZMY] |
| 23 | 1_withdrawable_key | 1056fead-7daf-4573-abf4-2fe8c074b747 | 2026-10-25 03:00:33 | MERCY BAYO | +256706052465 | 1083 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AHI9-X6ML | Payroll loyalty bonus 0.5%/day [src=PAY-MUWSRK8U-ZTFC] |
| 24 | 1_withdrawable_key | 00e85b29-65c3-496d-add6-e8fc61c06e09 | 2026-10-25 03:00:32 | BAYO MERCY | +256777313372 | 5794 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AHC6-IM4O | Payroll loyalty bonus 0.5%/day [src=PAY-MUWH5QRY-G0Z4] |
| 25 | 1_withdrawable_key | e001de63-4c7e-4f5c-bea8-1b6e65497ffe | 2026-10-25 03:00:32 | GRACE PAUL OCHIENG | +254733803035 | 674 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AH2T-7IA8 | Payroll loyalty bonus 0.5%/day [src=PAY-MUYC0WN7-P8D7] |
| 26 | 1_withdrawable_key | 57df8bb3-f966-41c7-8092-cd262b76c5df | 2026-10-25 03:00:32 | GRACE PAUL OCHIENG | +254733803035 | 1278 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AGTR-BWTT | Payroll loyalty bonus 0.5%/day [src=PAY-MUCLMKRO-JXKY] |
| 27 | 1_withdrawable_key | 89870491-e47e-4276-9823-8d84fcf62a9f | 2026-10-25 03:00:31 | BAYO MERCY | +256777313372 | 12 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AGMH-1QQO | Payroll loyalty bonus 0.5%/day [src=PAY-MU47WL2D-Z18T] |
| 28 | 1_withdrawable_key | 55c01d2d-405f-4ae2-8e9c-7fe5a56ebfae | 2026-10-25 03:00:31 | MARVIN SSEMBATYA | +256702071819 | 574 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AGFZ-ZRK5 | Payroll loyalty bonus 0.5%/day [src=PAY-MV7U1AR0-JQT8] |
| 29 | 1_withdrawable_key | 32d60494-9476-4185-89ea-da413627efcb | 2026-10-25 03:00:31 | ENOCK EUGINE LWEGABA | +256757966036 | 7651 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AGA9-165C | Payroll loyalty bonus 0.5%/day [src=PAY-MVF9KDOR-E9IB] |
| 30 | 1_withdrawable_key | ae6b0f06-5e37-48bc-b3ea-f3b6df41ef17 | 2026-10-25 03:00:31 | Nankambo sharimah | +256708269084 | 4047 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AG3J-5TQ8 | Payroll loyalty bonus 0.5%/day [src=PAY-MTWVK9L5-KB9J] |
| 31 | 1_withdrawable_key | f678d34b-390d-4886-8dd8-aaefe973d581 | 2026-10-25 03:00:30 | GRACE PAUL OCHIENG | +254733803035 | 37397 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AFWA-7DGA | Payroll loyalty bonus 0.5%/day [src=PAY-MTX0NTCT-8M33] |
| 32 | 1_withdrawable_key | a043cd97-ddc6-4113-bfe0-f0e7e1fa85ce | 2026-10-25 03:00:30 | BAYO MERCY | +256777313372 | 2003 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AFQH-UFG2 | Payroll loyalty bonus 0.5%/day [src=PAY-MUCLN09O-FFOC] |
| 33 | 1_withdrawable_key | 34264f63-29fd-40cb-9ac9-56d091c79717 | 2026-10-25 03:00:30 | BAYO MERCY | +256777313372 | 664 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AFIC-FXE6 | Payroll loyalty bonus 0.5%/day [src=PAY-MTA3IZIP-TQGQ] |
| 34 | 1_withdrawable_key | 82e55892-5db9-426a-883e-b5f91575a490 | 2026-10-25 03:00:30 | GRACE PAUL OCHIENG | +254733803035 | 1753 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AFB1-8HE1 | Payroll loyalty bonus 0.5%/day [src=PAY-MU0Q7GP0-9PT1] |
| 35 | 1_withdrawable_key | 70bedd3a-8898-4918-9e7b-a0d1d94e4a06 | 2026-10-25 03:00:30 | BAYO MERCY | +256777313372 | 9202 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AF57-QO1O | Payroll loyalty bonus 0.5%/day [src=PAY-MTA3IH0W-S0F7] |
| 36 | 1_withdrawable_key | db14fb32-d8c8-416b-87ae-40e058c00bfb | 2026-10-25 03:00:29 | BAYO MERCY | +256777313372 | 391 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AEYI-4RB6 | Payroll loyalty bonus 0.5%/day [src=PAY-MUO3PVA9-E12C] |
| 37 | 1_withdrawable_key | 0c7222de-d0b1-4266-87c6-c8ad4a3e5246 | 2026-10-25 03:00:29 | MERCY BAYO | +256706052465 | 4332 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AEQE-I3Z4 | Payroll loyalty bonus 0.5%/day [src=PAY-MUWSRAFE-SL1L] |
| 38 | 1_withdrawable_key | b2ef9548-f803-43c9-b30b-d6f9914d53f7 | 2026-10-25 03:00:29 | GRACE PAUL OCHIENG | +254733803035 | 5524 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AEII-IJM3 | Payroll loyalty bonus 0.5%/day [src=PAY-MUR0HT45-A9FH] |
| 39 | 1_withdrawable_key | 0ff350af-fd66-4b03-8c71-dc5662f9dbf7 | 2026-10-25 03:00:28 | MERCY BAYO | +256706052465 | 39813 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AEAH-O1XG | Payroll loyalty bonus 0.5%/day [src=PAY-MV23IBLO-FZXR] |
| 40 | 1_withdrawable_key | 62a757a2-1396-40d9-ac01-6b7d6d03856b | 2026-10-25 03:00:28 | GRACE PAUL OCHIENG | +254733803035 | 677 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AE2W-YNUP | Payroll loyalty bonus 0.5%/day [src=PAY-MUWIZBAQ-ATE7] |
| 41 | 1_withdrawable_key | 2f5f8597-a8cc-49b5-8e97-0ecd9e8b1cc5 | 2026-10-25 03:00:28 | BAYO MERCY | +256777313372 | 517673 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ADX2-DGZ8 | Payroll loyalty bonus 0.5%/day [src=PAY-MSWWG81B-SNJY] |
| 42 | 1_withdrawable_key | 1941fa01-d629-4267-9f47-838b967bb9f9 | 2026-10-25 03:00:28 | AINEMBABAZI KEViN | +256776850799 | 3814 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ADRM-V97Q | Payroll loyalty bonus 0.5%/day [src=PAY-MQQMRA4M-AT5B] |
| 43 | 1_withdrawable_key | 575d77db-77cb-44d8-b7ba-14a64890787d | 2026-10-25 03:00:27 | MERCY BAYO | +256706052465 | 5724 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ADL1-5WVJ | Payroll loyalty bonus 0.5%/day [src=PAY-MV7WACTK-09HJ] |
| 44 | 1_withdrawable_key | 715b2c9b-276a-440c-a2f4-0e063a89ff1e | 2026-10-25 03:00:27 | MERCY BAYO | +256706052465 | 23478 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ADDH-OW1E | Payroll loyalty bonus 0.5%/day [src=PAY-MUWBGI4O-C3ZX] |
| 45 | 1_withdrawable_key | 8af9719d-5d57-4cbd-a1db-5365c50a7950 | 2026-10-25 03:00:27 | JOSHUA WANDA | +256704825473 | 1523 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AD6Z-BVA7 | Payroll loyalty bonus 0.5%/day [src=PAY-MVGPFG3N-0V3B] |
| 46 | 1_withdrawable_key | 259cc6b9-0c04-48a5-8585-41be5e8b0fa3 | 2026-10-25 03:00:27 | JOSHUA WANDA | +256704825473 | 433 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AD0P-2RUS | Payroll loyalty bonus 0.5%/day [src=PAY-MVGPF75W-RBJ5] |
| 47 | 1_withdrawable_key | a6440465-5885-4f15-8ced-d28a8f66fe68 | 2026-10-25 03:00:27 | BAYO MERCY | +256777313372 | 614 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ACSI-WLRS | Payroll loyalty bonus 0.5%/day [src=PAY-MUO3SOUG-K6QM] |
| 48 | 1_withdrawable_key | f24a5cd1-ff68-4f33-8e2a-f98ea91a5c0a | 2026-10-25 03:00:26 | ATUHAIRE CAROLYNE | +256761135206 | 3431 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ACM7-BXFZ | Payroll loyalty bonus 0.5%/day [src=PAY-MPV77Y5B-SSMU] |
| 49 | 1_withdrawable_key | 40456148-be0a-4ce0-9675-6f076f5de35b | 2026-10-25 03:00:26 | GRACE PAUL OCHIENG | +254733803035 | 25326 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ACBY-8GVM | Payroll loyalty bonus 0.5%/day [src=PAY-MUY7COJU-Q0HB] |
| 50 | 1_withdrawable_key | 970c55e4-a2c9-4c7c-90ee-9a8ee48f1335 | 2026-10-25 03:00:26 | NAIGAGA PAVIN | +256745718902 | 168 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AC4Y-W4P0 | Payroll loyalty bonus 0.5%/day [src=PAY-MUZGQYJ9-BFD9] |
| 51 | 1_withdrawable_key | c447b659-de8c-4db1-b7cd-284bfdb888ab | 2026-10-25 03:00:25 | GRACE PAUL OCHIENG | +254733803035 | 1200 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ABTS-S6GX | Payroll loyalty bonus 0.5%/day [src=PAY-MVKZXWDB-1NKZ] |
| 52 | 1_withdrawable_key | a6031c5d-5435-4056-bab2-a50a55538283 | 2026-10-25 03:00:25 | GRACE PAUL OCHIENG | +254733803035 | 1361 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ABK2-5PWI | Payroll loyalty bonus 0.5%/day [src=PAY-MUUY9ZRB-6PZC] |
| 53 | 1_withdrawable_key | b4bd57b2-99bb-49f5-ab6d-10f0a8a67b2e | 2026-10-25 03:00:25 | Magosha Allan | +256760011248 | 1 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2ABD8-5XWG | Payroll loyalty bonus 0.5%/day [src=PAY-MQ93TMY5-1HMS] |
| 54 | 1_withdrawable_key | 0c25ba4f-32c6-4d35-8ccf-660b66f16366 | 2026-10-25 03:00:24 | JANEHEPHZIBAR GIMONO | +256774958094 | 125 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AB6G-0XHV | Payroll loyalty bonus 0.5%/day [src=PAY-MVKZXQ75-EJ7H] |
| 55 | 1_withdrawable_key | 0a7b1768-dd24-4334-beb9-fd70db6a0b72 | 2026-10-25 03:00:24 | Hanishah Amber Kawuki | +256750261030 | 366 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AB02-BXE3 | Payroll loyalty bonus 0.5%/day [src=PAY-MV6PLSPN-PTUW] |
| 56 | 1_withdrawable_key | 09d07b23-9952-470c-9bf7-1f303951cfe1 | 2026-10-25 03:00:24 | WINFRED ASIIMWE | +256786963421 | 150 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AASI-XCUH | Payroll loyalty bonus 0.5%/day [src=PAY-MVKZXJVU-9XM8] |
| 57 | 1_withdrawable_key | a88d7a3a-03f5-47df-afc6-7245afec1004 | 2026-10-25 03:00:24 | Martin Bot | +256708257899 | 78 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AAKR-5JXU | Payroll loyalty bonus 0.5%/day [src=PAY-MPCGUN0P-QHYE] |
| 58 | 1_withdrawable_key | 889a2e4a-6519-422a-941d-9e44aec20a32 | 2026-10-25 03:00:23 | MERCY BAYO | +256706052465 | 233 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AABL-7S9F | Payroll loyalty bonus 0.5%/day [src=PAY-MVAP506I-74KP] |
| 59 | 1_withdrawable_key | 1321766e-e9b9-4c9d-a2e8-92e78b01ead1 | 2026-10-25 03:00:23 | Nabukenya Hellen | +256740834746 | 26784 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2AA38-NYOB | Payroll loyalty bonus 0.5%/day [src=PAY-MPWI87EY-SGCD] |
| 60 | 1_withdrawable_key | 70a824fa-c991-47fa-b5a0-774e23cfb112 | 2026-10-25 03:00:23 | BAYO MERCY | +256777313372 | 1187 | cash_in | withdrawable | system_balance_correction | payroll_growth_balances | PGB-MVN2A9W2-6OOS | Payroll loyalty bonus 0.5%/day [src=PAY-MTKBUQ5V-C6TM] |
| 61 | 2_withdrawable_comm_repay_latest | 818f211e-a7b9-492a-b03b-a670d024bca6 | 2026-10-25 10:42:35 | Kyeyune agibu | +256740175134 | 400.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | fcb6e297-a7b9-4f88-8e0e-8c4fdb2d4ed9 | 8% commission on rent collection allocation |
| 62 | 2_withdrawable_comm_repay_latest | f8a817e4-c450-4776-b500-b117843c12b7 | 2026-10-25 10:42:35 | kirunda Ivan | +256756404789 | 100.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | fcb6e297-a7b9-4f88-8e0e-8c4fdb2d4ed9 | 2% recruiter override on sub-agent rent collection allocation |
| 63 | 2_withdrawable_comm_repay_latest | 70bf661b-3deb-4961-a789-8b47fe211a5f | 2026-10-25 10:42:35 | kirunda Ivan | +256756404789 | 100.00 | cash_out | withdrawable | agent_repayment | agent_advances | af6618c7-4a75-48eb-af8f-4f8ebc7b073c | Missed advance repayment auto-recovered from new earning |
| 64 | 2_withdrawable_comm_repay_latest | 8cd43800-dfea-43b6-8d93-0e4240ed9716 | 2026-10-25 10:37:59 | ALPHA SSEMA | +256752760263 | 1920.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | ffe877fb-4b02-4d12-ac5c-3322cd1d6a5d | 8% commission on rent collection allocation |
| 65 | 2_withdrawable_comm_repay_latest | 24507bf6-e7f4-4b69-bae5-91d3d190134f | 2026-10-25 10:37:59 | IAN MUHWEZI | +256787725122 | 480.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | ffe877fb-4b02-4d12-ac5c-3322cd1d6a5d | 2% recruiter override on sub-agent rent collection allocation |
| 66 | 2_withdrawable_comm_repay_latest | 595234cb-f518-4631-b57f-6432e0bca3b4 | 2026-10-25 10:37:59 | IAN MUHWEZI | +256787725122 | 480.00 | cash_out | withdrawable | agent_repayment | agent_advances | ba37593d-8b29-482b-b305-f98210864616 | Missed advance repayment auto-recovered from new earning |
| 67 | 2_withdrawable_comm_repay_latest | 3a358671-dd0d-49c4-aecf-3e4a922d62a4 | 2026-10-25 10:34:33 | ALPHA SSEMA | +256752760263 | 3920.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | ffe877fb-4b02-4d12-ac5c-3322cd1d6a5d | 8% commission on rent collection allocation |
| 68 | 2_withdrawable_comm_repay_latest | e999b117-bbbf-4f43-8017-c5afae1ad592 | 2026-10-25 10:34:33 | IAN MUHWEZI | +256787725122 | 980.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | ffe877fb-4b02-4d12-ac5c-3322cd1d6a5d | 2% recruiter override on sub-agent rent collection allocation |
| 69 | 2_withdrawable_comm_repay_latest | 595ee65a-44dd-4578-a10b-539262ca67c7 | 2026-10-25 10:34:33 | IAN MUHWEZI | +256787725122 | 980.00 | cash_out | withdrawable | agent_repayment | agent_advances | ba37593d-8b29-482b-b305-f98210864616 | Missed advance repayment auto-recovered from new earning |
| 70 | 2_withdrawable_comm_repay_latest | 4a302f55-f2bf-4004-a971-82bd782fb8ce | 2026-10-25 10:34:06 | ALPHA SSEMA | +256752760263 | 4000.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | 654e6ca4-5a88-4bdd-a06c-c8e7328ffb30 | 8% commission on rent collection allocation |
| 71 | 2_withdrawable_comm_repay_latest | 8dc3194a-3911-43d1-a092-ae358686856c | 2026-10-25 10:34:06 | IAN MUHWEZI | +256787725122 | 1000.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | 654e6ca4-5a88-4bdd-a06c-c8e7328ffb30 | 2% recruiter override on sub-agent rent collection allocation |
| 72 | 2_withdrawable_comm_repay_latest | a641e202-b1fe-4419-8cac-eb74cd84ac51 | 2026-10-25 10:34:06 | IAN MUHWEZI | +256787725122 | 1000.00 | cash_out | withdrawable | agent_repayment | agent_advances | ba37593d-8b29-482b-b305-f98210864616 | Missed advance repayment auto-recovered from new earning |
| 73 | 2_withdrawable_comm_repay_latest | ec63cab1-88a5-4b30-80ef-fe9cf3b1f260 | 2026-10-25 10:33:31 | ALPHA SSEMA | +256752760263 | 6400.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | a23ef200-35fd-42fa-9064-4c6b10084ad9 | 8% commission on rent collection allocation |
| 74 | 2_withdrawable_comm_repay_latest | e0eaf4d9-a96d-49bf-944f-a9c0ecdee64a | 2026-10-25 10:33:31 | IAN MUHWEZI | +256787725122 | 1600.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | a23ef200-35fd-42fa-9064-4c6b10084ad9 | 2% recruiter override on sub-agent rent collection allocation |
| 75 | 2_withdrawable_comm_repay_latest | e5c749cd-2676-4d35-aafb-a0ea66510045 | 2026-10-25 10:33:31 | IAN MUHWEZI | +256787725122 | 1600.00 | cash_out | withdrawable | agent_repayment | agent_advances | ba37593d-8b29-482b-b305-f98210864616 | Missed advance repayment auto-recovered from new earning |
| 76 | 2_withdrawable_comm_repay_latest | 90c55b7d-3f4e-4e5e-99bb-d853859108a7 | 2026-10-25 10:33:07 | ALPHA SSEMA | +256752760263 | 80.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | 1c0b3191-1676-4701-9f09-199a84f5ff07 | 8% commission on rent collection allocation |
| 77 | 2_withdrawable_comm_repay_latest | da08b9b1-f493-4f41-bdd3-15c44ec63798 | 2026-10-25 10:33:07 | IAN MUHWEZI | +256787725122 | 20.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | 1c0b3191-1676-4701-9f09-199a84f5ff07 | 2% recruiter override on sub-agent rent collection allocation |
| 78 | 2_withdrawable_comm_repay_latest | 8b504e72-cd31-4f75-97bc-d13271ff9586 | 2026-10-25 10:33:07 | IAN MUHWEZI | +256787725122 | 20.00 | cash_out | withdrawable | agent_repayment | agent_advances | ba37593d-8b29-482b-b305-f98210864616 | Missed advance repayment auto-recovered from new earning |
| 79 | 2_withdrawable_comm_repay_latest | 311fb438-dfbc-49d3-a087-b0c3b8a725a2 | 2026-10-25 10:32:17 | ALPHA SSEMA | +256752760263 | 1600.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | 63341291-2512-46f8-8cf8-521d2f73f2b9 | 8% commission on rent collection allocation |
| 80 | 2_withdrawable_comm_repay_latest | 624638da-dbc1-40b5-a9a6-77ade3d04d27 | 2026-10-25 10:32:17 | IAN MUHWEZI | +256787725122 | 400.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | 63341291-2512-46f8-8cf8-521d2f73f2b9 | 2% recruiter override on sub-agent rent collection allocation |
| 81 | 2_withdrawable_comm_repay_latest | 7cc02c66-ed65-4cb9-82ec-9e23fc753ed4 | 2026-10-25 10:32:17 | IAN MUHWEZI | +256787725122 | 400.00 | cash_out | withdrawable | agent_repayment | agent_advances | ba37593d-8b29-482b-b305-f98210864616 | Missed advance repayment auto-recovered from new earning |
| 82 | 2_withdrawable_comm_repay_latest | f0acfd88-a2c5-4412-b53a-dfd67dba5677 | 2026-10-25 10:31:41 | ALPHA SSEMA | +256752760263 | 8000.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | 9084845c-6cb0-434c-9234-eb653fcdecf3 | 8% commission on rent collection allocation |
| 83 | 2_withdrawable_comm_repay_latest | cafe0520-bc06-4e4b-852b-cb93770cf52d | 2026-10-25 10:31:41 | IAN MUHWEZI | +256787725122 | 2000.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | 9084845c-6cb0-434c-9234-eb653fcdecf3 | 2% recruiter override on sub-agent rent collection allocation |
| 84 | 2_withdrawable_comm_repay_latest | bb71d4f0-c1f2-4051-845f-5f53614821cb | 2026-10-25 10:31:41 | IAN MUHWEZI | +256787725122 | 2000.00 | cash_out | withdrawable | agent_repayment | agent_advances | ba37593d-8b29-482b-b305-f98210864616 | Missed advance repayment auto-recovered from new earning |
| 85 | 2_withdrawable_comm_repay_latest | 44ce2bba-a946-4b4c-8683-2ebf472e00e5 | 2026-10-25 10:29:07 | JOSHUA BALIRAINE | +256786793933 | 1400 | cash_in | withdrawable | agent_commission_earned | agent_collections | TSP-6d7d78c9 | Agent 10% on tenant self-payment |
| 86 | 2_withdrawable_comm_repay_latest | 2aeb1f37-4075-4d5e-a1d8-88ef45ae5956 | 2026-10-25 10:16:22 | Mukisa juli | +256707911662 | 450.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | 932acd71-ae4d-46e9-bfcd-3b710d4fd0ca | Full 10% commission on rent collection (whitelisted sub-agent) |
| 87 | 2_withdrawable_comm_repay_latest | 361707c8-2c15-466d-9691-1b7d51c567dc | 2026-10-25 10:15:05 | SHAMIRAH NAKAJJUBI | +256706196246 | 75 | cash_in | withdrawable | agent_commission_earned | withdrawal_requests | 0318942b-22cc-4103-814d-952ec83ea7e6-cashout-commission | Cashout payout commission (0.5%) for withdrawal 0318942b-22cc-4103-814d-952ec83ea7e6 |
| 88 | 2_withdrawable_comm_repay_latest | 8697d71a-67db-4235-a035-b8d2c08bb086 | 2026-10-25 09:36:51 | Veron Owaruhanga | +256730107255 | 1280.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | fdddfe5f-9cd8-4112-bf21-62903ab3b7a6 | 8% commission on rent collection allocation |
| 89 | 2_withdrawable_comm_repay_latest | 58379be1-5a12-4cba-8949-2a4a8d0b0255 | 2026-10-25 09:36:51 | NSUBUGA Lawrence George | +256705133346 | 320.00 | cash_in | withdrawable | agent_commission_earned | agent_collections | fdddfe5f-9cd8-4112-bf21-62903ab3b7a6 | 2% recruiter override on sub-agent rent collection allocation |
| 90 | 2_withdrawable_comm_repay_latest | c27152e1-d127-4b55-99b3-c8001f5d80a9 | 2026-10-25 09:27:08 | NSUBUGA Lawrence George | +256705133346 | 300 | cash_in | withdrawable | agent_commission_earned | agent_collections | TSP-f4499676 | Agent 10% on tenant self-payment |
| 91 | 3_float_latest | 4687f807-88f9-483f-b494-e7ab0b64c01c | 2026-10-25 10:42:35 | Kyeyune agibu | +256740175134 | 5000 | cash_out | float | agent_float_used_for_rent | agent_collections | fcb6e297-a7b9-4f88-8e0e-8c4fdb2d4ed9 | Tenant rent collection from agent wallet float |
| 92 | 3_float_latest | d864105c-61a9-4838-ba3e-01522bf2f1cf | 2026-10-25 10:37:59 | ALPHA SSEMA | +256752760263 | 24000 | cash_out | float | agent_float_used_for_rent | agent_collections | ffe877fb-4b02-4d12-ac5c-3322cd1d6a5d | Tenant rent collection from agent wallet float |
| 93 | 3_float_latest | 4a2a0946-7368-4973-b90a-4c6b296ab4fc | 2026-10-25 10:37:11 | ALPHA SSEMA | +256752760263 | 24000 | cash_in | float | bucket_reclass_in | agent_withdrawable_to_float | AGT-WDR2FLT-a2bb829a-891f-47fd-9d31-732d63f87cf7 | Float topped up with UGX 24,000 from your own balance (agent self-service). |
| 94 | 3_float_latest | 09146bc8-22cc-415f-83be-02bd474d9263 | 2026-10-25 10:34:33 | ALPHA SSEMA | +256752760263 | 49000 | cash_out | float | agent_float_used_for_rent | agent_collections | ffe877fb-4b02-4d12-ac5c-3322cd1d6a5d | Tenant rent collection from agent wallet float |
| 95 | 3_float_latest | 3abcca5a-e048-43c3-8507-c5e373680221 | 2026-10-25 10:34:09 | Kyeyune agibu | +256740175134 | 5000 | cash_in | float | agent_float_deposit | deposit_requests | TID159735667674 | Operational float deposit via airtel |
| 96 | 3_float_latest | 3dc09983-c5d9-44fa-9ba8-344b18a91485 | 2026-10-25 10:34:06 | ALPHA SSEMA | +256752760263 | 50000 | cash_out | float | agent_float_used_for_rent | agent_collections | 654e6ca4-5a88-4bdd-a06c-c8e7328ffb30 | Tenant rent collection from agent wallet float |
| 97 | 3_float_latest | 82d0d296-b621-4843-8fe2-dedf8e686159 | 2026-10-25 10:33:31 | ALPHA SSEMA | +256752760263 | 80000 | cash_out | float | agent_float_used_for_rent | agent_collections | a23ef200-35fd-42fa-9064-4c6b10084ad9 | Tenant rent collection from agent wallet float |
| 98 | 3_float_latest | c7709aa2-ba73-47be-a2e1-8725adbcff9e | 2026-10-25 10:33:07 | ALPHA SSEMA | +256752760263 | 1000 | cash_out | float | agent_float_used_for_rent | agent_collections | 1c0b3191-1676-4701-9f09-199a84f5ff07 | Tenant rent collection from agent wallet float |
| 99 | 3_float_latest | f3e6b8ab-151e-4827-908f-0541f94c831d | 2026-10-25 10:32:17 | ALPHA SSEMA | +256752760263 | 20000 | cash_out | float | agent_float_used_for_rent | agent_collections | 63341291-2512-46f8-8cf8-521d2f73f2b9 | Tenant rent collection from agent wallet float |
| 100 | 3_float_latest | 67088c2f-892f-45b8-9917-d17714997d15 | 2026-10-25 10:31:41 | ALPHA SSEMA | +256752760263 | 100000 | cash_out | float | agent_float_used_for_rent | agent_collections | 9084845c-6cb0-434c-9234-eb653fcdecf3 | Tenant rent collection from agent wallet float |
| 101 | 3_float_latest | d6808af3-8da1-44ca-b646-5311089cb42e | 2026-10-25 10:30:16 | ALPHA SSEMA | +256752760263 | 300000 | cash_in | float | agent_float_deposit | deposit_requests | TID159735420457 | Operational float deposit via airtel |
| 102 | 3_float_latest | 6e75578f-6540-4f1b-93e8-aba67f823e71 | 2026-10-25 10:29:07 | REHEMA NAKIWARA | +256708248268 | 14000.00 | cash_out | float | agent_float_used_for_rent | agent_collections | TSP-6d7d78c9 | Tenant self-payment settled from own deposited balance |
| 103 | 3_float_latest | 78620531-1fa6-4366-b29e-f693bebeac03 | 2026-10-25 10:29:07 | REHEMA NAKIWARA | +256708248268 | 14000 | cash_in | float | agent_float_deposit | deposit_requests | TID159735353745 | Operational float deposit via airtel |
| 104 | 3_float_latest | 8c0f9776-21ef-4e5c-a205-49d731ff1052 | 2026-10-25 10:25:57 | Wasukila Muzamilu | +256778189898 | 5000 | cash_in | float | bucket_reclass_in | agent_withdrawable_to_float | AGT-WDR2FLT-d86510f4-8416-478a-bef2-f777c88776c3 | Float topped up with UGX 5,000 from your own balance (agent self-service). |
| 105 | 3_float_latest | c3ec3e02-5709-4501-9bc3-adea7825b1c8 | 2026-10-25 10:16:22 | Mukisa juli | +256707911662 | 4500 | cash_out | float | agent_float_used_for_rent | agent_collections | 932acd71-ae4d-46e9-bfcd-3b710d4fd0ca | Tenant rent collection from agent wallet float |
| 106 | 3_float_latest | b4d80cc9-8a8a-404f-894a-927f49e1eac0 | 2026-10-25 10:15:06 | Mukisa juli | +256707911662 | 4500 | cash_in | float | agent_float_deposit | deposit_requests | TID159734342579 | Operational float deposit via airtel |
| 107 | 3_float_latest | 3217a944-16e5-45e8-a358-0a89ec45d39d | 2026-10-25 10:15:04 | SHAMIRAH NAKAJJUBI | +256706196246 | 15000 | cash_out | float | agent_float_settlement | withdrawal_requests | 0318942b-22cc-4103-814d-952ec83ea7e6-merchant-float-consume | Company float used to settle customer cash-out 0318942b-22cc-4103-814d-952ec83ea7e6 (guard) |
| 108 | 3_float_latest | d59e05e6-cfba-4e41-b256-79ae88c92cbc | 2026-10-25 10:15:04 | SHAMIRAH NAKAJJUBI | +256706196246 | 500 | cash_out | float | agent_float_settlement | withdrawal_requests | 0318942b-22cc-4103-814d-952ec83ea7e6-merchant-telecom-charge | Telecom sending charge for merchant cash-out 0318942b-22cc-4103-814d-952ec83ea7e6 (guard) |
| 109 | 3_float_latest | cc15b893-c523-46d4-b2c0-4eb43ac39f72 | 2026-10-25 09:36:51 | Veron Owaruhanga | +256730107255 | 16000 | cash_out | float | agent_float_used_for_rent | agent_collections | fdddfe5f-9cd8-4112-bf21-62903ab3b7a6 | Tenant rent collection from agent wallet float |
| 110 | 3_float_latest | 343d5ccb-17c0-4456-b223-272bac5e5811 | 2026-10-25 09:35:08 | Veron Owaruhanga | +256730107255 | 10000 | cash_in | float | agent_float_deposit | deposit_requests | TID159731585173 | Operational float deposit via airtel |
| 111 | 3_float_latest | ae49fa7e-634d-471d-8c4c-e0fef1278e51 | 2026-10-25 09:27:08 | Justine Kabatesi | +256756061473 | 3000.00 | cash_out | float | agent_float_used_for_rent | agent_collections | TSP-f4499676 | Tenant self-payment settled from own deposited balance |
| 112 | 3_float_latest | 87b96d3a-2319-4db1-bb43-1d4aec5a8e84 | 2026-10-25 09:27:08 | Justine Kabatesi | +256756061473 | 3000 | cash_in | float | agent_float_deposit | deposit_requests | TID159731051704 | Operational float deposit via airtel |
| 113 | 3_float_latest | 7651d205-8d11-4df3-9006-0c64fba6973f | 2026-10-25 09:11:59 | DERRICK LUTAMAGUZI | +256795634656 | 850 | cash_out | float | agent_float_used_for_rent | agent_collections | d221a454-a7b2-4fb2-a114-5f592713c92f | Tenant rent collection from agent wallet float |
| 114 | 3_float_latest | 0b1b069b-11d1-451f-b05c-24aa6ccae630 | 2026-10-25 09:11:25 | DERRICK LUTAMAGUZI | +256795634656 | 1000 | cash_out | float | agent_float_used_for_rent | agent_collections | d7e4fc52-3c57-417b-8b73-24d15ffc311e | Tenant rent collection from agent wallet float |
| 115 | 3_float_latest | ef77f758-61b5-4fba-9700-3a2c70006d27 | 2026-10-25 09:10:11 | DERRICK LUTAMAGUZI | +256795634656 | 1850 | cash_in | float | bucket_reclass_in | agent_withdrawable_to_float | AGT-WDR2FLT-5f745c8f-041a-4324-b7ad-4d7c8da105e6 | Float topped up with UGX 1,850 from your own balance (agent self-service). |
| 116 | 3_float_latest | 404a4072-f7d7-4a9b-9f07-d15b4f642df7 | 2026-10-25 08:49:08 | SHAKIRAH NAKIMBUGWE | +256770603906 | 464 | cash_out | float | agent_float_used_for_rent | agent_collections | c4669e54-3980-4217-b5ac-747d83daee38 | Tenant rent collection from agent wallet float |
| 117 | 3_float_latest | c1a2b103-deb6-49d7-9372-d45c173d9c52 | 2026-10-25 08:47:03 | SHAKIRAH NAKIMBUGWE | +256770603906 | 1300 | cash_out | float | agent_float_used_for_rent | agent_collections | 3ce32352-ca03-4630-8f99-37eb767d12ea | Tenant rent collection from agent wallet float |
| 118 | 3_float_latest | df25d552-3a2e-4763-a41d-fd04443d5826 | 2026-10-25 08:46:25 | SHAKIRAH NAKIMBUGWE | +256770603906 | 1600 | cash_in | float | bucket_reclass_in | agent_withdrawable_to_float | AGT-WDR2FLT-0dfd97c6-e03e-4242-aa17-f8243fac1241 | Float topped up with UGX 1,600 from your own balance (agent self-service). |
| 119 | 3_float_latest | 55240fd1-9aac-49ba-95d2-fb943624fea7 | 2026-10-25 08:45:49 | SHAKIRAH NAKIMBUGWE | +256770603906 | 1000 | cash_out | float | agent_float_used_for_rent | agent_collections | ebea47a5-30a4-40b1-a043-ba6702076708 | Tenant rent collection from agent wallet float |
| 120 | 3_float_latest | 54b47ea9-1204-4b42-8035-34b535dbfebd | 2026-10-25 08:45:22 | SHAKIRAH NAKIMBUGWE | +256770603906 | 1000 | cash_out | float | agent_float_used_for_rent | agent_collections | 39e0f94f-14ad-42a9-ba72-3e1277a835fe | Tenant rent collection from agent wallet float |

## W4. Deposit requests, last 24h (61 rows)

| # | full_name | phone | amount | status | provider | transaction_id | deposit_purpose | created_eat |
|---|---|---|---|---|---|---|---|---|
| 1 | Allen Kisaakye | +256708787807 | 1000000 | rejected | cash_deposit | CASHREQ-e8199935-5a67-453d | personal_deposit | 2026-10-25 10:41:08 |
| 2 | Kyeyune agibu | +256740175134 | 5000 | approved | airtel | TID159735667674 | operational_float | 2026-10-25 10:34:01 |
| 3 | ALPHA SSEMA | +256752760263 | 300000 | approved | airtel | TID159735420457 | operational_float | 2026-10-25 10:30:06 |
| 4 | REHEMA NAKIWARA | +256708248268 | 14000 | approved | airtel | TID159735353745 | operational_float | 2026-10-25 10:29:01 |
| 5 | Mukisa juli | +256707911662 | 4500 | approved | airtel | TID159734342579 | operational_float | 2026-10-25 10:15:05 |
| 6 | Veron Owaruhanga | +256730107255 | 10000 | approved | airtel | TID159731585173 | operational_float | 2026-10-25 09:35:03 |
| 7 | Justine Kabatesi | +256756061473 | 3000 | approved | airtel | TID159731051704 | operational_float | 2026-10-25 09:27:01 |
| 8 | Mwaka Isaac | +256753949399 | 8000 | approved | airtel | TID159726055503 | operational_float | 2026-10-25 07:56:00 |
| 9 | BUULU KATENDE | +256708381973 | 13000 | approved | airtel | TID159725955041 | operational_float | 2026-10-25 07:54:02 |
| 10 | Ernest Baluku | +256756415696 | 15000 | approved | airtel | TID159723327099 | operational_float | 2026-10-25 05:28:02 |
| 11 | Lukman Muwaya | +256765210766 | 6000 | approved | mtn | 44516549034 | operational_float | 2026-10-25 03:06:01 |
| 12 | Sempungu Martin | +256706166143 | 7000 | approved | airtel | TID159722016249 | operational_float | 2026-10-25 01:35:02 |
| 13 | FRED MUWANGUZI | +256708778540 | 20000 | approved | airtel | TID159718849759 | operational_float | 2026-10-24 23:07:01 |
| 14 | NATTU SHARIFAH | +256781515171 | 100000 | approved | mtn | 44513299792 | operational_float | 2026-10-24 22:52:00 |
| 15 | kirunda Ivan | +256756404789 | 94000 | approved | airtel | TID159717480893 | operational_float | 2026-10-24 22:39:00 |
| 16 | Ibrahim Nsubuga | +256700248550 | 5000 | approved | airtel | TID159717076469 | operational_float | 2026-10-24 22:31:01 |
| 17 | Bulitya Fredrick | +256786666671 | 15000 | approved | mtn | 44511847078 | operational_float | 2026-10-24 22:20:06 |
| 18 | NAGASHA Mellon | +256792790529 | 2000 | approved | mtn | 44511780338 | operational_float | 2026-10-24 22:19:01 |
| 19 | NAGASHA Mellon | +256792790529 | 5000 | approved | mtn | 44511675987 | operational_float | 2026-10-24 22:18:02 |
| 20 | Margaret Walulya | +256752648853 | 10000 | approved | airtel | TID159716214178 | operational_float | 2026-10-24 22:17:02 |
| 21 | SULAIMAN MAYANJA | +256731955402 | 7000 | approved | airtel | TID159716006667 | operational_float | 2026-10-24 22:15:03 |
| 22 | NAGASHA Mellon | +256792790529 | 99500 | approved | mtn | 44511131839 | operational_float | 2026-10-24 22:09:01 |
| 23 | Kawuki Ibrahim | +256708705350 | 5000 | approved | airtel | TID159715320797 | operational_float | 2026-10-24 22:05:02 |
| 24 | SULAIMAN MAYANJA | +256731955402 | 29000 | approved | airtel | TID159715170518 | operational_float | 2026-10-24 22:03:06 |
| 25 | Kyeyune agibu | +256740175134 | 38200 | approved | airtel | TID159715191244 | operational_float | 2026-10-24 22:03:04 |
| 26 | Nsubuga Benon | +256786886402 | 10000 | approved | mtn | 44511014213 | operational_float | 2026-10-24 22:03:01 |
| 27 | Atuhairwe Nicholas | +256701548013 | 40000 | approved | airtel | TID159713970701 | operational_float | 2026-10-24 21:47:01 |
| 28 | kirunda Ivan | +256756404789 | 22800 | approved | airtel | TID159713791700 | operational_float | 2026-10-24 21:45:03 |
| 29 | JOEL KAYONGO | +256705055041 | 10000 | approved | airtel | TID159713599626 | operational_float | 2026-10-24 21:43:02 |
| 30 | KAGEZI KATO ALI | +256730985007 | 6000 | approved | airtel | TID159712978812 | operational_float | 2026-10-24 21:36:02 |
| 31 | Magawa Joan | +256742508052 | 12000 | approved | airtel | TID159712756517 | operational_float | 2026-10-24 21:34:03 |
| 32 | Betty Kalembe | +256705898178 | 8000 | approved | airtel | TID159711697199 | operational_float | 2026-10-24 21:22:02 |
| 33 | PETER BUKOMA | +256791844340 | 58000 | approved | mtn | 44508439750 | operational_float | 2026-10-24 21:19:01 |
| 34 | SHAKIRAH NAKIMBUGWE | +256770603906 | 100000 | approved | mtn | 44507498011 | operational_float | 2026-10-24 21:03:01 |
| 35 | NSUBUGA Lawrence George | +256705133346 | 14000 | approved | airtel | TID159709423055 | operational_float | 2026-10-24 20:58:01 |
| 36 | Kelvin Peter | +256732432870 | 4000 | approved | airtel | TID159706843436 | operational_float | 2026-10-24 20:34:01 |
| 37 | WALYAMBOGA ISAAC | +256770798094 | 11000 | approved | mtn | 44504858258 | operational_float | 2026-10-24 20:12:01 |
| 38 | Watwali Tom | +256709994308 | 5400 | approved | airtel | TID159702670869 | operational_float | 2026-10-24 19:59:00 |
| 39 | Esther Akia | +256777344174 | 4800 | approved | mtn | 44503969142 | operational_float | 2026-10-24 19:52:00 |
| 40 | Evans Bumali Mayanja | +256706547518 | 50000 | approved | airtel | TID159696232479 | operational_float | 2026-10-24 19:09:01 |
| 41 | FRED MUWANGUZI | +256708778540 | 40000 | approved | airtel | TID159694793846 | operational_float | 2026-10-24 18:57:01 |
| 42 | Wafula Ronald ojiambo | +256730128819 | 6000 | approved | airtel | TID159694524679 | operational_float | 2026-10-24 18:55:03 |
| 43 | Ibrahim Lubega | +256731532315 | 30000 | approved | airtel | TID159694062248 | operational_float | 2026-10-24 18:50:06 |
| 44 | Nagadya Esther | +256765158284 | 14000 | approved | mtn | 44500308038 | operational_float | 2026-10-24 18:48:00 |
| 45 | DERRICK LUTAMAGUZI | +256795634656 | 14000 | approved | mtn | 44500131612 | operational_float | 2026-10-24 18:41:01 |
| 46 | DANIEL OLUKA | +256705670428 | 20000 | approved | airtel | TID159691403555 | operational_float | 2026-10-24 18:23:01 |
| 47 | Veron Owaruhanga | +256730107255 | 32000 | approved | airtel | TID159690828157 | operational_float | 2026-10-24 18:16:02 |
| 48 | Robert Mugisha | +256794402225 | 15000 | approved | mtn | 44499266489 | operational_float | 2026-10-24 18:13:02 |
| 49 | Gustine Wansolo | +256749773832 | 30000 | approved | airtel | TID159690020734 | operational_float | 2026-10-24 18:07:01 |
| 50 | Yaseen Kc💎 | +256747232577 | 720000 | approved | airtel | TID159689673818 | operational_float | 2026-10-24 18:04:02 |
| 51 | Kakooza Charles | +256709630226 | 200000 | approved | airtel | TID159682988349 | operational_float | 2026-10-24 16:45:04 |
| 52 | Mukisa juli | +256707911662 | 38000 | approved | airtel | TID159679038786 | operational_float | 2026-10-24 15:56:01 |
| 53 | semyalo benon | +256745949077 | 5000 | approved | airtel | TID159676065640 | operational_float | 2026-10-24 15:19:01 |
| 54 | JOEL KAYONGO | +256705055041 | 10000 | approved | airtel | TID159673319167 | operational_float | 2026-10-24 14:46:02 |
| 55 | DEOGRATIUS SEMWEZI | +256784394567 | 20000 | approved | mtn | 44493568343 | operational_float | 2026-10-24 14:35:03 |
| 56 | Betty Kakai | +256785738256 | 31000 | approved | mtn | 44493204750 | operational_float | 2026-10-24 14:23:02 |
| 57 | Yaseen Kc💎 | +256747232577 | 300000 | approved | airtel | TID159660338496 | operational_float | 2026-10-24 12:13:01 |
| 58 | SHAFEEQ SSENABULYA | +256748762871 | 245000 | approved | airtel | TID159660297981 | operational_float | 2026-10-24 12:12:01 |
| 59 | Bernadette Amony | +256703704909 | 300000 | approved | airtel | TID159659822826 | other | 2026-10-24 12:06:02 |
| 60 | Mata Pius | +256776368807 | 5000 | approved | mtn | 44488674717 | operational_float | 2026-10-24 11:26:02 |
| 61 | CHARLES MUGISHA | +256752967879 | 10000 | approved | airtel | TID159654464780 | operational_float | 2026-10-24 11:01:01 |

