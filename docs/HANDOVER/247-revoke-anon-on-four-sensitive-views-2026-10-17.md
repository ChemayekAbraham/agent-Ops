# 247. Anonymous access revoked on four sensitive views (2026-10-17)

**Found by:** Supabase advisor on the new project (own account): "Exposed Auth Users" for `v_accounts_no_verified_phone` and "Security Definer View" for `v_user_wallet_strict`, `v_merchant_float_position`, `v_lc1_verification_inbox`.

**Cause:** the views are owned by `postgres` with no `security_invoker`, so they read their tables with the owner's rights (row-level security does not apply), and the default grants gave `anon` (not signed in) and `authenticated` full access. 77 views in `public` have this setup; whether it pre-dates the move cannot be checked (old project disconnected), the grants were restored as dumped.

**Proof before the fix** (count-only requests to the public REST API with the site's public key, no data read): `v_accounts_no_verified_phone` 96,957 rows readable, `v_lc1_verification_inbox` 24,560 rows readable; the two wallet views were permitted but returned HTTP 500 (a failure, not a denial).

**Fix applied to production 2026-10-17:** `revoke all ... from anon` on the four views (migration `20261017100000_revoke_anon_on_sensitive_views.sql`). Verified: `has_table_privilege('anon', ...)` false for all privileges; the same API requests now return 401.

**Not done (decision needed):**
- `authenticated` can still read all four, meaning any signed-in user can read company-wide rows. Fix is either `security_invoker = true` plus a role check, or serving the staff dashboards (`MerchantFloatTruthPanel`, `Lc1VerificationInboxPanel`, `ManagerBankingLedger`, `MerchantFloatRequestsPanel`, `useLandlordOpsToday`, ...) through role-checked functions. `v_user_wallet_strict` is read by 7 edge functions (approve-withdrawal, approve-deposit, cfo-direct-credit, finops-wallet-move, admin float moves): money logic, test before changing.
- Audit the other 73 public views for personal or money data readable by `anon` (some may be public on purpose).
- Disclosed in the DPO reply as a gap if not closed before it is sent.
