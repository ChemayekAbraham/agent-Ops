# Landlord Calling Hub — Data Quality & Look-Alike Review (October 2026)

Generated: **27 October 2026** (read-only snapshot of live `public.landlords` and `public.rent_requests`)

> **Privacy & Safety Rule**: This report contains **names, UUIDs, verification statuses, and Rent Plan / tenant counts only**. Phone numbers and Mobile Money numbers are intentionally omitted. None of the records listed below were modified, hidden, or deleted by migration `20261028190000_landlord_calling_hub_real_landlords.sql`; instead, they are flagged in `mv_landlord_hub_registry.check_flags` (`needs_check = true`), excluded from the default `to_call` queue, and surfaced under the `check_first` scope for Landlord Ops and Fraud review.

---

## 1. Registry Scope Summary (Before vs After Migration `20261028190000`)

| Metric | Before (`v_landlord_registry_all` copy) | After (`mv_landlord_hub_registry` real landlords) | Notes |
|---|---:|---:|---|
| Total rows in hub registry | 106,478 | **47,106** | Excluded **59,372** role-only accounts (`landlord_id IS NULL AND user_id IS NOT NULL`, of which 59,248 also hold the `tenant` role) |
| Rows with a `public.landlords` record | 47,106 | **47,106** | 100% preserved |
| Orphan payout-phone rows (`landlord_id IS NULL AND user_id IS NULL`) | 0 | **0** | Rule retained for any future payout-only phone |
| Live Rent Plan landlords (`plan_stage = 'live'`) | 806 | **806** | 100% of live-plan landlords preserved |
| In-progress Rent Plan landlords (`plan_stage = 'in_progress'`) | — | **15** | Landlords with plans in pipeline stages (or `service_center_review` with `<= 50` total plans) |
| Finished Rent Plan landlords (`plan_stage = 'finished'`) | — | **218** | Landlords with completed/ended plans only (or `service_center_review` with `> 50` plans) |
| Registered-only landlords (`plan_stage = 'registered_only'`) | — | **46,067** | Landlords registered in `public.landlords` with `0` Rent Plans |
| Verified status (`verification_status = 'verified'`) | 50,025 | **5,681** | Now taken strictly from `public.landlords` rather than profile phone verification |
| Pending status (`verification_status = 'pending'`) | 56,120 | **41,094** | Taken from `public.landlords` |
| Rejected status (`verification_status = 'rejected'`) | 331 | **331** | Excluded from `to_call` |

### Note on Existing Recorded Call (`public.landlord_calls`)

- Call ID `c35e04f3-ba95-4f8f-95a1-6d01ec2fc900` (recorded `2026-10-27 17:39:43 UTC` by caller `b9078b67-dc4c-473a-bc88-9510d4bcd0dc`, result `call_back` scheduled for `2026-10-30 06:00:00 UTC`) is on landlord **`Friday Rogers`** (`ca207807-3996-4a1b-98a8-fc21191156c7`).
- Per instructions, this call row has **not** been modified or voided.

---

## 2. `plan_overload` — Landlords with More Than 50 Rent Plans (`3` landlords)

These landlords have `plans_total > 50`. They are flagged `plan_overload`, excluded from `to_call` (unless viewing `check_first`), demoted from the top of `rent_plan_value` sorts across all tabs, and have their `tenants_and_plans` array capped at the 50 newest plans in `landlord_hub_detail` (with `plans_total` and `tenants_total` returned so the UI displays `"Showing 50 of N"`).

| # | Landlord ID | Landlord Name | Verification Status | Live Plans | Total Plans | Distinct Tenants |
|---:|---|---|---|---:|---:|---:|
| 1 | `ca207807-3996-4a1b-98a8-fc21191156c7` | Friday Rogers | `verified` | 0 | 3127 | 3010 |
| 2 | `de8bc78c-5b88-4448-8c96-46f3c251ac9c` | Abamerina Erina | `verified` | 4 | 139 | 132 |
| 3 | `9bbef876-9f63-4d83-a7a9-c1f93bf386c3` | 17 apartment | `verified` | 0 | 107 | 107 |

- **Friday Rogers (`ca207807-3996-4a1b-98a8-fc21191156c7`)**: 3,012 plans in `service_center_review` and 115 in `rejected` (3,127 total plans across 3,010 distinct tenants, 0 live plans).
- **Abamerina Erina (`de8bc78c-5b88-4448-8c96-46f3c251ac9c`)**: 4 live plans (`repaying`) and 135 non-live plans (139 total plans across 132 distinct tenants).
- **17 apartment (`9bbef876-9f63-4d83-a7a9-c1f93bf386c3`)**: 107 plans in `service_center_review` across 107 distinct tenants (0 live plans).

---

## 3. `rejected_with_live_plan` — Rejected Landlords with Live Rent Plans (`4` landlords)

These landlords have `verification_status = 'rejected'` in `public.landlords` while holding at least one live Rent Plan (`funded`, `repaying`, `active`, or `disbursed`). They are excluded from `to_call` and surfaced in `check_first`.

| # | Landlord ID | Landlord Name | Verification Status | Live Plans | Total Plans | Distinct Tenants |
|---:|---|---|---|---:|---:|---:|
| 1 | `7c44d3b9-c861-4d78-a7eb-f57a79650ac3` | abber innocent | `rejected` | 1 | 5 | 4 |
| 2 | `fae12005-d45f-4725-bfec-47ff20280d62` | Bisaso semyalo Peter | `rejected` | 1 | 1 | 1 |
| 3 | `50143b55-4faa-4d92-b731-651cfa5ed61d` | Kilya john | `rejected` | 1 | 1 | 1 |
| 4 | `7e3d96a2-7e1a-4930-8972-21e611f800fe` | Lukiya Banluma | `rejected` | 1 | 1 | 1 |

---

## 4. `is_own_tenant` — Landlord Phone or Account Matches a Tenant on Their Own Rent Plan (`19` landlords)

These landlords have a normalized phone / Mobile Money number matching the tenant's normalized phone / Mobile Money number on at least one of their Rent Plans (or share the same `user_id`). They are flagged `is_own_tenant`, excluded from `to_call`, and surfaced in `check_first`.

| # | Landlord ID | Landlord Name | Verification Status | Live Plans | Total Plans | Distinct Tenants | Matched Tenant ID | Matched Tenant Name |
|---:|---|---|---|---:|---:|---:|---|---|
| 1 | `88be517a-c508-4462-8d9a-001f6384d5bc` | kayemba sharif | `verified` | 17 | 28 | 21 | `021fe755-7b20-489d-bba1-d7c727a2d4be` | Namaganda Sawuya |
| 2 | `8510a06d-676b-48a2-93b7-935411609c72` | ivan batte | `verified` | 2 | 9 | 2 | `7ca2620a-8cf8-4d54-97fe-56b9ff57c2a0` | mbabazi oliver |
| 3 | `77a6927d-fcad-42d7-88b4-3b039bb6296c` | Ahmed Nasser | `verified` | 1 | 2 | 2 | `7ed949ec-9749-4ec9-a79d-676fb74a8b52` | Namulindwa Jauharah |
| 4 | `a69c39cd-1c4f-4734-9fdc-4e0fa14e3f2e` | Mwesigwa Hangi | `verified` | 1 | 1 | 1 | `aac7c27b-986e-4ba6-bc52-55577149cce0` | Matovu Asuman |
| 5 | `53f55835-42dc-4ba8-84bd-cccd568dc993` | Nakumwa Esther | `verified` | 1 | 1 | 1 | `ed17006d-fc7e-4c17-becd-9ae6b429d92a` | Kiplimo Geofry |
| 6 | `36f1dd65-35a6-4602-b172-86fda8fec089` | Tumusime moses | `verified` | 1 | 2 | 2 | `6e25b9be-ce91-4859-bc1c-c31e5bdeb8cb` | Nalumu Lillian |
| 7 | `ea3ac1bb-b01c-4cf4-b184-1d282b32237b` | allan | `pending` | 0 | 1 | 1 | `7b9c1667-dd5b-43cd-b268-c405336892cc` | Cedrick Mukisa |
| 8 | `545f6657-78af-4adc-90f4-83a4d1d7ac66` | Alowo Teddy | `verified` | 0 | 3 | 2 | `1d04c237-a1f8-4223-8521-4b8065d191b3` | Odong jeremiah |
| 9 | `eb7e3a59-9921-49b4-aba3-469bfa090d1b` | Babirya Tracy | `pending` | 0 | 1 | 1 | `7cf6a2fe-3eb4-4c4b-9ad2-0de90721fa3e` | Mukisa Enock |
| 10 | `fa25c823-d28b-4437-b701-7e4de7b78f7a` | Beatrice Shakul | `verified` | 0 | 1 | 1 | `8a16a4c2-9b19-4eba-ba0a-fb14611ba110` | Kasasa Devis |
| 11 | `3f2c96dc-927a-4c81-b763-e7c247a237bd` | Benjamin Muhanguzi | `verified` | 0 | 1 | 1 | `cf561688-b3a2-4f62-b9c1-67ee7b36ff2b` | Benjamin Muhanguzi |
| 12 | `b3f72480-357e-4cd3-a07c-0e2677c30168` | francis | `pending` | 0 | 1 | 1 | `b4098c66-4bdb-4ed2-91c1-87c85818a889` | hillary |
| 13 | `ac973ebe-02c2-4730-971f-ba6c929dd50f` | fred okia | `pending` | 0 | 1 | 1 | `d472aa66-c59f-4fe1-9448-b95ed2d19541` | Brabrah Akia |
| 14 | `58a109c5-3f84-4d33-aa2d-e9e7322556a3` | maweje faisal | `verified` | 0 | 3 | 1 | `45044d25-c53d-40c7-bfd6-f2b32cd85b35` | Adama Benson |
| 15 | `12fd78b0-b6e1-40e2-8018-8a617d1625ea` | Muwonge Johnbosco | `verified` | 0 | 1 | 1 | `09e1f657-8ce8-4e83-8832-e042debbd08e` | Nakazzi Sarah |
| 16 | `02777ee8-2f44-408c-bea3-a880acbcbd27` | Nakijoba Milly | `verified` | 0 | 1 | 1 | `110848e6-9f7e-46db-b238-3ad3df67a63b` | Mutyaba phillip Kato |
| 17 | `39d1babf-24a5-4525-a8bc-ef2ef746c6b3` | Nakisuyi eseza | `verified` | 0 | 5 | 2 | `da24a473-434a-420e-b705-0867c3a45fc4` | Amumpaire denis |
| 18 | `9dce5132-009b-4c57-8974-d02ed444d50c` | NAMUGENYI GLADYS | `verified` | 0 | 1 | 1 | `f7e78d18-fd78-41f0-adef-b7203276840b` | nankinga lairah |
| 19 | `b921c78c-e1be-46a9-a3d2-15efa84050c3` | Ssenkungu Paul | `verified` | 0 | 3 | 1 | `508f8f04-c037-4dc3-9fab-00ddd5ce7979` | Najingo Aisha |

---

## 5. `duplicate_phone` — Landlords Sharing a Normalized Phone Number (`757` records across `289` shared-phone groups)

Across `public.landlords`, **757** landlord records share a normalized phone number with at least one other landlord record (**289** distinct shared-phone groups; phone numbers omitted). All 289 groups are listed below by group size, landlord IDs, names, verification statuses, and Rent Plan counts.

