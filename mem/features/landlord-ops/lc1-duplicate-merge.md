---
name: LC1 Chairperson Duplicate Merge & Phone-Uniqueness Guard
description: Admin UI + RPC to merge duplicate LC1 phone rows into one canonical record, plus a DB trigger blocking new duplicate-phone LC1 inserts
type: feature
---
Introduced 2026-06-16. Massive duplication existed in `lc1_chairpersons` (same phone re-inserted dozens of times across slightly different name spellings / phone formats). Root cause: every registration path created a fresh LC1 row instead of reusing.

## DB layer (migration)
- `public.normalize_phone(text)` IMMUTABLE: strips non-digits, converts 12-digit `256…`→`0…` and 9-digit→`0…`. THE canonical phone comparator for LC1 dedup.
- `public.v_lc1_phone_duplicates` (security_invoker=true) — lists every `lc1_chairpersons` row whose `normalize_phone(phone)` appears >1×, with per-row `rent_request_count`. Granted to `authenticated`; respects existing "Agents and ops can view lc1" SELECT RLS.
- `public.merge_lc1_duplicates(p_canonical_id uuid, p_duplicate_ids uuid[])` SECURITY DEFINER, **ops-only via `is_ops_role`** (manager/super_admin/coo/operations). Repoints `rent_requests.lc1_id`→canonical, deletes duplicate `lc1_verification_requests`, carries `verified` onto canonical if ANY row in the set is verified, deletes the duplicate `lc1_chairpersons` rows. Returns `{canonical_id, moved_rent_requests, deleted}`. Only FK refs to lc1 are `rent_requests` and `lc1_verification_requests` (house_listings stores LC1 as plain text, no FK).
- Trigger `trg_block_duplicate_lc1_phone` (BEFORE INSERT) raises `unique_violation` (SQLSTATE 23505) with message `LC1_DUPLICATE: … already exists` when an LC1 with the same `normalize_phone(phone)` already exists. This is the authoritative "LC already exists" rule.

## App layer (all LC1 insert paths now reuse-by-phone first)
- `Lc1DuplicatesPanel` (Landlord Ops dashboard, violet card below `Lc1VerificationRequestsPanel`): groups the view by normalized phone, default-keeps the verified→most-rent-requests→oldest row, radio-pick canonical, calls the merge RPC.
- Reuse-by-phone (prefer verified) before insert: `RentRequestForm`, `register-tenant` & `submit-tenant-form` edge fns (changed from dedup-by-village to dedup-by-phone), `RegisterPropertyDialog`, `LandlordAddTenantDialog` (treat 23505 as already-exists / safe-skip). `BulkImportLC1Dialog` now inserts row-by-row, skipping 23505 rows instead of aborting the whole batch.
- `AgentRentRequestDialog` lookups already prefer a verified row across duplicate phones (`.order('verified',{ascending:false}).` then take first) for both the live LC1 check and the submit-time hard gate.