| Group # | Records Sharing Phone | Landlord Records (`landlord_id` — Name — Status — Live/Total Plans) |
|---:|---:|---|
| 1 | 40 | `15649e7d-28b2-47fd-9a2e-ad7d09e9c612` (Kayondo Sharif, `pending`, 1/1 plans); `c6391f74-f303-442b-b6a0-e3d61407c2e7` (Kayondo Sharif, `pending`, 1/1 plans); `ef94436e-435e-466c-aca5-ba8bad88a107` (kayondo Sharif, `pending`, 0/1 plans); `5ed4d80b-c089-4585-9311-42bf63d4d369` (kayondo Sharif, `pending`, 0/0 plans); `c1a4c462-1d00-49a0-b53c-023791ed1016` (Kayondo Sharif, `pending`, 0/0 plans); `dd5e33d4-1f4e-42fd-b2bf-df979e97ec02` (Kayondo Sharif, `pending`, 0/0 plans); `10d1c3cc-bc24-482c-88ed-39a6df0dc7fb` (Kayondo Sharif, `pending`, 0/0 plans); `c41a464e-3dbc-4c97-b7d8-3855b47f7b59` (Kayondo Sharif, `pending`, 0/0 plans); `cfb26d75-20b7-4c16-9e95-afa4e81cf6eb` (Kayondo Sharif, `pending`, 0/0 plans); `a3503cee-e189-4c37-bfe6-13564e284c2b` (Kayondo Sharif, `pending`, 0/0 plans); `96f63a18-ec7a-498e-8319-9b66baa471c9` (Kayondo Sharif, `pending`, 0/0 plans); `18e5c394-0197-458b-b296-419068a9f442` (Kayondo Sharif, `pending`, 0/0 plans); `8da8f9bb-903f-48bf-9024-634dd8ff4535` (Kayondo Sharif, `pending`, 0/0 plans); `53effb99-4344-4fed-851e-a6960defa971` (Kayondo Sharif, `pending`, 0/0 plans); `b4731cb5-884f-443f-b3f2-0b0c6a1a454a` (Kayondo Sharif, `pending`, 0/0 plans); `324d1bfe-094f-4562-bbcf-b72e9151775a` (Kayondo Sharif, `pending`, 0/0 plans); `d975a7f3-3b2c-4379-80f1-9fd146354dc4` (Kayondo Sharif, `pending`, 0/1 plans); `0dfb4848-885b-4241-8735-553c14c9e0ba` (Kayondo Sharif, `pending`, 0/0 plans); `347583b6-e6b8-45d6-9576-dda6ee5d5f3d` (Kayondo Sharif, `pending`, 0/0 plans); `cf658b98-200f-4b87-9024-e810f57877fe` (Kayondo Sharif, `pending`, 0/0 plans); `9e59f7ad-4414-4df3-b903-07c3f3967d47` (Kayondo Sharif, `pending`, 0/0 plans); `90921062-ff11-4174-9521-7d03e5acb9da` (Kayondo Sharif, `pending`, 0/0 plans); `95122b6a-7079-491f-a338-8a04e7453eca` (Kayondo Sharif, `pending`, 0/0 plans); `4e9706aa-dcdf-4e61-bd35-335f11a13651` (Kayondo Sharif, `pending`, 0/0 plans); `93029a36-8b2f-47c0-a53c-30ff5d97de8e` (Kayondo Sharif, `pending`, 0/0 plans); `a05058a6-5e88-4a84-a840-2fb26f742b34` (Kayondo Sharif, `pending`, 0/0 plans); `d617ca4b-7f10-48e6-9362-dd623594eb74` (Kayondo Sharif, `pending`, 0/0 plans); `17295f61-38d2-4a7a-b3e7-69a9031bf84c` (Kayondo Sharif, `pending`, 0/0 plans); `a306a142-5ff8-46de-bead-8633dac3d7ba` (Kayondo Sharif, `pending`, 0/0 plans); `e823d94c-5248-4350-b5b4-4c1c76f77a0f` (Kayondo Sharif, `pending`, 0/0 plans); `b730bb09-41c0-4501-a80e-6c9e86e5081a` (Kayondo Sharif, `pending`, 0/0 plans); `c96aacd9-4555-4bf3-8ca5-4b49b536737d` (Kayondo Sharif, `pending`, 0/0 plans); `0f467873-a9d0-4a1a-9e10-b99f1019d177` (Kayondo Sharif, `pending`, 0/0 plans); `3760e127-27c1-4ed2-8364-8a4f959b858a` (Kayondo Sharif, `pending`, 0/0 plans); `de450e2b-1e1a-48d6-a937-a600b882f1a5` (Kayondo Sharif, `pending`, 0/0 plans); `3e4afe93-e71e-4062-bba1-cd94353599aa` (Senyondo Sharif, `pending`, 0/0 plans); `a5ad1e1b-18ab-4de6-8691-e04dfbdadb09` (Senyondo Sharif, `pending`, 0/0 plans); `184fbddc-4dfb-456e-b902-a663e4a3c678` (Senyondo Sharif, `pending`, 0/0 plans); `8032d0f7-f48a-4f5e-9cf8-1a5dd3207173` (Senyondo Sharif, `pending`, 0/0 plans); `9831c8cf-969b-44d4-8b06-39ee4ca0bbff` (Ssenyondo sharif, `pending`, 0/0 plans) |
| 2 | 34 | `7023fb0e-e8cb-497b-9447-2e4f25a54361` (Nawudo joan, `pending`, 0/0 plans); `60bbbe6f-f950-4af2-b0d3-3ce194e2d4f4` (Nawudo joan, `pending`, 0/0 plans); `6574da1c-4c5a-4f95-985b-e72e22cb3e13` (Nawudo joan, `pending`, 0/0 plans); `6c5ec493-de8f-4876-aa91-b30985fb86a2` (Nawudo joan, `pending`, 0/0 plans); `ce89a568-685b-4b8b-9287-5c26f770b0f8` (Nawudo joan, `pending`, 0/0 plans); `3f20aef5-270c-4d5a-ac9d-0fcd69f9c9bb` (Nawudo joan, `pending`, 0/0 plans); `ad75e184-655c-4ce3-950e-53ca0c6d6333` (Nawudo joan, `pending`, 0/0 plans); `81eab316-3144-4c95-b24d-896111300c8e` (Nawudo joan, `pending`, 0/0 plans); `d488ad2a-121a-4ce9-b0a0-7fb72ec4f2d6` (Nawudo joan, `pending`, 0/0 plans); `d9886c2d-72b0-415a-8177-b7e94c942e22` (Nawudo joan, `pending`, 0/0 plans); `7ab51fd5-38e9-496c-86e1-ce4739fe666f` (Nawudo joan, `pending`, 0/0 plans); `d31fb556-022c-4b77-9c05-a35482dbe4e9` (Nawudo joan, `pending`, 0/0 plans); `e62ceacb-d5f4-4720-a98a-702a14896a78` (Nawudo joan, `pending`, 0/0 plans); `c07fc8c6-54db-4fb9-9763-2358b7f9a8be` (Nawudo joan, `pending`, 0/0 plans); `b9d58118-4189-4423-92a3-9c4fe195b261` (Nawudo joan, `pending`, 0/0 plans); `761dfa42-1426-48d5-b68f-de43203162f6` (Nawudo joan, `pending`, 0/0 plans); `0ebcf077-088f-4e78-ba48-40edd7e535a7` (Nawudo joan, `pending`, 0/0 plans); `993ed9b0-6e21-4363-acc7-c799e10ca4b2` (Nawudo joan, `pending`, 0/0 plans); `62d1b9e0-eee9-4aa6-a484-b8df36210113` (Nawudo joan, `pending`, 0/0 plans); `d69bcf1a-7ff5-447b-a725-59d2664eea3c` (Nawudo joan, `pending`, 0/0 plans); `8e53468b-6a7e-4189-8a05-a69e62249df2` (Nawudo joan, `pending`, 0/0 plans); `63403545-a2bb-472d-b440-517359e5455a` (Nawudo joan, `pending`, 0/0 plans); `107da83e-2512-427f-8ac7-3b560544c276` (Nawudo joan, `pending`, 0/0 plans); `2be39606-0e6e-4995-8398-cb15725f268a` (Nawudo joan, `pending`, 0/0 plans); `10483604-d3c2-40dc-b56a-4b752effa52a` (Nawudo joan, `pending`, 0/0 plans); `750e5e23-eb0a-4a32-9d05-a81931a9df5e` (Nawudo joan, `pending`, 0/0 plans); `de87f7f8-2c9e-454c-a417-f59de151826c` (Nawudo joan, `pending`, 0/0 plans); `a5af1894-0548-42e5-ba1a-5e57df5725d1` (Nawudo joan, `pending`, 0/0 plans); `13e2d0a8-0410-4e4e-ace2-9dbd580d2818` (Nawudo joan, `pending`, 0/0 plans); `a78289fd-4d4a-41a2-b8a4-47c49d8d22ac` (Nawudo joan, `pending`, 0/0 plans); `cf0d1746-207d-49b2-9d3b-b8a57a43ea87` (Nawudo joan, `pending`, 0/0 plans); `094b5896-dd31-47b7-b5d8-c8ef91ab3e46` (Nawudo joan, `pending`, 0/0 plans); `4cef624d-e07d-43bb-914d-fc65cc50c359` (Nawudo joan, `pending`, 0/0 plans); `c2d34830-6c86-491d-8926-8bed2147c818` (Nawudo joan, `pending`, 0/0 plans) |
| 3 | 32 | `a8f546a3-873d-4229-ad7c-3208ba3feca6` (Benjamin  Muhanguzi testing, `pending`, 0/0 plans); `e66998f0-829b-4a32-a3be-fcc0f18c91de` (Benjamin Muhanguzi, `pending`, 0/0 plans); `f47204b7-301f-4caf-8acf-c31fb9dc46e3` (Benjamin Muhanguzi, `pending`, 0/0 plans); `26d109e5-c950-49da-9862-2a73797cb928` (Benjamin Muhanguzi, `pending`, 0/0 plans); `e7e302b7-3610-45de-836c-caac736e1b43` (Benjamin Muhanguzi, `pending`, 0/0 plans); `8bea455a-a3b4-4b2b-a7c9-c7536a1cc666` (Benjamin Muhanguzi, `pending`, 0/0 plans); `3f2c96dc-927a-4c81-b763-e7c247a237bd` (Benjamin Muhanguzi, `verified`, 0/1 plans); `1887e608-1b54-4e21-8c83-a41eafc03594` (Benjamin Muhanguzi, `pending`, 0/0 plans); `c534f62c-e379-4a98-bd38-54f0ba61dfcd` (Benjamin Muhanguzi, `pending`, 0/0 plans); `89425bb8-6bbc-49ee-b4b0-7114651e82a4` (Benjamin Muhanguzi, `pending`, 0/0 plans); `a95f43ac-49da-4b2c-ac14-d3fad7f82927` (Benjamin Muhanguzi, `pending`, 0/0 plans); `634ace16-14a7-4b96-8a66-c340b791c626` (Benjamin Muhanguzi, `verified`, 0/0 plans); `38e8c7ee-4f9e-40e7-90a4-37b2dad66976` (Benjamin Muhanguzi, `pending`, 0/0 plans); `2a151b1a-e33e-42c6-9a2a-ca5516dc6527` (Benjamin Muhanguzi, `pending`, 0/0 plans); `89e24bdb-6e18-48f7-bfaf-72cc17da52b2` (Benjamin Muhanguzi, `pending`, 0/0 plans); `26f51d3c-637e-4c01-8bbf-aff06244a549` (Benjamin Muhanguzi, `pending`, 0/0 plans); `97e8e325-e992-4a21-8b1d-9a783b2d5335` (Benjamin Muhanguzi, `pending`, 0/0 plans); `4ea65ee3-ed70-42f5-9552-d12ea85fb6f8` (Benjamin Muhanguzi, `pending`, 0/0 plans); `ba9bbddb-5139-4609-9c21-64e99e1c56cd` (Benjamin Muhanguzi, `pending`, 0/0 plans); `eff0208b-559d-47b1-859c-5d46140b0ed2` (Benjamin Muhanguzi, `pending`, 0/0 plans); `6c7fc3f1-f612-4510-b159-c92f834ab624` (Benjamin Muhanguzi, `pending`, 0/0 plans); `1434098a-9b17-4e59-9b07-69dee485cd29` (Benjamin Muhanguzi, `pending`, 0/0 plans); `f9160316-e219-4fc2-b4ca-4b88d951928f` (Benjamin Muhanguzi, `pending`, 0/0 plans); `f031d395-74c1-43e1-bcbd-08d42a85f826` (Benjamin Muhanguzi, `pending`, 0/0 plans); `309f26f5-7ba0-4857-9dd0-1c2f6fdd298c` (Benjamin Muhanguzi, `pending`, 0/0 plans); `7bb68882-1fa2-4f6f-a358-d83e7d239e95` (Benjamin Muhanguzi, `pending`, 0/0 plans); `85810e28-9fa9-49ac-b04e-fd4200ca3d8b` (Benjamin Muhanguzi, `pending`, 0/0 plans); `6177d24b-5452-4b51-b248-d30f8dfb4396` (Benjamin Muhanguzi, `pending`, 0/0 plans); `21f54507-dfd1-49d6-8290-a8812a1ac38d` (Benjamin Muhanguzi, `pending`, 0/0 plans); `c08e1820-91f6-45c1-9502-00bd1b55b3d7` (Benjamin Muhanguzi, `pending`, 0/0 plans); `b28b98ee-0ffb-4e9b-81eb-311b35a98108` (Benjamin test, `pending`, 0/0 plans); `80475b23-e37f-4b3b-9773-2fee34d90189` (James katongole, `pending`, 0/1 plans) |
| 4 | 9 | `d28fe1cb-f2ac-41e9-a084-51524bbc0dcd` (TUGUME NATHAN, `pending`, 0/0 plans); `1112ce66-30d9-48ba-ab8a-eafba2a86b51` (TUGUME NATHAN, `pending`, 0/0 plans); `c1b6d23a-5d4f-41f3-b3e1-5601cdae548d` (TUGUME NATHAN, `pending`, 0/0 plans); `910f3af5-7f02-46e8-a8f3-795c16505e9d` (TUGUME NATHAN, `pending`, 0/0 plans); `137069af-605d-4e30-8486-34bbd97b4b68` (TUGUME NATHAN, `pending`, 0/0 plans); `a228fb8d-2177-417d-a6aa-03f91827e043` (TUGUME NATHAN, `pending`, 0/0 plans); `6b102b52-d929-4642-bd34-d678c7d8b54a` (TUGUME NATHAN, `pending`, 0/0 plans); `f6f09a1a-e4fd-4526-846c-9b14ace699a3` (TUGUME NATHAN, `pending`, 0/0 plans); `a98affef-1265-4c4b-80c5-54fbfb713774` (TUGUME NATHAN, `pending`, 0/0 plans) |
| 5 | 7 | `db23d7e1-8b5c-42e3-a28a-10da66dd3ea2` (Masaba Elvis, `pending`, 0/0 plans); `1d7e3d23-49b2-4c12-bcd6-43a88793f0d9` (Masaba Elvis, `pending`, 0/0 plans); `56c935ee-4ffc-40dc-a4c1-9a057e36a1df` (Masaba Elvis, `pending`, 0/0 plans); `1a70e12c-1297-40f4-82e4-05622117b8c8` (Masaba Elvis, `pending`, 0/0 plans); `ed4b8cb4-a3fd-4e81-919c-f5bb019f1c12` (Masaba Elvis, `pending`, 0/0 plans); `4ac6ed38-a255-4bf7-8419-1f7925615876` (Masaba Elvis, `pending`, 0/0 plans); `64649dca-e766-4ec3-9138-c5cf5803ac53` (Masaba Elvis, `pending`, 0/0 plans) |
| 6 | 5 | `12bb4cbf-171a-489a-8d71-6e2a276833d7` (Michael Mukama, `verified`, 2/2 plans); `cbbfbbea-c6ad-4405-93a1-3e622619bc29` (micheal mukama, `verified`, 2/2 plans); `2469a8ef-3d09-4043-93a8-7112ec33f816` (micheal mukama, `verified`, 1/1 plans); `5061cf79-8861-432c-a0a6-d8460096420a` (Michael Mukama, `verified`, 0/1 plans); `a2c0e3ce-1480-49c5-a026-5d7a3476ee7f` (Sakwa Joel, `verified`, 0/6 plans) |
| 7 | 5 | `13e19329-fde4-4a55-aa89-333cf8feb6c8` (Nakakande Maria, `pending`, 0/0 plans); `96fa45e7-b47f-40ca-bfdb-8684df9dc3c2` (Nakakande Maria, `pending`, 0/0 plans); `a9f7cded-a6ae-4b67-899a-3646f9e1bedc` (Nakakande Maria, `pending`, 0/0 plans); `d03f2a3c-78f2-4dd6-a7bf-5270602d464f` (Nakakande Maria, `pending`, 0/0 plans); `8b3a1a28-8b32-4088-8c94-df4089251574` (Nakakande Maria, `pending`, 0/0 plans) |
| 8 | 5 | `b7325035-2eba-4f11-b3d2-e2b9791cbd21` (Grace, `verified`, 1/2 plans); `af7bc356-7ae6-4d47-9e2b-02354c2e121a` (Grace, `pending`, 0/0 plans); `aba238cf-302c-4978-85be-f11e3efdab86` (Grace Paul, `verified`, 0/1 plans); `7b0a366c-feea-4948-ac76-5902ca577649` (Paul, `pending`, 0/0 plans); `62a20d96-e56b-401b-a648-e73c4e4643b2` (SSEMUSU, `verified`, 0/2 plans) |
| 9 | 5 | `1982b225-15f9-4865-8e21-647759d54171` (Byansi Amos, `verified`, 4/9 plans); `60cd7a58-e5d0-479b-b39a-6f86d67d66f4` (byansi amos, `verified`, 1/3 plans); `6780ef6f-895d-44e7-80ff-7f55b8392ea7` (Byansi amos, `verified`, 1/2 plans); `2d5fdddd-fa47-42d7-bb9c-c81654a1ac51` (Byansi Amos, `verified`, 1/2 plans); `0a44f83d-906a-4e3f-94d0-0c7be3759555` (Byansi Amosi, `verified`, 1/2 plans) |
| 10 | 4 | `5a87c01f-6acc-43b4-81ba-8aac89efd04a` (Easwa bu, `pending`, 0/0 plans); `b0ca63ae-1014-4cb1-a6be-3a4a41fb344e` (Reru jikol, `pending`, 0/0 plans); `129280d4-842d-43e8-8e97-0fb0f4407ab8` (Reu jiko, `pending`, 0/0 plans); `87e0d274-865e-4d9a-b4d5-3a71da632a31` (Rewu hijo loki egeb, `pending`, 0/0 plans) |
| 11 | 4 | `5bf444c4-89b5-45d6-ac49-e6df312e0b5e` (Mugenyi Brian, `pending`, 0/0 plans); `8439bc6b-8ca6-4301-b668-d38296f1956f` (Mugenyi Brian, `pending`, 0/0 plans); `95427504-3b81-4b43-a67d-2c259f991505` (Mugenyi Brian, `pending`, 0/0 plans); `4da0b2ae-f258-4a1a-9532-2e09e8581b5b` (Mugenyi Brian, `pending`, 0/0 plans) |
| 12 | 4 | `e622b501-3838-4257-b224-4fa96795b178` (deo ka, `pending`, 0/0 plans); `b57d4b11-e655-42a9-9ab9-f51123c6fc71` (haih jjaj, `pending`, 0/0 plans); `1cbf0f88-e18f-40cf-81a4-11a27b645141` (oz ora, `pending`, 0/0 plans); `2fae0a1a-f63b-497b-ba60-f0f34f803f2b` (yun yun, `pending`, 0/0 plans) |
| 13 | 4 | `18353a93-013b-4554-acc9-fc7544534502` (Ssebussi Asuman, `pending`, 0/0 plans); `1a155afd-8689-4b9e-a9f4-99ebd7524274` (Ssebussi Asuman, `pending`, 0/0 plans); `0c092c0a-1a6a-433d-96a6-76965956439b` (Ssebussi Asuman, `pending`, 0/0 plans); `9a1cd5a3-2064-4c53-ba31-f5a05474aec1` (Ssebussi Asuman, `pending`, 0/0 plans) |
| 14 | 4 | `177e3521-2272-4284-aaa6-0299674baa1f` (sebowa  Edward, `verified`, 1/1 plans); `0f98ff7d-5c5d-47b2-8931-77e878ee7094` (sebowa Edward, `pending`, 0/0 plans); `5f25cb3a-158b-47ba-8588-7f2bc269b824` (sebowa Edward, `verified`, 0/0 plans); `7247cfd5-04d8-4cd3-8094-c3b2916bf439` (sengobi Edward, `verified`, 0/1 plans) |
| 15 | 4 | `caa16b3c-bf46-4796-98ab-4d39f22e3759` (Isidore kabanda, `pending`, 0/0 plans); `4b176a24-685e-43e5-baf8-07d6958c6946` (Isidore kabanda, `pending`, 0/0 plans); `a11bcdf8-77f3-47d2-bd78-a2d2ce2433c3` (Isidore kabanda, `pending`, 0/0 plans); `7081e004-62d5-4737-a7b8-50cd63286fbf` (Isidore kabanda, `pending`, 0/0 plans) |
| 16 | 4 | `79abb678-4102-40c9-afb0-538ee040275d` (Muyambi Boniface, `verified`, 1/2 plans); `18baf79c-75d0-4f3a-a2fb-95c3b0a4063a` (MUYAMBI BONIFESI, `verified`, 1/2 plans); `5940fdec-6bec-449c-ae53-1d07074b2748` (muyambi boniface, `verified`, 0/1 plans); `4f59dbb2-2b58-4523-b3a3-2a20bfe36f9e` (Muyambi Boniface, `verified`, 0/3 plans) |
| 17 | 4 | `745d54f2-dcc7-42a9-b148-46a76f24c483` (Apophia Tumuhamye, `verified`, 3/7 plans); `07569abc-8af4-4a46-a9ab-1d106bc260f1` (Apophia Tumuhamye, `verified`, 1/3 plans); `93da8d9a-7fb6-409f-a2d4-55076a685098` (Apophia Tumuhamye, `verified`, 1/3 plans); `70584a97-f3d2-44f1-95a6-ae4748ec9b75` (Apophia Tumuhamye, `verified`, 0/5 plans) |
| 18 | 4 | `0ce529da-8e0e-4f31-b348-d6ac1bb5d5b7` (mubba yowana, `pending`, 0/0 plans); `8e4b71d2-6244-4499-96d4-b3ed87411e61` (mubba yowana, `pending`, 0/0 plans); `2c1d763d-f6e1-4a3b-9b60-ff24a868ac32` (mubba yowana, `pending`, 0/0 plans); `0bbdc3f4-5454-459f-b8d3-50f1aa29c07c` (mubba yowana, `pending`, 0/0 plans) |
| 19 | 4 | `b0d67df4-8dc2-44ec-95a1-78b767903f23` (Michael Mukama, `verified`, 6/10 plans); `f3ed3d39-4940-4a38-9f13-ba3c918a0f96` (Mukama Micheal, `verified`, 3/3 plans); `fba3e60b-3103-46fe-a503-880c2cfedcd9` (mukama Michael, `verified`, 1/4 plans); `4f60d478-4ba3-4674-9ecc-529d14c15e07` (Mukama Michael, `verified`, 1/2 plans) |
| 20 | 3 | `a0e58348-3670-46d1-a321-fca54403b5d1` (mubanda jackson, `pending`, 0/0 plans); `4cee6d29-cfe1-4a47-8a18-edd53f2f61c4` (peace max, `pending`, 0/0 plans); `cbbfd341-88ba-4b06-a87c-064c4665e60b` (sac sec, `pending`, 0/0 plans) |
| 21 | 3 | `cfa270fd-f6d9-4987-813f-2e705435db89` (ges sek, `pending`, 0/0 plans); `79e11043-b675-407a-9aef-89e79a2d93ad` (hua naka, `pending`, 0/0 plans); `fc5b72c8-88a1-4ce3-aea7-fab869c67116` (kale senb, `pending`, 0/0 plans) |
| 22 | 3 | `956e9875-bf08-4afb-a19f-d3542d162348` (jelly son, `pending`, 0/0 plans); `ee054d3d-ee49-457d-9f3f-bc04a4714ec1` (nutyy neith, `pending`, 0/0 plans); `1bb1800e-3bfa-4052-aae7-9df8932c991e` (sams son, `pending`, 0/0 plans) |
| 23 | 3 | `3d805136-b21a-4b5d-80d5-6901ce8f7030` (dey grul, `pending`, 0/0 plans); `dccbb477-a599-4b64-843f-1332a39dc29f` (dey grul, `pending`, 0/0 plans); `ceb06c6b-225a-45ac-bd57-ed62ea73c2c8` (jack ygj, `pending`, 0/0 plans) |
| 24 | 3 | `392cfd6f-7503-42e9-9ded-4580236ac6a2` (Nakisuyi Eseza, `verified`, 1/3 plans); `7a4a3d25-e186-4963-b03e-02e20d8397e3` (Nakisuyi Eseza, `verified`, 1/3 plans); `39d1babf-24a5-4525-a8bc-ef2ef746c6b3` (Nakisuyi eseza, `verified`, 0/5 plans) |
| 25 | 3 | `88127445-3e57-43a7-933c-67e3d2dc122f` (Mathias nasasira, `verified`, 1/1 plans); `86ad4e09-5162-4f6c-8f3f-94a2920a6411` (nasasira mathias, `verified`, 1/4 plans); `d0a4cd5a-fcfc-4034-b217-b714d4862cfc` (Nakimuli Christine, `verified`, 0/3 plans) |
| 26 | 3 | `769ede52-98e7-4a8f-b59e-7985eb17f136` (sebuliba bosco, `verified`, 2/7 plans); `8154c7b7-7422-45f6-88e0-24447604013b` (sebuliba Bosco, `verified`, 0/6 plans); `d409b70e-0aa6-4f6a-aba6-c4cd51f1b6b5` (Ssebuliba Bosco, `verified`, 0/3 plans) |
| 27 | 3 | `0bab26f8-e500-474c-bfe9-d4b55d9dbda0` (iopo moo, `pending`, 0/0 plans); `c88df228-1751-4f35-9be3-c1d597e8d54e` (lop ill, `pending`, 0/0 plans); `e5fdb814-5515-4be5-90cd-758f76d3f91a` (mum noi, `pending`, 0/0 plans) |
| 28 | 3 | `697a79c5-09d2-4d93-a91e-badca01d9393` (Gonzaga Mayengo, `verified`, 1/5 plans); `8e87c89a-76bb-4190-9352-36ae8f5c01e5` (Gonzanga Mayengo, `verified`, 1/1 plans); `19716a03-6698-4764-95aa-5031b10f3a32` (Mayengo Gonzaga, `verified`, 0/3 plans) |
| 29 | 3 | `0b555eb6-d346-437c-8e80-aca20629c474` (REHEMA WONAIRA, `verified`, 1/2 plans); `a6844e4f-2f9b-4a38-9347-43e69a4e4708` (wonairu rehema, `verified`, 1/2 plans); `1bf3a1b0-9238-4574-82bc-ff89c3682dc0` (wonaira rehema, `verified`, 0/2 plans) |
| 30 | 3 | `d6903616-c373-4722-88eb-1c16aacb5244` (huy ter, `pending`, 0/0 plans); `22b38636-0386-48e8-87c6-a3740ee33af1` (ins eeu, `pending`, 0/0 plans); `b0d02de5-853c-4965-acb5-b2a9a057a916` (poas jsis, `pending`, 0/0 plans) |
| 31 | 3 | `8510a06d-676b-48a2-93b7-935411609c72` (ivan batte, `verified`, 2/9 plans); `c9010ea6-6649-4115-8f02-68d4074e252e` (batte ivan, `verified`, 1/6 plans); `4621e569-a50e-4190-98fb-0f7205b554a9` (batte Ivan, `verified`, 1/2 plans) |
| 32 | 3 | `65800879-2068-4f3f-893a-c2546a125087` (Joyce Bashimwe, `verified`, 2/2 plans); `b97b74d5-f700-4d04-8fb4-132556553678` (Joyce Bukwira, `verified`, 1/1 plans); `3b52020b-026e-45f1-8c60-1416125ebeee` (Joyce Bashimwe, `pending`, 0/0 plans) |
| 33 | 3 | `2f534fb3-c733-408e-bfd9-12c0c5941bf4` (ban see, `pending`, 0/0 plans); `7f2ca962-b250-492f-8f9a-a0d188aa0524` (hu isja, `pending`, 0/0 plans); `ee18f576-7560-485b-85f0-598bc8af81f9` (man gat, `pending`, 0/0 plans) |
| 34 | 3 | `099d6f8b-a351-439f-99f0-43c0395ca16c` (ssejjemba michael, `pending`, 0/1 plans); `6043d3d6-7f8a-423a-87cb-79f634d5855e` (ssejjemba michael, `pending`, 0/0 plans); `9cd26547-1795-46ff-a686-63e0b83a3e4d` (ssejjemba Michael , `pending`, 0/0 plans) |
| 35 | 3 | `07fc72ca-68d0-4b22-ac49-08fca1171814` (Asumani Mukabire, `pending`, 0/1 plans); `1a73d382-4387-4616-a44c-07f15f267273` (Asumani Mukabire, `pending`, 0/0 plans); `aa8a8a96-aba4-4040-b9ca-817625a64ca9` (mukabire Asumani, `pending`, 0/0 plans) |
| 36 | 3 | `acdadcc6-8d44-43c6-89e5-3385978b9e5a` (DI RE, `pending`, 0/0 plans); `a19f34c3-6a0f-49a6-a3dc-28622a067f84` (VIN KIO, `pending`, 0/0 plans); `a1ab7ffd-f4ca-4c2b-8d70-f182ffa16c8d` (XU BI, `pending`, 0/0 plans) |
| 37 | 3 | `41b9bcbe-736d-406d-824a-5bd167706eb8` (Cosma justine, `pending`, 0/0 plans); `971e9398-4201-41cb-b10b-d8d85eab0cf3` (dure duer, `rejected`, 0/0 plans); `87dd4eae-8d30-4db8-a548-41bc652edd4b` (ops ks, `pending`, 0/0 plans) |
| 38 | 3 | `dce1a973-8af4-4d30-a997-23d0473208b1` (AVERT MATIKA, `pending`, 0/0 plans); `7cc3551c-8d63-479f-82ee-0fccb9bc5d6e` (LI LO, `pending`, 0/0 plans); `ca1c5c81-ab42-41ba-831b-4f1f83d76fae` (RU JI, `pending`, 0/0 plans) |
| 39 | 3 | `c4967af7-4ec4-4bff-bdbd-d9641c242173` (aagatha thank, `pending`, 0/0 plans); `42b99660-751a-4949-a12a-4189a2dddf9f` (has deeu, `pending`, 0/0 plans); `c2a48b29-9671-4890-b181-3e0b5f819d24` (ssenyonjo mak, `pending`, 0/0 plans) |
| 40 | 3 | `8e42db0e-9629-4510-b057-dc56d7ee8cad` (nasd erasw, `pending`, 0/0 plans); `9b12fac6-152b-46c6-ba5f-35624af7a411` (terem newim, `pending`, 0/0 plans); `86d5ecee-5939-4bb5-a03e-e2dfc0207a28` (wert guim, `pending`, 0/0 plans) |
| 41 | 3 | `378e8dd3-a28c-44c2-9638-5af20819e68d` (gau halp, `pending`, 0/0 plans); `73f8ab59-9cd8-4db9-a960-554a8b91aefa` (hau hau, `pending`, 0/0 plans); `12c3b03f-2aeb-4fde-bf89-1d74ef228267` (res tey, `pending`, 0/0 plans) |
| 42 | 3 | `17d53512-9a56-4666-b005-a6a9d09dc066` (fio fi, `pending`, 0/0 plans); `4cdcc9d6-004c-4491-982f-2dad5c64fa3a` (fu fio, `pending`, 0/0 plans); `892b3bf2-7d5e-4e41-ba73-d73727129e07` (sorry hget, `pending`, 0/0 plans) |
| 43 | 3 | `a169e906-1b10-4c42-b78d-8a6e25cca03b` (avaa peace, `pending`, 0/0 plans); `7cb95fd3-6e35-4bdc-baa7-08a8bb201629` (brond bae, `pending`, 0/0 plans); `d3371436-b142-4ab3-9034-60c6efdc1bd6` (moon sun, `pending`, 0/0 plans) |
| 44 | 3 | `45183f81-80f2-426a-b369-11ad211f8720` (Naluwayiro Emmanuel, `pending`, 0/1 plans); `6e642326-913e-405f-8843-5161af78fb01` (Naluwayiro Emmanuel , `pending`, 0/0 plans); `01a0c8e6-8a86-4a43-b724-51e71366aa45` (Naluwayiro Emmanuel , `pending`, 0/0 plans) |
| 45 | 3 | `14a886da-8906-4ac4-b86f-ef2e5913ac09` (kizito Richard, `verified`, 2/5 plans); `87300712-3ea0-47d4-b9c0-bf02bb6739b6` (kizito richard, `verified`, 1/3 plans); `c6fd6b04-c2d3-49c9-8ccd-a9a8922b5055` (kizito Richard , `verified`, 1/3 plans) |
| 46 | 3 | `9e3a068f-9938-40d1-b79a-6c7e732bb0f4` (hau hai, `pending`, 0/0 plans); `99f84e30-40a8-4030-85e5-88cab49013f5` (iwj he, `pending`, 0/0 plans); `a9f52f10-2db1-4cbc-be57-3bbbad59e3d5` (nia hau, `pending`, 0/0 plans) |
| 47 | 3 | `ecf2852c-0185-431d-9e24-978ca4536ccf` (hick you, `pending`, 0/0 plans); `893b51e3-5f35-4205-9535-76e1a8c9e9f5` (sea sky, `pending`, 0/0 plans); `9e38021d-758a-4a6c-a30a-0efa201dfa6d` (tax us, `pending`, 0/0 plans) |
| 48 | 3 | `6bf3c774-d44d-42b0-a717-24014e51e3b0` (broon bent, `pending`, 0/0 plans); `c5d21b10-27db-4a78-9851-c68dcd22a6a8` (han kass, `pending`, 0/0 plans); `1ae49431-d526-4276-84df-aa595be82f4a` (kann kann, `pending`, 0/0 plans) |
| 49 | 3 | `fadc6439-8c0b-4b64-8d88-a8c29c78594d` (hag mag, `pending`, 0/0 plans); `f48df8f9-b758-43af-acc5-dbeb93283d45` (ushg hah, `pending`, 0/0 plans); `0b03e510-f4f2-4472-a097-039218b0571e` (yan gan, `pending`, 0/0 plans) |
| 50 | 3 | `9af76908-58aa-4ffd-9528-598ac47f6570` (hau hauh, `pending`, 0/0 plans); `f9976a11-9a0b-4cd8-84e3-30370a75c758` (kale sdee, `pending`, 0/0 plans); `c109941c-6462-4451-adbd-211a77a49329` (kale yet, `pending`, 0/0 plans) |
| 51 | 3 | `38bd4af5-da11-410d-8921-81c8af987f31` (Maimuna Nambi, `verified`, 1/3 plans); `9b6437f5-6a9a-443a-8e7b-98fab95f5371` (Maimuna Edrine, `pending`, 0/0 plans); `c0cb14c2-8ab6-4bb8-9957-64e40dc39dc9` (Maimuna Nambi, `pending`, 0/0 plans) |
| 52 | 3 | `47030cc7-a8b5-4bba-b626-c34586ee1edd` (has see, `pending`, 0/0 plans); `6e505092-fa82-4502-bfd2-7844b55ebddd` (hua bajk, `pending`, 0/0 plans); `92fcea51-b3ae-4661-ba33-20abf84a4041` (man sdd, `pending`, 0/0 plans) |
| 53 | 3 | `4cad37bc-4f8c-46eb-8f05-1a828ba9e077` (Nabwire Jackie, `pending`, 0/0 plans); `7a5fe2fd-5c2d-40ae-b22d-9d782b55fb24` (Nabwire Jackline, `verified`, 0/2 plans); `26fcf0b2-ab1a-47b3-b90d-f719a8a0703c` (Nabwire Jackline, `verified`, 0/0 plans) |
| 54 | 3 | `445fa719-4d66-4841-adbb-daa7400a55f8` (han kann, `pending`, 0/0 plans); `432de263-4cb5-4922-a639-103e818ab799` (tuab hw, `pending`, 0/0 plans); `4c00b96f-0e2c-4dcc-b393-e79dd406c54b` (uhau jaj, `pending`, 0/0 plans) |
| 55 | 2 | `ed2f8d20-b879-4401-b399-2500a6dba5b1` (SER FATIMA, `pending`, 0/0 plans); `48e770c3-0225-46c9-a3a3-05889a2fbbc5` (srue driul, `pending`, 0/0 plans) |
| 56 | 2 | `b92af5c4-2985-4898-8e0e-7d0bfd01925f` (hav sg, `pending`, 0/0 plans); `a6f39f58-3aeb-4599-a326-e667a818fca3` (kou fee, `pending`, 0/0 plans) |
| 57 | 2 | `6d760705-6067-4d5a-8e36-df1e3919d5e5` (Dumba Benvo, `verified`, 1/1 plans); `ddf7fce9-0ab8-49a3-9ca7-811325259fd2` (Ddumba benvo, `verified`, 0/1 plans) |
| 58 | 2 | `ab9c30c5-e172-40c1-9d47-1a4ff3b4ee80` (Mebal Nyakayisiki, `verified`, 1/1 plans); `4cc4e6c4-0b16-4a9b-bac9-4c9a75198758` (Joan Marble, `verified`, 0/0 plans) |
| 59 | 2 | `04e6b070-de1e-448e-bacb-8679b77deac3` (Elisa Phirimon Ouma, `verified`, 1/1 plans); `bedf7e60-d86c-4b0c-ba63-602243c8c573` (phillmon ouma, `verified`, 0/0 plans) |
| 60 | 2 | `a29847be-d964-4a1e-94a6-7a9b0fd2b735` (Bisaso, `verified`, 1/1 plans); `ac5512aa-58c1-4abe-b33f-d3543674f921` (Kalungi Yasin, `verified`, 0/1 plans) |
| 61 | 2 | `0d114c45-b66d-40ee-8f09-6d3a5e8af046` (Rose Mary, `verified`, 0/1 plans); `6c956ef3-ac5b-475f-847b-72d6aeed3a2e` (Rose Mary, `pending`, 0/0 plans) |
| 62 | 2 | `b71cce0a-d6fb-40ac-b0b3-68c8416c575f` (dear friend, `pending`, 0/0 plans); `23a37c40-7334-4edf-833e-6c051b4fd279` (send faburega, `pending`, 0/0 plans) |
| 63 | 2 | `59f9e6fb-ed40-440e-844a-39c1995e00ad` (ow he, `pending`, 0/0 plans); `8fd7549c-fdf8-45db-bee2-a3981449107a` (taig ja, `pending`, 0/0 plans) |
| 64 | 2 | `2125015d-8296-4e9d-8fad-6bfb6f19296e` (Namyalo Betty, `verified`, 1/1 plans); `2d243b26-c60d-435c-bf34-0d7d76de6f7e` (Mamyalo Betty, `pending`, 0/0 plans) |
| 65 | 2 | `09363c74-c5bf-44c9-943a-b8faf97071de` (Atyamisa Timothy, `pending`, 0/0 plans); `6df88867-9cee-4fe6-b432-d1ad9615723f` (muzamilu twaha, `pending`, 0/0 plans) |
| 66 | 2 | `7891ef83-8220-421a-90e5-a1790902e0e8` (Alinitwe Ignitius, `verified`, 0/2 plans); `3ae338f7-0a18-4c95-bce9-af6e5f71e9ba` (him noni, `pending`, 0/0 plans) |
| 67 | 2 | `eda521d3-b73a-48f3-9a92-508d8383d032` (nabwami jane, `pending`, 0/0 plans); `54b34c8e-5d55-4a88-a6e0-5b64f375309c` (NABWAMI JANE, `verified`, 0/1 plans) |
| 68 | 2 | `eb445082-6110-438d-9204-6b5dae5f01ec` (efub hcv, `pending`, 0/0 plans); `de2646b3-87d3-4e04-abe3-35f8d33dbdf8` (ids his, `pending`, 0/0 plans) |
| 69 | 2 | `9d02902a-efe4-4b85-806d-6b4e5be5df63` (Akongo Safira, `verified`, 2/35 plans); `c5daad9a-73e4-4678-9b2f-e8b216df8227` (Nakidde Teopista, `pending`, 0/0 plans) |
| 70 | 2 | `d65c2ad7-830b-41fb-9324-ee1bc693313d` (Nakachwa Ruth, `verified`, 3/5 plans); `508544e3-7ef7-4de8-b558-fea6ff94d75b` (NAKACHWA RUTH, `verified`, 0/0 plans) |
| 71 | 2 | `e18cda5d-0a5c-4db8-aeb1-5958c89b0761` (hik kin, `pending`, 0/0 plans); `a8e33e6e-7340-4000-a395-dcdb05fe99e5` (him kim, `pending`, 0/0 plans) |
| 72 | 2 | `2b28c7f4-a283-403b-884c-203dc63a0ff7` (nakawoya sauda, `verified`, 1/3 plans); `8c37e2a4-82b4-4f6f-9f20-fef0da76db62` (Mama John, `pending`, 0/0 plans) |
| 73 | 2 | `18909e9d-96a0-49a0-b099-0c8e2a95e279` (Kayanja Linda, `verified`, 1/2 plans); `579be383-e0c3-4bdf-99da-4ace6549b34e` (kayanja linda pretty, `verified`, 0/0 plans) |
| 74 | 2 | `5c69a186-d51b-4a40-a0a3-6c127d377ba1` (duking babirye, `pending`, 0/0 plans); `d40a040f-7b2a-418a-bd51-280ae8d00ed8` (Wewe reru, `pending`, 0/0 plans) |
| 75 | 2 | `92f5eca7-e0b3-46dc-a1d0-41e7d6a06a37` (Adinga cissy, `pending`, 0/0 plans); `96589428-59a0-4cb9-a12b-b0e4e84638a0` (Adinga cissy, `pending`, 0/0 plans) |
| 76 | 2 | `03f3e164-3aab-4546-bc01-417fa81f900a` (ssembatya Brian, `pending`, 0/0 plans); `4f1365e1-5978-426d-bad4-e1c8b461e697` (ssembatya Brian, `pending`, 0/0 plans) |
| 77 | 2 | `8f2b48ee-36a1-49c6-ae13-12bd52609292` (churcoh aundgi, `pending`, 0/0 plans); `6361a187-670e-41bf-9158-a0dea25adeda` (teri tei, `pending`, 0/0 plans) |
| 78 | 2 | `41b3cb13-1811-4992-9ee8-114ddc2f6635` (Vugi nina, `pending`, 0/0 plans); `9f7af41b-9e12-44d2-99d7-bdf02dcc68a8` (Vuheru terede, `pending`, 0/0 plans) |
| 79 | 2 | `ceb40820-8e0e-4eeb-ac13-1fde770073cb` (han kall, `pending`, 0/0 plans); `7eab972d-b68f-4b2c-be41-092dea222438` (teddy sendi, `pending`, 0/0 plans) |
| 80 | 2 | `a5682649-ec48-4934-b4eb-adcb7f700f70` (Milly Lubega, `pending`, 0/0 plans); `bfb11fbf-c60e-49d1-adf9-4bcc25e94a31` (mugisha lsac, `pending`, 0/0 plans) |
| 81 | 2 | `068fc473-32f2-4e6d-8110-df73011f5f38` (Nabbosa Henrietta, `verified`, 4/8 plans); `76a56f90-1d91-4554-b861-fbed9f6ba387` (nabbosa Harriet, `verified`, 1/4 plans) |
| 82 | 2 | `e6180527-23d4-4ada-b1d7-db3362860085` (jiun mok, `pending`, 0/0 plans); `66847980-4b6d-47d8-a7f5-49f7ab5fc475` (oill care, `pending`, 0/0 plans) |
| 83 | 2 | `a4f0cb33-9495-4c04-bf53-5cd4bfa79081` (BCG but, `pending`, 0/0 plans); `80de352e-71b7-45ce-860f-71e715906852` (TEST LANLORD, `pending`, 0/0 plans) |
| 84 | 2 | `80e81dea-4693-4e64-af31-42e6ba58a9a5` (hiue dew, `pending`, 0/0 plans); `5f88a014-8405-4c6b-8268-5d3e64918aa7` (sen sen, `pending`, 0/0 plans) |
| 85 | 2 | `f3aed53f-d7e6-4b4f-ab7d-52355657ae64` (orbit rabit, `pending`, 0/0 plans); `f8d59274-78de-4377-8622-e7f33f2b214a` (ray len, `pending`, 0/0 plans) |
| 86 | 2 | `f72eefce-b95a-49f9-a160-ceb25f9b79d8` (Bukirwa mimi, `verified`, 0/0 plans); `d87af875-ce0f-47b6-aa4e-61cd974acd2a` (Bukirwa Mimi, `verified`, 0/4 plans) |
| 87 | 2 | `c0d1761d-7e38-4a26-9ac1-dafe5a1633d3` (Nsubuga Emmanuel, `pending`, 0/1 plans); `18974886-54d7-4987-a8a1-048c3b93f02a` (Nsubuga Emmanuel, `pending`, 0/0 plans) |
| 88 | 2 | `71794165-1333-41ab-a2e2-4d73fa77d076` (dur dur, `pending`, 0/0 plans); `c13b031c-8974-4daf-acb6-0851933c69b5` (hak nank, `pending`, 0/0 plans) |
| 89 | 2 | `eff3bb57-f570-4f2e-bf20-b31b4f3e8332` (Lutaaya Frank, `verified`, 1/1 plans); `fd71ae9a-5426-4419-88ab-1ddc6555d6eb` (Lutaaya Frank, `pending`, 0/0 plans) |
| 90 | 2 | `fced65cd-8d46-4afc-9ebc-72f387626809` (Kitonsa Richard, `verified`, 1/3 plans); `03dfae7c-b63f-48a1-8f14-aa660492b529` (Kitonsa Richard, `verified`, 0/4 plans) |
| 91 | 2 | `f5262513-716e-4e65-a69b-3ec1536ac099` (SSALONGO MARTIA, `verified`, 0/1 plans); `9e4205cd-855a-4052-a814-775bc53bbe14` (SSALONGO MARTIA, `pending`, 0/0 plans) |
| 92 | 2 | `9ebbc3bf-7301-41c7-a494-f25d106dcf8c` (gaga biba, `pending`, 0/0 plans); `816364e5-fc99-4761-ae16-cd2b850419d9` (Tjfkg, `pending`, 0/0 plans) |
| 93 | 2 | `59b9b0d5-2d24-44e2-9410-da1997c0802c` (fih fiog, `pending`, 0/0 plans); `7fd20595-e0f9-4ea0-8372-866129cd0820` (Yusuf usual, `pending`, 0/0 plans) |
| 94 | 2 | `b78b4b12-fb47-415d-b065-7fbe0f220cc9` (has deek, `pending`, 0/0 plans); `9d3a5838-6241-41fa-a7b4-843f6885f8ff` (noe nam, `pending`, 0/0 plans) |
| 95 | 2 | `32592906-4773-4b4b-ae41-43e771c9a9ec` (butch you, `pending`, 0/0 plans); `ef6af750-4f1d-4790-8770-6bf3381b2476` (visit night, `pending`, 0/0 plans) |
| 96 | 2 | `854acc1a-02f0-43e3-8c2a-1aed709549f7` (kigunddu james, `pending`, 0/0 plans); `14f6d412-decc-4895-88b8-6d8081cf52d8` (KIGUNDU JAMES, `pending`, 0/0 plans) |
| 97 | 2 | `e0ed251d-6f69-45ab-a31c-fb70b436d74f` (beo beo, `pending`, 0/0 plans); `cad7fce8-12f7-440a-9370-a8c82f24b384` (wes wes, `pending`, 0/0 plans) |
| 98 | 2 | `097602bb-402f-44e8-b3b3-75209b6d23c8` (kasamba najjibu, `verified`, 1/1 plans); `2b620d30-dea3-412d-af30-4bf891815068` (Kasamba Najjibu, `pending`, 0/0 plans) |
| 99 | 2 | `dde5a700-58b8-4111-abfe-586ce3274113` (guad life, `pending`, 0/0 plans); `d304dd87-c59c-4e84-9fcc-ff9e0b2bf4af` (jok goo, `pending`, 0/0 plans) |
| 100 | 2 | `6cf5768f-fa1b-4cc6-b380-cb7162224632` (Godfrey  lubega, `verified`, 1/2 plans); `da4472d6-f158-4687-8417-d3f57f2de2ae` (lubega Godfrey, `verified`, 0/1 plans) |
| 101 | 2 | `c21fdaf1-a2be-4b5a-a7cb-b46d5d8dae41` (kimera paul, `verified`, 1/3 plans); `f87a4803-bc30-4ece-b036-0f411ce256e2` (kimera paul, `verified`, 1/6 plans) |
| 102 | 2 | `2a2a9d02-0ac3-4896-9457-e556bbb86cc8` (mal gal, `pending`, 0/0 plans); `45f4c3cf-413e-42b3-a53c-076bd328a65f` (piej gid, `pending`, 0/0 plans) |
| 103 | 2 | `1daf296b-2c63-4024-b178-7421ab38f4b3` (dim lik, `pending`, 0/0 plans); `f71dc945-2a41-4f0f-8928-c8b90254e605` (jinm mioll, `pending`, 0/0 plans) |
| 104 | 2 | `29e15087-378b-4d1e-9822-8d3e52e35522` (aber innocent, `verified`, 2/14 plans); `7c44d3b9-c861-4d78-a7eb-f57a79650ac3` (abber innocent, `rejected`, 1/5 plans) |
| 105 | 2 | `5132c027-919d-4384-88d9-25031d233ebc` (Tony Balondemu, `verified`, 7/15 plans); `b76bb730-d9e3-484d-b746-d071c7a46274` (balondemu tony, `verified`, 1/5 plans) |
| 106 | 2 | `4668948a-fa27-4a86-923f-1ca59e0b9a90` (Nampijja Florence, `verified`, 1/1 plans); `932c89e7-5e93-472d-bf8c-f88dbdd8bf7d` (Nampijja Florence, `pending`, 0/0 plans) |
| 107 | 2 | `9e2fcce4-fae6-4de9-8c8b-a59c28d4651a` (swag mama, `pending`, 0/0 plans); `a5944f56-350b-4585-8cfc-644b4823ea23` (Tiffa gd, `pending`, 0/0 plans) |
| 108 | 2 | `de8bc78c-5b88-4448-8c96-46f3c251ac9c` (Abamerina Erina, `verified`, 4/139 plans); `4714e40d-237c-42e4-89d2-3e9d2a09052f` (Abamusiga Elina, `verified`, 2/20 plans) |
| 109 | 2 | `dbf458ae-ba05-4107-86f6-630e2ee80bf1` (Namubiru ritah, `pending`, 0/0 plans); `4af02b05-aada-4b81-b647-b0c56f997373` (Namulindwa Ritah, `pending`, 0/0 plans) |
| 110 | 2 | `02aad4ac-dbf6-4365-ae7f-d12c9809a78c` (ejambo francis, `verified`, 0/0 plans); `ff49ecb3-e447-4ba3-89f5-385e1b0a2e71` (Ejambo Francis, `verified`, 0/2 plans) |
| 111 | 2 | `c2f5e14d-eb49-4fdb-99ee-e196f9e84102` (alpha dog, `pending`, 0/0 plans); `4b87c072-bcb2-4da5-9255-f589f01d224c` (fix dick, `pending`, 0/0 plans) |
| 112 | 2 | `05a96e6e-e9aa-4b96-a917-534d05430ad4` (Makasa Edwad, `verified`, 0/0 plans); `b921c78c-e1be-46a9-a3d2-15efa84050c3` (Ssenkungu Paul, `verified`, 0/3 plans) |
| 113 | 2 | `55603cdb-9b6d-478a-af12-dc0de6ce3110` (che you, `pending`, 0/0 plans); `bf91440a-752f-4333-8c7f-5e7c39d0834a` (Mang Tomas, `pending`, 0/0 plans) |
| 114 | 2 | `95424931-5de1-4ccc-aa60-cc9c564f467b` (AKAMPURIRA ONESMUS, `verified`, 5/6 plans); `026db18b-a330-4e3d-8438-6665127d6b4e` (Akampurira Onesmus, `verified`, 0/1 plans) |
| 115 | 2 | `809f9834-94d4-44cd-a50a-38b250ff94bf` (KWEBELAHO JOAN, `pending`, 0/1 plans); `f1780591-bef5-4a3b-885b-45e75bac480f` (kwebelawo joan, `pending`, 0/0 plans) |
| 116 | 2 | `eb135e82-8aef-4fab-8943-98f7a7f68441` (Otim David, `verified`, 4/5 plans); `9c898c2a-8e07-41dc-8357-1818debbc87c` (wandera osca, `verified`, 0/0 plans) |
| 117 | 2 | `9c3f0d2d-5806-414e-8f8a-e4a593476006` (Diligenda Noah, `verified`, 1/2 plans); `11155f80-3832-4f4c-988d-d1f56ce1bed1` (Diligenda Noah, `pending`, 0/0 plans) |
| 118 | 2 | `cd8fc592-ed2c-488d-a56b-d0937b7d2225` (Nabakooza Jalia, `verified`, 1/2 plans); `81b07224-3549-49b3-89c5-efdd8875267a` (Nabakooza Jalilah, `verified`, 0/2 plans) |
| 119 | 2 | `709b1cf6-0c89-4297-933c-b9c8e2fe9739` (heyw nsaj, `pending`, 0/0 plans); `974207f5-f4da-403e-a126-6cd5e6ce1c11` (Karoli Zakaria, `pending`, 0/0 plans) |
| 120 | 2 | `3e4667dc-8aa3-4760-8e09-a8b28f637bbb` (Nasifu Miyingo, `verified`, 0/0 plans); `b1d1e3bb-f06c-4e75-8be8-cb404c4042be` (Nasifu muyingo, `verified`, 0/0 plans) |
| 121 | 2 | `a9837a4c-76ef-4348-972d-8f5b1c7c88e8` (did end, `pending`, 0/0 plans); `9c99dfa5-703a-45ca-9b5c-c0a753091ccc` (Rewui bujikol, `pending`, 0/0 plans) |
| 122 | 2 | `cda29196-103c-4475-8bbb-4d6a19ae83c7` (gilbert kizito, `verified`, 1/4 plans); `54e1ce9e-6a7d-4534-bced-33f5b0443983` (nakkawa eddith, `verified`, 0/1 plans) |
| 123 | 2 | `0cdd727a-f604-42b2-9d9b-d12cd1efe5e5` (Namutebi Beatrice, `verified`, 1/2 plans); `167edeea-c51a-45a9-8383-43c9c47af3dc` (Namutebi Beatrice, `pending`, 0/0 plans) |
| 124 | 2 | `0b9f61e7-30f7-4fac-91e2-199f943ae522` (not yee, `pending`, 0/0 plans); `4c4268e9-be54-429f-bcb9-da31cbaab8ec` (shakila figured, `pending`, 0/0 plans) |
| 125 | 2 | `bf4eed81-b6d4-41eb-ba19-5100384ab892` (MBAARI FRANK, `pending`, 0/0 plans); `988c1e40-f9af-45be-a0d3-f78c6fd515c5` (Mbare Frank, `verified`, 0/2 plans) |
| 126 | 2 | `2f36382f-bf0b-4e62-9f78-15116553c011` (Mr.MBABAZI GODFREY, `pending`, 0/0 plans); `e8b713ba-c6ab-4a8b-9662-51d134173c54` (Mr.MBABAZI GODFREY, `pending`, 0/0 plans) |
| 127 | 2 | `0660fd54-3cec-4888-a3b0-c49da36371ef` (has wed, `pending`, 0/0 plans); `5ddae6ff-86ae-4246-952e-80163c3dc426` (hes jjn, `pending`, 0/0 plans) |
| 128 | 2 | `04e76516-7f22-40db-839c-6599edbcf4a7` (nazani hamilu, `pending`, 0/0 plans); `71b6ad9a-eaf4-4851-8b0a-82a03f7aa500` (nazani hamilu, `pending`, 0/0 plans) |
| 129 | 2 | `abea894f-890f-4aaa-ac47-ffb42b204750` (Gereri vujiko, `pending`, 0/0 plans); `5e7589e0-8444-4204-847b-135e28c93834` (nam nio, `pending`, 0/0 plans) |
| 130 | 2 | `bff5fa4f-989c-495f-9392-38c797be637f` (avaga you, `pending`, 0/0 plans); `31207665-601a-465d-9cfb-c1a6057228c9` (chicken girl, `pending`, 0/0 plans) |
| 131 | 2 | `14c31b7a-4a0a-4b5f-bc41-5688e2bbb9aa` (sebufu ivan, `verified`, 1/1 plans); `87b2e39d-42eb-4eb1-bf86-4c33d8f68569` (Ssebuffu ivan, `verified`, 0/0 plans) |
| 132 | 2 | `673c3e6c-3645-493a-a776-274b6ade3391` (about Jimmy, `pending`, 0/0 plans); `0fe2f459-2b6f-45cb-a575-f097f5c6ad5d` (yoj bin, `pending`, 0/0 plans) |
| 133 | 2 | `5f8a62c2-28ad-497a-9945-4518735ad3cf` (libu lali, `pending`, 0/0 plans); `65df6e56-698c-41b3-958c-eca04f8f5936` (papa kaka, `pending`, 0/0 plans) |
| 134 | 2 | `987612a5-f3ef-40ff-97ab-335bd5f44fc3` (Wangajjo Muhammad, `pending`, 0/1 plans); `ad4797f3-b7fb-43d9-9c4b-7142af49b2c4` (Wangajjo Muhammad, `pending`, 0/0 plans) |
| 135 | 2 | `8765296e-c718-420c-aa21-b9b336df2665` (Nanteza Rose, `verified`, 0/1 plans); `54d90439-713e-438f-83e7-2f20193addd2` (NANTEZA ROSE, `verified`, 0/1 plans) |
| 136 | 2 | `d3bfc949-6b12-45c4-ada1-1456e1f6c5f0` (ratik kik, `pending`, 0/0 plans); `50414410-2a18-4613-ba53-3a135ee8864a` (yui ush, `pending`, 0/0 plans) |
| 137 | 2 | `a80d1426-0d66-435a-b682-f03ea948b1e7` (Namuyomba Orivia, `verified`, 1/1 plans); `cea8772e-7d06-47e5-86f5-af155f925adc` (Namuyomba oliver, `pending`, 0/0 plans) |
| 138 | 2 | `b71c10ee-acb6-459c-8eb4-036a978d8072` (Steven Kiguli, `verified`, 1/4 plans); `dc951b64-62bf-42d8-a556-05f3a7fb129a` (Muludini Kata, `pending`, 0/0 plans) |
| 139 | 2 | `91a3ff33-9d7d-42d7-91e5-32304de59820` (Calvin  gig, `rejected`, 0/0 plans); `c791f347-d958-40fc-9e33-b906d33263fa` (rai kai, `pending`, 0/0 plans) |
| 140 | 2 | `ca046aac-eb8b-4fd7-bb9f-d94b5a8aa70b` (hs sh, `pending`, 0/0 plans); `6da52e7d-e943-4b79-8359-5e191a5e998b` (vsb hsj, `pending`, 0/0 plans) |
| 141 | 2 | `cfcca51f-0e56-44d6-a58b-7c3f6d8d88e2` (digital hop, `pending`, 0/0 plans); `93760854-7cd6-4dfa-9297-95a14ea8bb5d` (wem zan, `pending`, 0/0 plans) |
| 142 | 2 | `ea2193ed-9916-4ed0-9608-4e3aab5bcfb6` (Agnes Namukwaya, `verified`, 0/1 plans); `6b187ff8-d23d-4f73-9528-32e89581dd0f` (namukwaya agnes, `verified`, 0/1 plans) |
| 143 | 2 | `65ae6910-ed36-4abf-bd85-cec13e54eac5` (dfg fyu, `pending`, 0/0 plans); `265012ff-06d4-4d67-a4f9-9d6e3c7cd63c` (fesk girl, `pending`, 0/0 plans) |
| 144 | 2 | `8fca6e5e-1476-483b-956f-6da2535ace8f` (NALUYOBYO WINNIE, `pending`, 0/1 plans); `aafbf504-f26f-4deb-96b5-4eea17e04e3e` (NALUYOBYO WINNIE, `verified`, 0/1 plans) |
| 145 | 2 | `0c725bd0-9097-4c12-be9f-e76f3a83a802` (hshgjzy, `rejected`, 0/0 plans); `9e8cadbe-96a3-434d-a91b-82d52ae87e9b` (jshghdoisjshfjs, `pending`, 0/0 plans) |
| 146 | 2 | `c35349f0-edf7-479c-a763-3f1b1132078e` (Jjunju Ismail, `pending`, 0/0 plans); `de381cfe-9f54-4870-b4d0-d17561d49112` (Jjunju Ismail, `verified`, 0/0 plans) |
| 147 | 2 | `5cc26a2a-4987-42b0-9ce0-af739816d3ee` (musawo, `verified`, 3/26 plans); `46097508-949f-4400-819f-3fbf8fa62cea` (Walusimbe Jonathan, `pending`, 0/0 plans) |
| 148 | 2 | `57858922-e1b8-49db-a224-9ac80a0ad26f` (dickson kanyarutookye, `verified`, 0/0 plans); `d7090df1-5966-4851-8b5a-baca531510ff` (nyalutokye Nickson, `verified`, 0/2 plans) |
| 149 | 2 | `aa62b7a1-e768-4e18-b012-2f65af902935` (Marian Atuhaise, `verified`, 1/3 plans); `bc36a07b-8681-4ca3-ab8a-aa00e8217e7b` (Atuhaise Mariam, `pending`, 0/0 plans) |
| 150 | 2 | `75134ae0-f4ae-48df-88ba-c73e16a4de6a` (mutebi abasi, `verified`, 5/8 plans); `1d436b89-0737-4ae3-bb50-de1fe5b5e7e3` (Mutebi Abass, `verified`, 2/5 plans) |
| 151 | 2 | `039d1331-5558-41c2-bfa2-090e3ae0cbb5` (gah kan, `pending`, 0/0 plans); `fe3fcb96-1e7f-4bec-b08f-27ac802de3ba` (hau isi, `pending`, 0/0 plans) |
| 152 | 2 | `b3ae2401-2f49-4649-b2df-ad52af82d5ba` (nam mio, `pending`, 0/0 plans); `5ac34d25-6920-4cbf-9515-7a2dd0602e43` (no man, `pending`, 0/0 plans) |
| 153 | 2 | `ff25d142-2e70-4575-8cd0-357b6889efe1` (Nakigozi Ratifah, `verified`, 1/1 plans); `3294f767-4770-4b48-9b3b-0f0c370e1d17` (Namubiru Fazirah, `pending`, 0/0 plans) |
| 154 | 2 | `6247eb35-b54b-45b9-8c91-7894486e01cb` (jon nihi, `pending`, 0/0 plans); `e5d1564f-20f3-4c64-b02e-71fa15354a5a` (vase gir, `pending`, 0/0 plans) |
| 155 | 2 | `cc2f46ec-f4b9-4013-a130-48e5d0303174` (Kyatelekela Kalema john wiliam, `pending`, 0/0 plans); `5ba3c009-5047-448b-92e5-99c21fe7b6e2` (KYATELEKERA KALEMA, `pending`, 0/1 plans) |
| 156 | 2 | `1b6145fc-1424-44ae-bd63-0d93db4bb881` (Bakashaba Alex, `pending`, 0/0 plans); `27cb5e7d-d0e7-4c60-89b8-da2513597028` (Dumba aloysius, `pending`, 0/0 plans) |
| 157 | 2 | `e9f0ef32-6bbe-4d4e-8a0c-ab07b847164f` (den dent, `pending`, 0/0 plans); `a50a5ffd-fe20-4441-9ec0-fede460914cd` (ki lii, `pending`, 0/0 plans) |
| 158 | 2 | `335bacbb-0679-4091-89d9-563bdd58ece6` (Namugga Suzan Justine, `verified`, 1/4 plans); `4f0ea3e3-33f4-431d-ab49-75cb0f5bb98c` (Namuga suzan, `verified`, 0/1 plans) |
| 159 | 2 | `274334a2-db9a-4800-ab7c-c989e3c78daa` (gfs ge, `pending`, 0/0 plans); `47a365f2-8641-47f8-942d-64c030e6e69b` (hee ge, `pending`, 0/0 plans) |
| 160 | 2 | `f91c0219-a4e5-4cf1-87f8-44aa9653c761` (nakito sara, `verified`, 0/3 plans); `f11c8805-edb4-433b-9a21-dffb58663a92` (Nakito sara, `verified`, 0/0 plans) |
| 161 | 2 | `87dab77b-041c-497c-bb1a-4438f455a47b` (has dre, `pending`, 0/0 plans); `edfcc0f1-15a7-470e-a19b-e76abd9bfd90` (nia jaia, `pending`, 0/0 plans) |
| 162 | 2 | `234ab95f-7c22-41db-89a0-758eedcadeb9` (Faison haha, `pending`, 0/0 plans); `c48909da-6ba2-4539-8a2a-821988d86a0b` (kawe wee, `pending`, 0/0 plans) |
| 163 | 2 | `f8064c40-9388-4c9e-845d-1053fd7fe5ba` (Hasifa Nakato, `verified`, 0/1 plans); `40a25821-6ad8-4156-9070-bb0f5b2b70d5` (NAKATO HASIFA, `pending`, 0/0 plans) |
| 164 | 2 | `1be63fa1-5795-4760-933a-ea8b45c31bd8` (jun ju, `pending`, 0/0 plans); `c11e6f97-af38-4c16-9c76-36e29cd910ab` (koi kiof., `pending`, 0/0 plans) |
| 165 | 2 | `91e48a97-cf12-4b13-b04e-bfcd39a26396` (Mugambwa Makiceal, `verified`, 1/2 plans); `48475036-0163-443e-ab5d-cf0a994ec272` (Teyebwa Abert, `pending`, 0/0 plans) |
| 166 | 2 | `c7e95274-6e5f-4f75-be90-3bb7782bf411` (Hassan Waisswa, `verified`, 1/1 plans); `9609f7fa-2918-4fd9-a646-e91eb5c283cb` (NAMBI JULIET, `verified`, 0/2 plans) |
| 167 | 2 | `c4a115ae-f77c-4d81-b386-712fe25a1719` (Namulinda merab, `verified`, 1/1 plans); `af98d788-a4ff-4089-889b-83dcb3a4617e` (Namulinda Mirab, `verified`, 0/0 plans) |
| 168 | 2 | `1a1f864a-39a4-461a-8035-cf2c7a170b34` (robert ahimbisibwe, `verified`, 2/2 plans); `2ddf9e72-2dc2-49b5-8b6a-1701e74ecddd` (Robert Ahimbisibwe, `verified`, 1/7 plans) |
| 169 | 2 | `8b2dd32e-e409-48af-b488-475de84038a5` (seryui tesw, `pending`, 0/0 plans); `96b105f0-ad0d-45f9-bc8b-0f9d3cbcf530` (wet cu, `pending`, 0/0 plans) |
| 170 | 2 | `7bdb6dda-d525-4b0f-91d6-6ab5b17826eb` (kalega henry, `verified`, 1/2 plans); `33dacaad-e50a-4b02-bd25-95f87846e3ff` (Henry kalega, `verified`, 0/0 plans) |
| 171 | 2 | `c3fdd75c-a7c3-4ced-a65a-95befd8c11b1` (John Bosco, `pending`, 0/0 plans); `5004047e-7561-4eaa-bb1e-051d6278adf1` (Kijambo Godfrey, `pending`, 0/0 plans) |
| 172 | 2 | `1141649b-cc67-4d94-b762-ae3547f86f06` (semakula meddy, `verified`, 0/2 plans); `7e1bcb63-100b-4e7a-ad4b-e9ffaa8d141b` (SSEMAKULA MEDDIE, `pending`, 0/1 plans) |
| 173 | 2 | `9a8d684d-62b7-46e0-91bb-33ffc586bbb7` (BROTHER ANDREW, `pending`, 0/0 plans); `fae0a217-1b14-4127-9f65-bdb961143037` (BROTHER RONNIE ANDREW, `pending`, 0/0 plans) |
| 174 | 2 | `505d69c3-3996-471f-b866-9c559a927920` (deam hisk, `pending`, 0/0 plans); `e457d42d-6736-4d58-a7af-af9c8265049c` (SI SRI, `pending`, 0/0 plans) |
| 175 | 2 | `4dab8212-a4a7-4dc0-a8f4-a99ecff87025` (Namarome sylivia, `verified`, 0/1 plans); `6d385564-85b0-4dbf-810c-54b7ab112ef5` (Namarome Sylvia, `rejected`, 0/0 plans) |
| 176 | 2 | `b460a11c-2779-4cf1-b02d-c35eb03f1708` (GIG bin, `rejected`, 0/0 plans); `d589fb2e-788e-41e9-afac-dd3002beb9f0` (Wer huj, `pending`, 0/0 plans) |
| 177 | 2 | `8fe1583d-0d5f-4d8e-b521-b45aac805abb` (Chan Chan lin, `pending`, 0/0 plans); `dd8e2231-bed8-4dbe-9ae9-b33267322d40` (pull hinge, `pending`, 0/0 plans) |
| 178 | 2 | `392c5c20-01cb-47b0-814a-0f50b114ec1c` (Mbajja Christiana, `verified`, 0/2 plans); `734d27f1-7ba5-4ae4-ad64-4614e4a6481a` (Mbajja Christiana, `verified`, 0/3 plans) |
| 179 | 2 | `719505d1-e1db-4d42-9dbd-8fa0b69342d6` (Namagembe Grolia, `pending`, 0/1 plans); `f4fd7c39-988d-4232-86b0-9e448f20995c` (Namagembe Grolia, `pending`, 0/0 plans) |
| 180 | 2 | `88a07f64-2f01-48bd-acd1-379374864aad` (bag dee see, `pending`, 0/0 plans); `08d186dd-d41f-4a6c-9e21-6dbeecaa9cb8` (mas sae, `pending`, 0/0 plans) |
| 181 | 2 | `4aa82fba-a003-4acf-8fb1-85bc163aaac1` (gumi kke, `pending`, 0/0 plans); `24f87d6b-9279-443e-bc95-2dc9d6e9dc4a` (your not, `pending`, 0/0 plans) |
| 182 | 2 | `512bb312-88fa-4718-ac12-66595b6b69f0` (Kato Simon, `verified`, 0/1 plans); `61512ee1-1663-40ff-a226-c355fd93ad45` (MUKASA SAMUEL, `pending`, 0/0 plans) |
| 183 | 2 | `9c7bc529-5922-4d0a-a6b2-9d590289629f` (Angella Namuyomba, `verified`, 1/1 plans); `f73c1ae2-fd46-4498-9788-c0a8a1965751` (Angella Namuyomba, `verified`, 0/2 plans) |
| 184 | 2 | `dea5633c-424e-48d2-9d98-e82b596ffd22` (Ganil lubugumu, `verified`, 1/1 plans); `d534a3d7-a23b-4173-b5d5-67cf901891d6` (Ganill lubugumu, `verified`, 0/0 plans) |
| 185 | 2 | `a65c86c4-b0eb-4d66-9c88-134ca542c945` (kakaba job, `verified`, 1/4 plans); `65e31965-40da-421d-aa38-8d1eef84344a` (kakaba Job, `pending`, 0/3 plans) |
| 186 | 2 | `31506797-9904-49d2-b42d-8ff44c22f279` (man jay, `pending`, 0/0 plans); `0272dfce-8a8e-44b7-b28f-92fb35e34006` (tye hhe, `pending`, 0/0 plans) |
| 187 | 2 | `f7a220ca-7f47-40d6-8c7d-8c34ddbc8190` (sove dea, `pending`, 0/0 plans); `5960ac62-5cfb-41c0-bd63-0c6962551282` (vent ssegawa, `pending`, 0/0 plans) |
| 188 | 2 | `105b89c7-ed4b-4d5b-90f8-5d07f7d1640e` (figer awen, `pending`, 0/0 plans); `1c914b54-216b-4433-974e-f14e079b5f6c` (yum diom, `pending`, 0/0 plans) |
| 189 | 2 | `e6128ea5-c8b7-4963-a2c2-74731748449a` (ssemanda john, `pending`, 0/0 plans); `b2acd5e6-e497-4cc2-a92b-7659b5a49405` (SSEMANDA JOHN, `pending`, 0/0 plans) |
| 190 | 2 | `b5ea1964-31a6-420e-81cd-a252240fe8f4` (Ibrahim, `rejected`, 0/0 plans); `2a4c6461-abe5-48c5-89bb-a492c87a5490` (Ibrahim, `verified`, 0/0 plans) |
| 191 | 2 | `11f21c1e-19ee-4399-b235-755c8b822ffc` (Namwajje Allen, `verified`, 0/1 plans); `cbfff791-f7a5-4419-b202-2bb11c4c79ac` (Namwajje Allen, `pending`, 0/0 plans) |
| 192 | 2 | `877fb500-1b1c-4f2a-8302-ff6ce930b842` (Byaruhanga Amos, `pending`, 0/0 plans); `efe92862-d514-4e93-a5c1-f4dfee1241ac` (Byaruhanga Amos, `pending`, 0/0 plans) |
| 193 | 2 | `740b567b-212d-46de-a951-56d34ffcbf81` (dot dex, `pending`, 0/0 plans); `acd4dd95-391f-4d12-8c53-4258f5f368fc` (zen zoe, `pending`, 0/0 plans) |
| 194 | 2 | `215748d4-4634-4e43-92a3-bc73bf9e24e5` (Arishaba Fabisi, `verified`, 1/1 plans); `adc69f3d-45a2-491a-a34c-dcd77652c6a8` (Arishaba Fabisi, `verified`, 1/1 plans) |
| 195 | 2 | `54f4dfb4-f4d5-4be9-b7ae-d275f124c5c8` (Namusoke Benadatte, `verified`, 1/2 plans); `3a15428b-4106-4d04-aca5-9a1e96444202` (Namesake Benna, `verified`, 0/1 plans) |
| 196 | 2 | `5bde1761-bb61-4177-8178-bb68a71fc216` (Edith, `pending`, 0/0 plans); `a85efa57-6006-4340-bad0-f42552ec9cce` (EDITH, `verified`, 0/2 plans) |
| 197 | 2 | `1e84ab56-7dec-462f-a37e-1c44fb7e0998` (jon jonz, `pending`, 0/0 plans); `ba41f7aa-866e-4a27-a596-55c932fb4bb4` (kiki kao, `pending`, 0/0 plans) |
| 198 | 2 | `548f7f08-0840-4094-a95a-292d483f12ba` (hug luv, `pending`, 0/0 plans); `bd2c4abd-22a9-4ebf-8571-afb70a3009d0` (vau haop, `pending`, 0/0 plans) |
| 199 | 2 | `0f2bd2d9-8bbc-474a-bb03-663017687737` (Nyawere Christine, `verified`, 1/1 plans); `992254c3-3671-4016-95c5-67c27ec94692` (Nyawere Christine, `pending`, 0/0 plans) |
| 200 | 2 | `c9506871-ed0a-41fe-bc3e-09f13da9515f` (han manus, `pending`, 0/0 plans); `f3e60da5-5e2e-44ae-aaa2-bb3d3a4f485f` (tai hah, `pending`, 0/0 plans) |
| 201 | 2 | `3a715fb3-6b09-4916-86ec-c3428d75e9c8` (shamila skil, `pending`, 0/0 plans); `601f1492-bacb-4d04-81b5-1bcc9ad82e9c` (yusust hjba, `pending`, 0/0 plans) |
| 202 | 2 | `871ab691-e02b-437c-8bf4-a21ac4728bce` (Glorious Haleluya, `verified`, 1/1 plans); `b9a5b285-c5b1-4018-8f36-2d9bec45f2de` (Glorious Haleluya, `pending`, 0/0 plans) |
| 203 | 2 | `7b294bac-8cab-4277-9be9-98a472e50502` (definitely fifteen, `pending`, 0/0 plans); `5361e001-afcf-4717-9a0c-c6f7cf2d40d7` (golf BBIAB, `pending`, 0/0 plans) |
| 204 | 2 | `e964de1c-e7b6-46d4-8417-f64d93b3ed2c` (high school, `pending`, 0/0 plans); `291d2574-1333-4be7-91d0-5c20791f941a` (vesevi syasg, `pending`, 0/0 plans) |
| 205 | 2 | `d2837593-a810-4260-aad7-01d67ef2f3fb` (fui fuis, `pending`, 0/0 plans); `d4d1fd99-fa79-414c-851c-3978174ef5dd` (Kaliso liso, `pending`, 0/0 plans) |
| 206 | 2 | `2e25af0d-862f-415f-a81b-1d864c6961fa` (Asiimwe Hope, `verified`, 1/2 plans); `4f8bd946-053a-47aa-acb3-4aac20c09d4b` (Asiimwe Hope, `verified`, 1/1 plans) |
| 207 | 2 | `38f5db10-e4f9-4c8f-a10e-0b158e1d9d94` (daninal tom, `pending`, 0/0 plans); `4ed061c5-e731-487e-92d2-f7cd3bf9f71e` (funny gine, `pending`, 0/0 plans) |
| 208 | 2 | `7dc38918-8385-4a79-8753-acab59210057` (buj naj, `pending`, 0/0 plans); `1d496b63-7d62-4fec-bee1-44ae65a0c409` (see rest, `pending`, 0/0 plans) |
| 209 | 2 | `0006dc3a-04ce-4cf0-a217-9aaa237796a8` (dafada Bab, `pending`, 0/0 plans); `22d45ee0-3834-4567-bab8-b24005f3d6cb` (vin bin, `pending`, 0/0 plans) |
| 210 | 2 | `18e72267-aefe-4d0c-91ec-3cb09ab7829f` (Don Adrew kagwa, `verified`, 1/1 plans); `acbf0959-1b5a-497d-aef8-0881c1e3e808` (kagwa    Andrew, `pending`, 0/0 plans) |
| 211 | 2 | `a760eba4-3c43-4680-81d9-8e9c2e5689ef` (eggs figured, `pending`, 0/0 plans); `caa6ceff-047a-4c8c-a1bc-0bb9012e9d91` (Eugene hiking, `pending`, 0/1 plans) |
| 212 | 2 | `c4fd751f-9aa5-476d-a796-7228bdce0051` (NANGWE BEINA, `verified`, 1/3 plans); `e65afb5c-a7ac-46c3-b169-43744d6614e5` (Sekandi Robert, `verified`, 1/4 plans) |
| 213 | 2 | `480cf9a9-5339-4398-ada6-76014951a8ed` (dinner Agnes, `pending`, 0/0 plans); `9fbcd156-1e50-42f7-a971-11da6b568b70` (tau yayj, `pending`, 0/0 plans) |
| 214 | 2 | `7d3f7d33-6189-42b5-a3ed-6bee28cf60fa` (MAKOHA SPECIOZA, `verified`, 1/2 plans); `9b1aff0d-a63c-490f-a912-0204652a7d66` (Makoha Specioza, `pending`, 0/0 plans) |
| 215 | 2 | `aeff5441-55bc-4559-a099-a289c015dda8` (ban lian, `pending`, 0/0 plans); `dc7b0bb7-3069-4185-990f-bb138039106b` (GANA UN hombre, `pending`, 0/0 plans) |
| 216 | 2 | `6e401e82-5821-46eb-b064-867cb91fee66` (jesica nabwire, `verified`, 0/0 plans); `99308780-7cf8-431b-a3d2-44a35dde3692` (Nasilumbi Daphine, `verified`, 0/2 plans) |
| 217 | 2 | `41c1fc20-96cc-437c-a198-60c5aa36bb55` (Nalubulwa Fairy, `pending`, 0/0 plans); `19ea0f00-9f00-40cb-8678-c4e82072b893` (wetui viue, `pending`, 0/0 plans) |
| 218 | 2 | `adbb3e18-be74-4fd9-b6e4-f30c0da8959e` (minister nabav, `pending`, 0/0 plans); `10964cb7-3c15-425f-8328-753f35d5ab74` (vsj bak, `pending`, 0/0 plans) |
| 219 | 2 | `e995a271-d4d8-4a26-b708-7caeb28e9d46` (Namaganda Sylivia, `verified`, 0/0 plans); `65d5113f-509b-4e00-bff5-a462842993f0` (Namaganda Sylivia, `verified`, 0/0 plans) |
| 220 | 2 | `2cd5c7c6-2f4a-4a07-877e-ce7a5c19cfa3` (asiimwe james Johnson , `verified`, 0/4 plans); `ce205ea2-57bc-4714-bd03-4a2bb56abf1e` (james Johnson  asiimwe, `verified`, 0/1 plans) |
| 221 | 2 | `a96f2acd-77f4-4183-99ba-cc9f99b4fc1a` (bus nwk, `pending`, 0/0 plans); `a2192de9-baa0-41f6-9d65-22f830bc513d` (kale dee, `pending`, 0/0 plans) |
| 222 | 2 | `044369e9-6ee9-496d-a1c0-63ca2f1a1390` (bie yuw, `pending`, 0/0 plans); `e81b270b-049a-495a-8624-831638c926c9` (keaho jaka, `pending`, 0/0 plans) |
| 223 | 2 | `b3087788-4f7d-49d7-ab32-3fc704c17757` (iis naj, `pending`, 0/0 plans); `d043a8c7-8485-4c76-a12f-1c3de7c81e34` (rera yuyy, `pending`, 0/0 plans) |
| 224 | 2 | `ee04bd0a-de43-474b-bc1e-a4447221b398` (NAGADIYA GRACE, `verified`, 1/2 plans); `74f264e9-b8b3-4b92-8565-ca2c7665a446` (NAGADYA GRACE, `pending`, 0/0 plans) |
| 225 | 2 | `cfc9fb6b-d874-4936-926c-de60cae06a00` (man ser, `pending`, 0/0 plans); `c10f959d-2222-4cee-a857-e3c4b3ea02c8` (Sendi Arafat, `pending`, 0/0 plans) |
| 226 | 2 | `26b9f01d-6f7b-4aed-9d11-34b47a762636` (kal oia, `pending`, 0/0 plans); `b507b245-cef7-41d6-afbb-fff80ec6da79` (plig pligda, `pending`, 0/0 plans) |
| 227 | 2 | `f30567ba-5c39-4b5d-a660-f0146bb6cfa8` (peter suuti, `pending`, 0/0 plans); `ab1fdbc4-d310-4e99-92a4-963fd04bbad1` (Peter suuti, `pending`, 0/0 plans) |
| 228 | 2 | `fcb7f9f2-f4f8-4b4c-9db3-c240ab7ad066` (good morning, `pending`, 0/0 plans); `4da17fbd-a03d-4cfd-af1e-717f49df392c` (mic heal, `pending`, 0/0 plans) |
| 229 | 2 | `a5eeb62c-1f75-4f58-a278-bdc645ee0645` (kalo kilo, `pending`, 0/0 plans); `9d77f845-13ad-4219-9881-c56db0bcee13` (ma ya, `pending`, 0/0 plans) |
| 230 | 2 | `594a6c49-92ba-4dad-a9dd-f2500cfdc3ef` (KATEREGA TIMOTHY, `verified`, 0/3 plans); `213592a6-13cf-4d1e-95b7-079d2e30a32a` (KATEREGA TIMOTHY, `pending`, 0/0 plans) |
| 231 | 2 | `4358c5e7-c194-4a46-883c-e205ebb0afad` (walyomu Michael, `pending`, 0/0 plans); `c8c892e6-7306-4f65-9448-b1d51cf1ad4b` (walyomu Michael, `pending`, 0/0 plans) |
| 232 | 2 | `07eb99e9-e79d-4408-a797-6a636c6a5fae` (dur durh, `pending`, 0/0 plans); `aafad47b-4554-4116-8fb1-702850de5bdd` (vfjeuwusyd hsudheh, `pending`, 0/0 plans) |
| 233 | 2 | `71e27d18-4a73-4a3b-84d2-764d561bcf70` (bau hau, `pending`, 0/0 plans); `860f60aa-6409-4e4d-a964-9a4f6973b534` (oew jaua, `pending`, 0/0 plans) |
| 234 | 2 | `1c4bb4e2-5daf-43b4-8df2-5a60df1e0c82` (Nakintu Angel, `verified`, 1/1 plans); `044132e1-3d4a-490a-a49c-a455b292f6c6` (Nakintu Angel, `pending`, 0/0 plans) |
| 235 | 2 | `4103efef-66dc-47a9-ba25-f93f76ecf98d` (xana ruio, `pending`, 0/0 plans); `9f0612f3-0a5e-4d93-a6c3-efd6e1c678db` (xian lu, `pending`, 0/0 plans) |
| 236 | 2 | `386a954b-4b90-47aa-a895-3ecccf2159d5` (Sabiti Lubega, `verified`, 0/1 plans); `da2f0e4e-ad12-40a9-8d0e-3fdcb6e2e292` (Sabiti Lubega, `verified`, 0/0 plans) |
| 237 | 2 | `e4e9563f-e41c-4cf2-b8a2-c2b1e02f1cec` (Mubiru traver Dassan, `pending`, 0/0 plans); `39e4b926-1dc0-48ed-8459-fa9161f4e4f6` (Mubiru traver Dassan, `pending`, 0/0 plans) |
| 238 | 2 | `815d2e84-9546-4482-ae5e-60c739adf5ef` (Ashiraf Namajenga, `pending`, 0/0 plans); `3e238869-4aac-4b6e-8948-ef06272547f2` (Steven gudoi, `pending`, 0/0 plans) |
| 239 | 2 | `e7aae1db-468d-4425-8cae-bfd382dd99a3` (Kaumaa Mwaiti, `verified`, 0/1 plans); `64bc23e8-d45d-44c5-bf9c-b63c014ce72a` (mama macc, `rejected`, 0/0 plans) |
| 240 | 2 | `b455ab63-f553-4793-987c-f340702b1df2` (Kikonko lbra, `pending`, 0/1 plans); `23ad80ed-3852-4a31-9aae-bc183e6ba924` (Muwonge Jab, `pending`, 0/0 plans) |
| 241 | 2 | `6c408e6c-49d5-4dd4-8d36-51ce4e7f3166` (tre heh, `pending`, 0/0 plans); `dce2f5b8-8362-4f85-a0a3-7d807ab88f12` (tya hahh, `pending`, 0/0 plans) |
| 242 | 2 | `e9b82048-d1fb-450f-bb62-199cd9f5c286` (fre ver, `pending`, 0/0 plans); `564812ec-8439-42e6-b4fb-cd2e2fe462e3` (nol poiy, `pending`, 0/0 plans) |
| 243 | 2 | `abc3f9cf-f0fb-4ed2-b482-cee6eb167d74` (nok jikiu, `pending`, 0/0 plans); `f26469ad-efca-4d0d-b38f-26641044afca` (suffice five, `pending`, 0/0 plans) |
| 244 | 2 | `119b2a71-0a2c-4e91-bed2-f5e5fe3ffdb7` (Namukisa Immaculate, `verified`, 0/2 plans); `0a8ef6de-8282-48c3-8ae5-26a02d8328cf` (Nandogo Lususu, `pending`, 0/0 plans) |
| 245 | 2 | `80bc645b-7ade-41e3-92cc-266dd814ba00` (yuio afs, `pending`, 0/0 plans); `254e13e7-5a30-48c8-9c33-8992c8181a70` (yuio afs, `pending`, 0/0 plans) |
| 246 | 2 | `3c6ca6a1-216e-42c3-8356-157c10fdb356` (Afande, `verified`, 0/0 plans); `6bb4f206-4d3b-41be-b628-ef09e36488f7` (Affade, `verified`, 0/1 plans) |
| 247 | 2 | `95d93410-c59a-49ee-a931-f00fefac6c35` (Onyango Sam, `verified`, 2/4 plans); `ef247a70-c102-4a43-a851-a399019c8e12` (nsubuga herbert, `verified`, 0/0 plans) |
| 248 | 2 | `dc935fb2-c66a-4f27-85ad-b646b0770d65` (Fredrick Orwenyi, `verified`, 2/2 plans); `90bb0bb1-8c4e-4dec-a3d5-bcc34baddf26` (Fredrick Olweny, `verified`, 0/1 plans) |
| 249 | 2 | `58a1e012-fe1d-451a-a1fd-64f526aa4ed6` (Baguma Hillary, `pending`, 0/1 plans); `5a9bd5fd-d7cc-4a7f-885f-03e632bb641b` (BAMUTURAKI EVELYN KABASINGURA, `pending`, 0/1 plans) |
| 250 | 2 | `e8efae59-4318-452f-bb23-f90f9e17895a` (nakuya teddy, `verified`, 1/1 plans); `5c60ae88-6ecf-4832-b1ff-382a69e7f409` (Nakuya Teddy, `pending`, 0/0 plans) |
| 251 | 2 | `c0c3f0e8-af2f-48fe-b038-7748d876032f` (mayanja Adilu, `pending`, 0/0 plans); `41882195-7df8-4770-a6c3-aef0c203a56b` (mayanja Adilu, `pending`, 0/0 plans) |
| 252 | 2 | `4b6b6c40-95c6-435b-a94b-943729bd1df7` (nalongo batamuriza, `verified`, 1/2 plans); `7daac75c-e059-48de-b7b8-ef3328a66897` (Nalongo Batamuriza Hadijjah, `verified`, 1/3 plans) |
| 253 | 2 | `4153d4c7-c1cd-47c7-bb80-c021cef34beb` (mukasa kaabunga, `verified`, 1/1 plans); `746bcb3b-c35b-46ed-ae53-ca23721f46d9` (NAMUKASA FRED, `pending`, 0/0 plans) |
| 254 | 2 | `f1e0f78c-6383-4615-86ac-bbc79db9f9b4` (Namere Babra, `verified`, 5/50 plans); `28b71bbe-4ec8-4732-a705-279ac78b8d92` (Nameere babra, `verified`, 0/5 plans) |
| 255 | 2 | `fc1bd48a-64da-4086-bd35-9990944a28b6` (kibuka sum, `verified`, 0/0 plans); `4f57fd28-7bec-4a0d-b135-5c7546244e8a` (Masiga Emma, `verified`, 0/1 plans) |
| 256 | 2 | `da89db3b-f1d1-4302-ae65-d901e1f51079` (ben you, `pending`, 0/0 plans); `f8383775-644c-42b9-8f84-a329aed1684e` (dah fah, `pending`, 0/0 plans) |
| 257 | 2 | `03da9bee-141e-4d4a-8515-dceb43a7f7d7` (Nadungo Rosemary, `pending`, 0/0 plans); `fcab88e8-f765-4769-9cf5-0a15dd8439f5` (nanduga rose mary, `pending`, 0/0 plans) |
| 258 | 2 | `60f19a85-fbdc-4672-b0be-7f25d9698019` (gure duer, `pending`, 0/0 plans); `02631627-7c7b-4889-85d5-4ea7fef4f77f` (sue surw, `pending`, 0/0 plans) |
| 259 | 2 | `51b9c769-f0de-451e-a0fa-4f83f4aa3496` (MUKIBI SHAKUR, `verified`, 1/1 plans); `b5860537-8695-4799-ad59-cd143b24d772` (MUKIBI SHAKULU, `pending`, 0/0 plans) |
| 260 | 2 | `dba832c6-bdbb-4688-99ec-e23c2bedc1a5` (kalyango leo, `pending`, 0/0 plans); `acac7ebe-1deb-475d-9461-7682e3116482` (KARYANGO LEO, `pending`, 0/0 plans) |
| 261 | 2 | `41b648a4-bc11-44cb-a9c3-81fbcb59f1cf` (Namuyomba Ruth, `verified`, 0/1 plans); `f96c000b-9180-437d-bba1-29a4fa02ed72` (Namuyomba Ruth, `pending`, 0/0 plans) |
| 262 | 2 | `57296d8a-a839-4b5d-a735-cf5d755e6fb7` (deee hev, `pending`, 0/0 plans); `f3ab065d-9cff-4b62-8a51-fbc0cbf0df9e` (eyr eyr, `pending`, 0/0 plans) |
| 263 | 2 | `b06de13f-fe90-4b66-a371-573521a50c2e` (cow mom, `pending`, 0/0 plans); `d385966d-132f-4c9e-a1e6-39286e2c22df` (koli mop, `pending`, 0/0 plans) |
| 264 | 2 | `36d96fb2-60bf-4672-910a-445b0cecc046` (guni tte, `pending`, 0/0 plans); `d0a78383-92a0-484e-a8b6-e31616f875db` (time the, `pending`, 0/0 plans) |
| 265 | 2 | `a808da70-a01e-43c1-b0e4-26478f58a8f0` (chef fly, `pending`, 0/0 plans); `2378f01b-1033-4ae3-a3f6-6f4bd2191cac` (xan you, `pending`, 0/0 plans) |
| 266 | 2 | `8d4e4e9a-5ee9-4ddf-a043-11eaa9227efc` (eggty vall, `pending`, 0/0 plans); `2a199867-1d9d-46a1-b05d-8f721b067c7a` (fatuh jvkey, `pending`, 0/0 plans) |
| 267 | 2 | `57aa17d3-0134-44ef-97a8-0e8d7cc5011b` (Rutuj jikole, `pending`, 0/0 plans); `3dfeb99d-b369-4fc6-bf79-1493c79efb27` (Tukilo yuji, `pending`, 0/0 plans) |
| 268 | 2 | `4d09bba7-589c-4868-8611-563da4be724d` (qerb kolim, `pending`, 0/0 plans); `da1cd6cd-ff14-4af7-8608-1be7e5fd31b3` (tinm lim, `pending`, 0/0 plans) |
| 269 | 2 | `0d59f3e8-9099-4c67-b302-a9fd19ff7051` (jah hhw, `pending`, 0/0 plans); `f18368a3-aa31-4692-a0fa-df840bf77f68` (yau hau, `pending`, 0/0 plans) |
| 270 | 2 | `fcd4d27d-17ad-4d7b-bd7a-6682fbc58c69` (fi fui, `pending`, 0/0 plans); `f72ea9a6-ba0b-4f9d-a3a5-246a6c925d85` (Ssembatya lorand, `pending`, 0/0 plans) |
| 271 | 2 | `daba9323-8a6d-46f3-bd6d-0d99fb2d3706` (hai sen, `pending`, 0/0 plans); `2a81fbe7-99d2-4812-b377-344eab0ef275` (ur jeiwh, `pending`, 0/0 plans) |
| 272 | 2 | `d3890854-da25-4317-9af6-2e5ff0dd4fbf` (freal mrue, `pending`, 0/0 plans); `922b5882-3d6d-4ec1-b4bd-1c9a1d0f2d1b` (red lobster, `pending`, 0/0 plans) |
| 273 | 2 | `978cc8c2-cd9a-4286-a3cc-200f4d362dfa` (wangira Micah , `verified`, 0/1 plans); `932e4e38-321a-4f04-a3cd-897942c75258` (Wangira Micha, `verified`, 0/0 plans) |
| 274 | 2 | `3c11202f-066a-44a6-a73a-a47c483f34b2` (Namuddu Amina, `verified`, 0/1 plans); `da495890-0ac3-40d5-af83-6aadc830c1e9` (Namuddu Amina, `pending`, 0/0 plans) |
| 275 | 2 | `1654b9c4-c4e4-4627-ac0a-650d5b7a64f8` (gau nooa, `pending`, 0/0 plans); `a33b16d9-20b4-4833-978e-639bdf00fa2a` (kaun nai, `pending`, 0/0 plans) |
| 276 | 2 | `48af9d1b-9119-4257-80e4-5048ab8445de` (niio yo, `pending`, 0/0 plans); `ed348d2c-b8bb-4230-aa8b-648b48c5bf6d` (zas eras, `pending`, 0/0 plans) |
| 277 | 2 | `5a27cabc-39e8-4993-b21f-b7d7f56c8b4a` (jaja wo, `pending`, 0/0 plans); `7b77e56d-41ec-42ed-ac19-31d14cff272c` (nandabi desite, `pending`, 0/0 plans) |
| 278 | 2 | `f58c5f6f-f0dd-4e76-878c-3398a6aaca9d` (KlYEMBA HAMIDU, `verified`, 1/1 plans); `e8ed7b67-1bcd-4b65-913f-0b191193e101` (KIYEMBA HAMIDU, `pending`, 0/0 plans) |
| 279 | 2 | `27026b48-1cf5-4996-ba58-2a200d937a97` (jane kakembo, `pending`, 0/0 plans); `bea09da2-e39c-49cb-9480-6e89c526ceda` (mann halk, `pending`, 0/0 plans) |
| 280 | 2 | `489c54e7-cb5b-4c97-903c-360b6f4f6f97` (Namukaya Hope, `pending`, 0/0 plans); `9693b9ce-ec32-4f9f-b910-16d37009d4aa` (Namukaya Hope, `pending`, 0/0 plans) |
| 281 | 2 | `105796fe-f745-40e8-b47c-de5efb42a007` (han mao, `pending`, 0/0 plans); `01abf7ea-7e25-4f97-8886-610bc3079cde` (tia ja, `pending`, 0/0 plans) |
| 282 | 2 | `66cc8caf-6d3e-452f-8bfa-a708209cb6d0` (pol ai, `pending`, 0/0 plans); `71c838b3-8c10-482d-8b62-755a1430b527` (tua hw, `pending`, 0/0 plans) |
| 283 | 2 | `21a11fd9-00fc-49d7-8b42-2a39fc31fc09` (Juma Okwoki, `verified`, 1/1 plans); `06384e2e-3234-47ee-8dbd-13b6a8722e82` (Juma Okwoki, `pending`, 0/0 plans) |
| 284 | 2 | `891ae969-816a-4443-920b-53b7670ecfe2` (hoi koi, `pending`, 0/0 plans); `23ca80e3-badb-4a73-8716-bdd797ac23ec` (tyi hau, `pending`, 0/0 plans) |
| 285 | 2 | `3347b080-446a-4d3a-be53-d6918e690a51` (maa maak, `pending`, 0/0 plans); `cd45c48c-6782-4ab5-912e-011035670caa` (tai oi, `pending`, 0/0 plans) |
| 286 | 2 | `85b50413-446e-4d57-82b4-d38b3bc6cf7a` (big ben, `pending`, 0/0 plans); `30ab26ac-49e5-4bbb-8c0b-192400b77064` (ha gw, `pending`, 0/0 plans) |
| 287 | 2 | `6b884c6c-2b94-444e-8d7e-e8331d334264` (Nakityo Rebecca, `verified`, 1/1 plans); `1ed3b604-26b4-4ad9-89a3-0e1523537ce7` (Nakityo Rebbecca, `verified`, 0/0 plans) |
| 288 | 2 | `9a15f894-62d2-465d-aecd-0ab01e72f3c2` (papa gaga, `pending`, 0/0 plans); `f2586518-edda-4a77-aea7-8369d97982c0` (sico nayi, `pending`, 0/0 plans) |
| 289 | 2 | `d848316c-d998-406d-b4d2-9daaa48d281f` (Lubogo Vicent, `pending`, 0/0 plans); `d2367d60-5faa-4b63-b8cf-967c9e943a25` (Nanyonjo Harimah, `pending`, 0/1 plans) |
