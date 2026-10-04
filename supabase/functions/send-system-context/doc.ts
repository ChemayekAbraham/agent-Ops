export const SYSTEM_CONTEXT_MD = `# SYSTEM_CONTEXT.md — Welile Platform Canonical Knowledge Base

**Status:** Production. **Base currency:** UGX (always shown with the ISO 4217 code, never \`USh\`/\`Shs\`/\`/=\`).
**Source:** live inspection of this codebase (routes in \`src/App.tsx\`, 279 Edge Functions under \`supabase/functions/\`, \`src/lib\` financial helpers, \`mem/\` business rules) and the live Postgres catalog.

Measured system size at time of writing:

| Object | Count |
|---|---|
| Base tables (\`public\`) | 423 |
| Views (\`public\`) | 22 |
| Materialized views | 3 (\`platform_stats\`, \`mv_ops_daily_summary\`, \`mv_house_location_rollup\`) |
| Functions / RPCs (\`public\`) | 1002 |
| Non-internal triggers | 382 |
| Enum types | 25 |
| RLS policies | 1141 |
| Edge Functions | 279 |
| pg_cron jobs | 98 (5 inactive) |
| Storage buckets | 21 |

> **How to read this.** Sections 1–3 are the mental model. Sections 4–7 are the financial core — read them before touching money code. Sections 8–11 are the object inventory. 12–18 are operational. 19 is the honest debt list. 21 is the glossary.

---

# 1. System Overview

## 1.1 Purpose

Welile is a Ugandan rental-finance platform. Tenants who cannot pay rent as a lump sum get a **Rent Plan**: Welile pays the landlord up front, the tenant repays daily over 7–120 days. Field **agents** originate, verify and collect. **Supporters** (retail funders/partners) supply capital and receive **Returns**. A ledger fortress guarantees every shilling is double-entry accounted.

Regulatory terminology is mandatory (BOU/CMA) in user-facing copy: *Rent Plan* (not loan), *Supporter* (not lender), *Returns* (not ROI).

## 1.2 Revenue and cost lines

| Line | Mechanic | Reference |
|---|---|---|
| Rent access fee | \`rent × (1.33^(days/30) − 1)\` | \`src/lib/rentCalculations.ts\`, \`compute_rent_repayment()\` |
| Registration fee | UGX 10,000 (rent ≤ 200k) else 20,000 | same |
| Agent advance access fee | 23% / 28% / 33% monthly compound | \`src/lib/agentAdvanceCalculations.ts\` |
| Business advance | staged approval, daily compounding | \`business_advances\`, \`process-business-advance-compounding\` |
| Merchant cash-out commission | 0.5% of settled principal | \`src/lib/cashoutCharges.ts\` |
| Welile Homes management fee | 10% of monthly rent (2% agent / 8% Welile) | \`mem/features/welile-homes/agent-collection-model.md\` |
| Angel Pool equity | 8% pool, UGX 20,000 per share | \`angel_pool_config\`, \`angel_pool_investments\` |

Costs: agent commission (10% of total repayment), verification/event bonuses, referral bonuses, payroll, telecom sending charges, Supporter Returns, write-offs.

## 1.3 Core products

1. **Rent Plans** — \`rent_requests\`, \`repayments\`, \`subscription_charges\`.
2. **Marketplace** — \`house_listings\`, \`listing_photos\`, public \`/find-a-house\`.
3. **Supporter portfolios** — \`investor_portfolios\`, \`supporter_roi_payments\`.
4. **Agent economy** — commissions, float, advances, merchandise, sub-agents.
5. **Merchant cash-out network** — agents front their own MoMo cash to settle withdrawals.
6. **Welile Homes** — full landlord rent management with guaranteed monthly payout.
7. **Business / credit advances** — working capital to tenants and businesses.
8. **Back office** — CEO/COO/CFO/CTO/CMO/CRM/HR/Ops dashboards, payroll, requisitions.

## 1.4 High-level architecture

\`\`\`mermaid
flowchart TD
  subgraph Client["Client — React 18 + Vite + TS PWA"]
    UI[Pages and components]
    RQ[React Query hooks]
  end
  subgraph Edge["Supabase Edge Functions (Deno) — 279"]
    EF[Orchestration, auth, third-party IO]
  end
  subgraph DB["Postgres (Lovable Cloud)"]
    RPC[SECURITY DEFINER RPCs]
    TRG[382 triggers]
    GL[(general_ledger)]
    VW[[v_user_wallet_strict]]
    CACHE[(wallets_physical)]
    CRON[pg_cron — 98 jobs]
  end
  UI --> RQ --> EF
  RQ -->|RLS-scoped reads and RPCs| RPC
  EF --> RPC
  RPC --> GL
  GL --> TRG --> CACHE
  GL --> VW
  CRON --> EF
  CRON --> RPC
\`\`\`

**Governing rule:** business logic lives in Postgres (RPC + trigger) or an Edge Function — never in the browser. The client renders and orchestrates only.

## 1.5 Technology stack

- **Frontend:** React 18, Vite 5, TypeScript 5, Tailwind v3, shadcn/ui, React Query, React Router, jsPDF; Vitest + Playwright for tests.
- **Backend:** Supabase — Postgres 15, PostgREST Data API, GoTrue auth, Storage, Edge Functions (Deno), \`pg_cron\`, \`pg_net\`.
- **Messaging:** Yoola SMS (primary), Africa's Talking, LANA (fallbacks); Mailgun US for email; Twilio WhatsApp; Web Push (VAPID).
- **AI:** Lovable AI Gateway (\`LOVABLE_API_KEY\`) — \`welile-ai-chat\`, analytics helpers.

## 1.6 Deployment

Static SPA served through the Lovable proxy (HTML \`no-cache\`). **No service worker, no version.json, no forced-update machinery** — deliberately removed (§19). Edge Functions deploy per function; \`supabase/config.toml\` marks which run with \`verify_jwt = false\` (public webhooks, cron targets, onboarding). Database changes ship only as migrations.

## 1.7 External integrations

| Integration | Purpose | Secret / entrypoint |
|---|---|---|
| Yoola SMS | OTP, alerts, broadcasts | \`YOOLA_SMS_API_KEY\`, \`_shared/yoolaPrimary.ts\` |
| Africa's Talking | SMS + USSD | \`AT_API_KEY\`, \`ussd-callback\` |
| LANA SMS | last-resort SMS | \`LANA_SMS_API_KEY\` |
| Mailgun (US) | all email via \`notify.welile.com\` | \`MAILGUN_API_KEY\`, \`MAILGUN_DOMAIN\` |
| Gmail API | MoMo receipt polling | \`GOOGLE_MAIL_API_KEY\`, \`gmail-poll-transactions\` |
| Google Drive | offsite document vault | \`GOOGLE_DRIVE_API_KEY\`, \`drive-archive\` |
| Search Console / SEMrush | SEO monitoring | \`GOOGLE_SEARCH_CONSOLE_API_KEY\`, \`SEMRUSH_API_KEY\` |
| Twilio | WhatsApp login links | \`TWILIO_*\` |
| Web Push | in-app notifications | \`VAPID_PUBLIC_KEY\` / \`VAPID_PRIVATE_KEY\` |
| Inngest | background SMS events | \`INNGEST_API_KEY\`, \`inngest\`, \`inngest-send-sms\` |
| Google Maps JS | in-browser routing/geocoding only | \`get_maps_browser_key()\` RPC (referrer-restricted) |

---

# 2. System Architecture — Subsystems

## 2.1 Authentication

- **Methods:** email+password; phone/OTP (\`sms-otp\`, \`otp-login\`, \`otp_verifications\`, \`otp_login_audit\`); Google OAuth; WhatsApp magic link (\`whatsapp-login-link\`); staff access codes (\`staff_access_passwords\`, \`/staff-portal\`).
- **Tables:** \`profiles\`, \`user_roles\`, \`signup_attempts\`, \`blocked_signup_ips\`, \`login_phase_events\`, \`user_device_sessions\`, \`oauth_funnel_events\`.
- **Triggers:** \`on_new_user_signup\` (profile + wallet provisioning), \`trg_normalize_validate_phone_insert/update\`, \`trg_prevent_duplicate_phone_*\`, \`enforce_profile_full_name_insert/update\` (≥2 real names), \`trg_enforce_signup_verification\`.
- **Edge Functions:** \`phone-signup\`, \`confirm-phone-account\`, \`diagnose-auth\`, \`recover-user-auth\`, \`password-reset-sms\`, \`admin-reset-password\`, \`free-credentials-for-resignup\`, \`auth-email-hook\`.
- **Rules:** max 3 login attempts before backoff; 1 signup per IP/device per 24h (\`signupGuard\`); fraud-blocked identifiers refuse signup.

## 2.2 Authorization

Roles live in \`user_roles\` (never on \`profiles\`), checked via SECURITY DEFINER \`has_role(uuid, app_role)\`. Dashboard access additionally requires a grant in \`staff_permissions\`.

- **Client:** \`RoleGuard allowedRoles={...} requiredPermission="..."\` in \`src/App.tsx\`; \`useStaffPermissions()\` — \`super_admin\` and \`cto\` bypass; \`ceo/coo/cfo/cto/cmo/crm/hr\` implicitly self-grant their own dashboard; lookups **fail closed**.
- **Server:** 1141 RLS policies plus helper predicates (\`is_ops_role\`, \`is_withdrawal_staff\`, \`is_business_advance_ops\`, \`can_view_agent_data\`).
- **Payroll is position-based**, not role-based: \`hr_pay_authorities\` + \`hr_pay_is_preparer/approver/releaser\`.

## 2.3 Wallet — full engine in §5

\`wallets\` is a **view** over \`wallets_physical\` + \`v_user_wallet_strict\`, writable through \`INSTEAD OF\` triggers. Three buckets. Sole writer \`apply_wallet_movement\`.

## 2.4 Ledger — §4

\`general_ledger\`: append-only, RPC-only writes, group-balanced, category-allowlisted.

## 2.5 Advances — §6

\`agent_advances\`, \`agent_advance_requests\`, \`agent_advance_ledger\`; \`business_advances\` (+ repayments, accruals, documents); \`credit_access_draws\`, \`credit_access_limits\`.

## 2.6 Returns engine — §7

\`investor_portfolios\`, \`supporter_roi_payments\`, \`roi_payout_schedules\`, \`portfolio_renewals\`, \`pending_wallet_operations\`.

## 2.7 Rent collection

- **Tables:** \`rent_requests\`, \`repayments\`, \`subscription_charges\`, \`subscription_charge_logs\`, \`agent_collections\`, \`field_collections\`, \`offline_collection_submissions\`, \`rent_repayment_pauses\`, \`tenant_idle_states\`.
- **Formula trigger:** \`trg_enforce_rent_request_formula\` overwrites all client-supplied fee fields with \`compute_rent_repayment()\` output.
- **Engines:** \`auto-charge-wallets\` (06:00 UTC), \`apply-rent-overdue-penalty\`, \`auto_close_fully_repaid_rents()\` (23:00).
- **Capacity gate:** \`tr_enforce_agent_daily_eligibility\` blocks a new request when an agent with active tenants collected < 20% of \`expected_daily\` (best of today/yesterday, Africa/Kampala day buckets, sourced strictly from \`agent_collections\`).
- **UI:** \`/record-rent\`, agent collection queue, \`/payment-schedule\`, \`/my-loans\`.

## 2.8 Properties

\`house_listings\` (56 cols), \`listing_photos\`, \`house_reviews\`, \`house_questions\`, \`saved_houses\`, \`property_viewings\`, \`mv_house_location_rollup\`, \`geo_coverage_cache\`. Guards: \`trg_enforce_daytime_house_listing\` (06:00–18:00 EAT for agents), \`trg_enforce_uganda_house_region\`, \`trg_enforce_listing_has_landlord\`, \`trg_enforce_property_chain\`. Bonus triggers: \`trg_pay_agent_house_verified_bonus\`, \`trg_pay_tenant_placement_bonus\`, \`trg_recruiter_override_house_verified\`.

## 2.9 Tenants

\`profiles\` (role \`tenant\`), \`rent_requests\`, \`tenant_ratings\`, \`tenant_replacements\`, \`tenant_transfers\`, \`tenant_balance_edits\`, \`tenant_phone_duplicate_alerts\`, \`welile_trust_score_cache\`. Ops surface: \`TenantOpsHub\` (Inbox / Segments / Search + behavior drawer); \`refresh-tenant-idle-states\` every 15 min.

## 2.10 Landlords

\`landlords\` (63 cols), \`landlord_payouts\`, \`landlord_account_ledger\`, \`landlord_verification_requests\`, \`landlord_physical_verifications\`, \`landlord_payout_otp_challenges\`, \`agent_landlord_float*\`, \`lc1_chairpersons\`. Payout requires landlord-phone OTP: \`issue-landlord-payout-otp\` → \`verify-landlord-payout-otp\` → \`landlord-payout-disburse\`, with SLA/abandonment monitoring.

## 2.11 Agents

~50 \`agent_*\` tables covering tiers (\`agent_tier\` enum), capabilities, float limits, collections, streaks, goals/missions, escalations, sub-agents, advances, merchandise, daily eligibility history. Key RPCs: \`agent_allocate_tenant_payment\`, \`get_agent_advance_potential\`, \`get_agent_ops_overview\`, \`get_agent_daily_eligibility\`, \`capture_trust_signal\`.

## 2.12 Merchant agents (cash-out network)

\`cashout_agents\`, \`cashout_claim_comments\`, \`merchant_agent_referrals\`, \`payout_codes\`, \`proxy_payout_settlements\`, \`settlement_reconciliation_ledger\`. A merchant claims a pending withdrawal, pays the user from their own MoMo, and is reimbursed principal → withdrawable plus 0.5% commission; the tiered telecom sending fee is debited from their float so Welile float matches their MoMo statement.

## 2.13 Supporters / partners

\`investor_portfolios\`, \`supporter_capital_ledger\`, \`supporter_invites\`, \`supporter_referrals\`, \`partner_agreements\`, \`portfolio_action_requests\`, \`angel_pool_*\`, \`promissory_notes\`, \`proxy_agent_assignments\`. Managed-proxy routing sends a partner's credits to their approved managed proxy agent's wallet.

## 2.14 Referrals, rewards, points

\`referrals\`, \`referral_rewards\`, \`referral_leaderboard\`, \`recruitment_campaign_*\`, \`campaign_attributions\`, \`agent_incentive_bonuses\`, \`recruiter_override_events\`, \`merchandise_*\`. Signup referral UGX 500; verification bonuses UGX 2,000 each (house listing, landlord, LC1 chairperson, recruiter override); tenant placement bounty UGX 5,000; rejection penalty UGX 2,000.

## 2.15 Notifications

SMS (\`sms_delivery_log\`, \`sms_opt_outs\`, \`sms_message_exceptions\`, \`sms_broadcast_*\`), email (\`email_send_log\`, \`email_send_state\`, \`suppressed_emails\`, \`email_unsubscribe_tokens\`), push (\`push_subscriptions\`, \`send-push-notification\`), in-app (\`notifications\` — writes deliberately suppressed by the lean-DB policy). Every outbound SMS passes the footer interceptor and opt-out check. **Sender ID \`WELILE\` is registered on all providers** and must be set explicitly on every outbound SMS call site.

## 2.16 Reporting

~20 scheduled report functions producing branded PDFs/emails: \`agent-ops-daily-report\`, \`agent-growth-daily-report\`, \`daily-cto-report\`, \`daily-cmo-users-report\`, \`daily-landlord-ops-report\`, \`daily-wallet-inflows-report\`, \`generate-daily-wallet-report\`, \`merchant-cashout-daily-report\`, \`generate-daily-merchant-commission\`. PDF builders live in \`src/lib/*Pdf.ts\`.

## 2.17 Fraud prevention

\`fraud_identity_blocks\`, \`signup_attempts\`, \`blocked_signup_ips\`, \`v_suspicious_duplicate_accounts\`, \`tenant_phone_duplicate_alerts\`, \`deposit_duplicate_detection\`, \`trg_enforce_tid_deposit_uniqueness\`, \`trg_enforce_no_fraud_wallet_earnings\`, \`enforce_no_fraud_withdrawal_request\`, \`fraud-cutoff-account\`. AML: **UGX 50,000/day withdrawal cap for accounts ≤ 30 days old**; user-to-user transfers need ≥7 deposits, and agents additionally need the 20% collection gate.

## 2.18 Risk / trust engine

\`welile_trust_score_cache\` (6 factors: payment, wallet, network, verification+GPS, behavior, landlord), \`user_risk_scores\`, \`kyc_profiles\`, \`kyc_risk_scores\`, \`kyc_flags\`, \`kyc_level_config\`. \`capture_trust_signal()\` is the mandatory write path; \`recalculate-trust-scores-nightly\` at 03:00. KYC upgrades are activity-driven (\`trg_kyc_upgrade_from_rent_request\`, \`trg_kyc_upgrade_from_house_listing\`).

## 2.19 Administration

\`/admin/dashboard\`, \`/admin/users\`, \`/admin/financial-ops\`, \`/admin/kyc\`, \`/admin/access-audit\`, \`/admin/archived-accounts\`, \`/admin/account-conflicts\`, \`/admin/referrals\`, \`/admin/recovery-sms-log\`, \`/admin/oauth-failures\`. Backed by \`audit_logs\` (mandatory ≥10-char reason), \`shadow_audit_logs\`, \`admin_purge_*\` RPCs, \`delete-user\`, \`restore-archived-account\`.

## 2.20 CFO operations

\`/cfo/dashboard\` plus \`/cfo/investor-report\`, \`/cfo/money-flow-trace\`, \`/cfo/ledger/:id\`, \`/cfo/phantom-drift/:userId\`. Tools: CFO Direct Credit/Debit (\`cfo-direct-credit\`), advance payment recording, credit-draw approval (\`cfo-approve-credit-draw\`), and reconciliation panels (phantom drift, anchored cache drift, withdrawable drift alerts, ledger group imbalances, duplicate ROI monitor, SMS verification monitor).

## 2.21 Executive dashboards

\`/ceo/dashboard\`, \`/coo/dashboard\`, \`/cmo/dashboard\`, \`/crm/dashboard\`, \`/cto/dashboard\`, \`/hr/dashboard\`, \`/operations\`, \`/executive-hub\`, \`/director/dashboard\`. Each is a single route rendering tabs by id via \`usePersistedActiveTab\`; menu items are centralized in \`src/components/layout/executiveSidebarConfig.ts\`.

## 2.22 Scheduled jobs

98 \`pg_cron\` jobs (§10). Two sub-minute workers: \`deposit-bridge-worker-30s\` and \`process-agent-capability-jobs\` (every 30 s). Families: financial engines, reconciliation detectors, reports, notifications, pruning, SEO.

---

# 3. Business Processes

## 3.1 User registration

Actors: prospect, optional referring agent. Preconditions: unblocked phone/email/IP.

1. \`/auth\`, \`/join\`, or agent-assisted \`register-tenant\` collects name, phone, email.
2. \`validateFullName\` requires ≥2 real names; \`normalize_ug_phone\` canonicalizes to +256; duplicate-phone triggers reject collisions.
3. \`signupGuard\` enforces 1 signup / IP / device / 24 h; the attempt is recorded in \`signup_attempts\`.
4. GoTrue creates the user → \`on_new_user_signup\` creates \`profiles\` + wallet + default role.
5. Attribution via \`campaign_attributions\` / \`referrals\`; \`credit_signup_referral_bonus\` posts UGX 500 to the referrer.
6. Phone verification OTP (\`sms-otp\`, reuse-on-resend semantics).

Failures: duplicate phone → conflict message; blocked identity → refusal + audit. Audit: \`system_events\` (\`tenant_created\`/\`agent_created\`), \`profile_field_audit\`.

## 3.2 Property listing

Agent inserts into \`house_listings\` inside the 06:00–18:00 EAT window, with a registered landlord, normalized Uganda region, geo point and photos. Ops verification fires \`trg_pay_agent_house_verified_bonus\` (UGX 2,000, legs \`listing_bonus\` / \`listing_bonus_expense\`) and \`trg_recruiter_override_house_verified\` (UGX 2,000 to the recruiter). Rejection writes \`agent_listing_rejections\` and recovers UGX 2,000 via \`listing_rejection_penalty\`.

## 3.3 Tenant registration and rent request

1. Agent captures tenant, landlord, LC1 chairperson, photo and GPS in one transactional RPC; an \`agent_visits\`/\`venue_visits\` trust signal is mandatory.
2. Insert into \`rent_requests\`. Gates: daily eligibility ≥ 20%, landlord registered (verification pending is queued with an explanatory message), tenant photo, duplicate check, agent capacity, formula overwrite.
3. Pipeline: \`pending\` → ops/COO approval (\`approve-rent-request\`) → CFO funding → \`funded\` → \`repaying\` → \`completed\`.
4. Disbursement ledger: wallet/float leg \`rent_disbursement\` out, landlord \`landlord_rent_payment\` in; receivable recognized via \`rent_receivable_created\`, revenue accrued daily by \`recognize-fee-revenue-daily\` into \`fee_revenue_ledger\`.
5. Agent commission: 10% of collected repayment (2% source / 8% manager; recruiter override 2% reduces manager to 6%).

Failures: \`DAILY_ELIGIBILITY_BLOCKED\`, formula drift (\`rent_request_formula_drift\`). Agent cancel path: status \`deleted_by_agent\`.

## 3.4 Wallet deposit

Channels (unified \`DepositFlow\`): MoMo USSD reference, cash receipt code (\`RCT\` prefix), bank transfer, in-app.

1. \`deposit_requests\` row with TID/reference; \`trg_enforce_tid_deposit_uniqueness\` blocks reuse.
2. Matching: \`gmail-poll-transactions\` (every 2 min) ingests MTN/Airtel receipt emails into \`gmail_transactions\`; \`auto_match_email_deposits\` / \`auto_create_deposits_from_gmail\` link them. **Cash-code deposits are never auto-credited** — the user must enter the code (\`cash-deposit-verify-code\`).
3. Approval: \`approve-deposit\` → \`create_ledger_transaction\`, category \`wallet_deposit\`; deposits default to the **float bucket**.
4. Outstanding advances are swept from the credited amount before it becomes withdrawable.
5. Unmatched after 24/48 h → \`auto_reject_unmatched_deposits\`; alerting via \`deposit_match_alerts\`, \`deposit_bridge_gap_alerts\`.

## 3.5 Wallet withdrawal

1. WithdrawFlow calls \`get_withdraw_context\`; available = \`get_user_available_balance\` (cache/commission/baseline may only reduce it).
2. Gates: KYC cap, AML UGX 50,000/day for accounts ≤ 30 days, minimum balance, fraud block, pending holds.
3. \`withdrawal_requests\` row + wallet hold. \`auto_dispatch_withdrawals\` / \`redispatch-withdrawals\` (every minute) route to merchants; \`notify-merchants-new-withdrawal\` alerts them.
4. Merchant claims (\`accept_withdrawal_dispatch\`), pays from own MoMo, uploads proof, confirms → \`approve-withdrawal\` posts \`wallet_withdrawal\` against the platform leg, reimburses merchant principal + 0.5% commission, debits the telecom fee from merchant float, writes \`proxy_payout_settlements\`, issues tokenized receipt \`/r/:token\`.
5. Failure paths: stale claims released every minute; \`reject-withdrawal\` returns the hold; \`enforce_withdrawal_ledger_match\` blocks mismatched postings.

## 3.6 Merchant cash-out settlement

As in 3.5 step 4. Reporting: \`merchant-cashout-daily-report\` (twice daily), \`generate-daily-merchant-commission\`; reconciliation in \`settlement_reconciliation_ledger\`.

## 3.7 Returns distribution

See §7.

## 3.8 Advance approval and recovery

See §6.

## 3.9 Customer / Returns recovery

\`apply_roi_advance_recovery\` nets an outstanding advance against Returns before payout. \`default_recovery_ledger\` and \`process-debt-recovery\` (inactive) handle written-down exposure; \`apply_layer_a_writedown\` books losses as \`platform_loss_writeoff\`.

## 3.10 System balance correction

CFO/super_admin only, reason ≥ 10 chars. Posts a **balanced pair** through \`create_ledger_transaction\`: wallet leg \`system_balance_correction\` + platform leg (\`phantom_writedown_clearing\` / \`balance_correction\`), classification \`admin_correction\`. Never \`UPDATE wallets\`.

## 3.11 Wallet reconciliation

\`reconcile_wallet_from_ledger\`, \`reseed_anchored_withdrawable\` (over-cache), \`reseed_anchored_balance\` (under-cache), \`admin_reseed_wallet_cache\`, \`repair-wallet-cache-drift-15m\`, \`reconcile-wallets-from-pivot\` (10 min), \`nightly-wallet-ledger-reconciliation\` (02:15).

## 3.12 Ledger reconciliation

\`detect_ledger_group_imbalances\` → \`ledger_group_imbalance_alerts\`; \`get_ledger_integrity_checks\`; \`ledger_balance_pivot\` is a verification layer only; \`voided_ledger_entries\` records reversals (rows are never deleted).

## 3.13 Supporter investment

Partner onboarding (\`/partner-onboarding\`, \`submit-portfolio-completion\`) → deposit verified → \`create-investor-portfolio\` / \`coo-create-portfolio\` → capital posted as \`supporter_capital\` / \`partner_funding\` → active → monthly Returns cycle. Mid-cycle top-ups park in \`pending_portfolio_topup\` and merge via \`merge-pending-topups\` / \`auto-apply-pending-topups\` (18:00 EAT). Capital withdrawal requires 90-day notice, which pauses Returns accrual.

## 3.14 Referral rewards and commissions

Link/QR → server-authoritative token → \`campaign_attributions\` → registration → activation event (verified house, funded rent) → bonus via \`credit_referral_bonus\` / \`credit_recruiter_override\` / \`credit_agent_event_bonus\`. Commissions accrue in \`commission_accrual_ledger\` and land in the agent's **withdrawable** bucket immediately.

## 3.15 Fraud investigation

Signal (duplicate phone/TID/device, drift alert, SMS verification failure) → ops review → \`fraud-cutoff-account\` freezes the account and writes \`fraud_identity_blocks\` → frozen agents see the full-screen legal banner (\`AgentFrozenGate\`) → earnings and withdrawals are trigger-blocked. Unblocks are audited in \`agent_eligibility_unblock_events\`.

## 3.16 Manual corrections and admin operations

All manual money movement funnels through CFO Direct Credit/Debit, \`finops-wallet-move\`, \`platform-expense-transfer\`, \`ops-bucket-transfer\`, \`admin-float-to-withdrawable\` / \`admin-withdrawable-to-float\`. Each requires a reason, writes \`audit_logs\`, and posts balanced legs. The legacy \`wallet-deduction\` function is retired (HTTP 410).

---

# 4. Financial Architecture

## 4.1 Principles

1. **\`general_ledger\` is the single source of truth** — append-only, double-entry, grouped.
2. **Wallets are a cache/mirror** — never authoritative, never directly updated.
3. **Every write goes through \`create_ledger_transaction\`** (\`trg_enforce_ledger_rpc_only\`, \`trg_guard_ledger_write\`).
4. **Every group balances**: \`sum(cash_in) = sum(cash_out)\` per \`transaction_group_id\` (\`trg_enforce_ledger_group_balance\`).
5. **Category must be allowlisted** (\`ledger_category_allowlist()\` — ~100 categories). Invented categories fail.
6. **Routing is by \`recipient_type\`**, not role: \`user\` → withdrawable, \`operational_wallet\` → float (\`trg_set_wallet_bucket_from_recipient_type\`, \`assert_routing_compatible\`).

## 4.2 Row anatomy

Key columns: \`transaction_group_id\`, \`user_id\`, \`category\`, \`cash_in\`, \`cash_out\`, \`ledger_scope\` (\`wallet\` | \`platform\` | \`bridge\`), \`wallet_bucket\`, \`recipient_type\`, \`classification\`, \`transaction_date\`, \`metadata\`, \`running_balance\`.

**Classifications:** \`production\`, \`legacy_real\` (pre-April-2026 real history), \`test_dev\`, \`admin_correction\`. \`trg_enforce_production_april_cutoff\` forces every row dated ≥ 2026-04-01 to \`production\` (only \`admin_correction\` stays distinct).

## 4.3 Double-entry patterns

| Movement | Wallet leg | Platform leg |
|---|---|---|
| Deposit | \`wallet_deposit\` cash_in (float) | \`deposit\` cash_out |
| Rent disbursement | \`rent_disbursement\` cash_out | \`landlord_rent_payment\` cash_in |
| Agent commission | \`agent_commission_earned\` cash_in (withdrawable) | \`agent_commission_payable\` cash_out |
| Withdrawal | \`wallet_withdrawal\` cash_out | \`proxy_partner_withdrawal\` cash_in |
| Advance issue | \`agent_advance_credit\` cash_in | agent-advance expense cash_out |
| Advance recovery | \`agent_repayment\` cash_out (withdrawable only) | \`agent_advance_repayment\` cash_in |
| Returns | \`roi_wallet_credit\` cash_in (always withdrawable) | \`roi_expense\` cash_out |
| Correction | \`system_balance_correction\` | \`phantom_writedown_clearing\` / \`balance_correction\` |

## 4.4 Account families

\`ledger_accounts\` + \`ledger_account_groups\` classify balances into assets (advance and rent receivables, float at agents), liabilities (user withdrawable, Returns payable, commission payable), equity (share capital, Angel Pool), revenue (\`fee_revenue_ledger\`, access/registration fees, cash-out commission) and expenses (\`expense_category\` enum: operations, marketing, R&D, salaries, agent advances, employee advances, general).

## 4.5 Guards on \`general_ledger\`

\`trg_enforce_ledger_rpc_only\`, \`trg_guard_ledger_write\`, \`trg_enforce_ledger_group_balance\`, \`trg_validate_ledger_category\`, \`trg_prevent_ledger_update\`, \`trg_prevent_ledger_delete\`, \`trg_enforce_production_april_cutoff\`, \`trg_enforce_correction_classification\`, \`trg_auto_ledger_scope\`, \`trg_set_wallet_bucket_from_recipient_type\`, \`trg_assert_wallet_routing\`, \`general_ledger_route_buckets\`, \`trg_sync_wallet_from_ledger\` (no-op, retained for compatibility), \`trg_ledger_pivot_apply\`, \`trg_ledger_running_balance\`, \`trg_wallet_projection_ledger\`, \`trg_wallet_projection_maturity\`, \`trg_enforce_no_negative_wallet_ledger\`, \`trg_enforce_no_fraud_wallet_earnings\`, \`trg_enforce_tid_deposit_uniqueness\`, \`trg_ensure_depositor_profile_on_credit\`, \`trg_enforce_managed_proxy_roi_routing\`, \`trg_block_legacy_wallet_deduction\`, \`trg_block_merchant_agent_auto_debit\`, \`trg_block_proxy_custody_writes\`, \`trg_block_retired_instant_house_reward\`, \`trg_apply_bonus_restriction\`, \`trg_recover_advance_arrears_on_earning\`, \`trg_notify_agent_commission_paid\`, \`trg_verify_advance_disbursement\`, \`trg_log_ledger_wallet_transfer\`, \`trg_general_ledger_supporter_capital\`.

---

# 5. Wallet Engine

## 5.1 Structure

\`\`\`mermaid
flowchart LR
  GL[(general_ledger)] --> PIVOT[[v_user_wallet_strict — THE PIVOT]]
  GL --> AWM[apply_wallet_movement — SOLE WRITER]
  AWM --> PHYS[(wallets_physical)]
  PIVOT --> WV[[wallets view]]
  PHYS --> WV
  WV --> OPS[Operator dashboards]
  PIVOT --> RPCV[get_user_wallet_view / get_user_available_balance]
  RPCV --> ENDUSER[End-user wallet UI]
\`\`\`

## 5.2 Buckets

| Bucket | Meaning | Withdrawable? |
|---|---|---|
| \`withdrawable_balance\` | the user's own money: commissions, Returns, released deposits | Yes |
| \`float_balance\` | company money in the agent's custody | Never |
| \`advance_balance\` | liability; auto-recovered from incoming earnings | N/A |

## 5.3 Strict withdrawable rule

\`\`\`
available = max(0, min(wallets.withdrawable_balance,
                       max(0, wallet_ledger_net_since_anchor))) − pending_holds
\`\`\`

Implemented by \`get_user_available_balance\` over \`v_user_wallet_strict\`. Caches, commission sums and baselines can only **reduce** the figure. The same function gates \`approve-withdrawal\`, \`useAgentBalances\`, hero/full-screen wallet cards and WithdrawFlow. The solvency check inside \`create_ledger_transaction\` must mirror it exactly, or credits become phantom.

## 5.4 End-user vs operator read boundary

- End-user surfaces: \`get_user_wallet_view()\` / \`v_user_wallet_strict\` only; any raw \`general_ledger\` read must chain \`.neq('classification','admin_correction').neq('category','system_balance_correction')\`.
- Operator dashboards (CFO, FinOps, CEO, COO, CTO, HR, Manager) may read the \`wallets\` cache. \`scripts/guard-frontend-ledger-writes.mjs\` enforces the boundary at build time.

## 5.5 Drift detection and repair

| Concern | Detector | Repair |
|---|---|---|
| Phantom (cache > ledger) | \`detect_phantom_wallet_drift\` (15 min) → \`phantom_wallet_drift\` | \`reseed_anchored_withdrawable\` |
| Under-cache | \`wallet_anchored_balance_drift_view\` | \`reseed_anchored_balance\` |
| Withdrawable drift | \`detect_withdrawable_drift_alerts\` (15 min) | CFO panel, \`reconcile_wallet_from_ledger\` |
| Projection drift | \`wallet-projection-drift\` (15 min) → \`wallet_projection_drift_alerts\` | reconcile |
| Unrouted movements | \`wallet_unrouted_movements\` | add a category route in \`apply_wallet_movement\` |
| Routing violations | \`wallet_routing_violations\` | fix \`recipient_type\` at source |
| Overdraw | \`wallet_overdraw_events\` | investigate |

## 5.6 Wallet jobs

\`reconcile-wallets-from-pivot\` (10 min), \`refresh-wallet-totals-cache\` (10 min), \`repair-wallet-cache-drift-15m\`, \`wallet-projection-drift\` (15 min), \`nightly-wallet-ledger-reconciliation\` (02:15), \`generate-daily-wallet-report\` + \`daily-wallet-inflows-report\` (21:00 UTC = 00:00 EAT), \`sweep-agent-advance-recovery\` (15 min).

## 5.7 Hard rules

1. Never \`UPDATE wallets\` — \`enforce_wallet_ledger_only\` blocks it unless the sanctioned path sets \`wallet.sync_authorized\`.
2. \`apply_wallet_movement\` is the only writer; \`sync_wallet_from_ledger\` is a permanent no-op.
3. Fix money problems with balanced ledger corrections, never cache patches.
4. A new earning category without a bucket route silently lands in \`wallet_unrouted_movements\`.

---

# 6. Advance Engine

Three distinct advance products share one recovery philosophy: **advances are recovered only from withdrawable money; float and custody funds are untouchable.**

## 6.1 Agent advances

- **Tables:** \`agent_advance_requests\` (33 cols), \`agent_advances\` (29 cols), \`agent_advance_ledger\`, \`agent_advance_topups\`, \`advance_fee_config\`, \`agent_advance_repayment\` views.
- **Eligibility:** computed by \`get_agent_advance_potential\` / \`evaluate_agent_advance_eligibility\` from recorded rent history, collection consistency and tier. **One active advance at a time** — \`trg_enforce_no_double_agent_advance\`.
- **Fees:** 23% / 28% / 33% monthly compound depending on tier and CFO adjustment (\`src/lib/agentAdvanceCalculations.ts\`; \`advance_period_days\`).
- **Approval chain:** agent request → Agent Ops → (optional **Skip CFO** disbursement by Agent Ops) → CFO → disbursement. CFO may edit the amount and the fee band before approving.
- **Disbursement:** \`agent_advance_credit\` into withdrawable; \`trg_verify_advance_disbursement\` reconciles the ledger against the advance row.
- **Recovery:**
  - \`sweep_agent_advance_recovery()\` every 15 min — for agents with \`status in ('active','overdue')\` and \`outstanding_balance > 0\`, reads strict withdrawable and sweeps FIFO (oldest \`issued_at\` first) via \`create_ledger_transaction\` with \`metadata.source='auto_withdrawable_sweep'\`, \`interest_accrued = 0\`. Agents with prepaid installments are skipped.
  - \`process-agent-advance-deductions\` daily at 18:00 EAT applies the scheduled installment and interest. **Missing a day does not increase the outstanding**; it is recorded as arrears.
  - \`trg_recover_advance_arrears_on_earning\` claws arrears back from the next earning.
  - Voluntary prepayment is supported and shifts the schedule.
- **Notifications:** SMS on deduction and on missed installment (\`send-advance-payment-reminder\`).
- **Monitoring:** \`get_agent_advance_repayment_monitor\` RPC, Agent Ops repayment monitor panel, \`ActiveAdvancesPanel\`.

## 6.2 Business advances

\`business_advances\` (56 cols) with enum \`business_advance_status\`: \`pending\` → \`agent_ops_approved\` → \`tenant_ops_approved\` → \`landlord_ops_approved\` → \`coo_approved\` → \`cfo_disbursed\` → \`active\` → \`completed\` (or \`rejected\`/\`defaulted\`). Supporting tables: \`business_advance_daily_accruals\`, \`business_advance_repayments\`, \`business_advance_documents\`, \`business_advance_notification_log\`, \`business_advance_share_events\`. Limit is Welile-scored from recorded rent history (UGX 50,000 starter → 10,000,000 cap) via \`calculate_business_advance_limit\`, captured at request time. Daily compounding by \`process-business-advance-compounding\`.

## 6.3 Credit access draws

\`credit_access_limits\` and \`credit_access_draws\` (+ \`credit_draw_ledger\`, \`credit_request_details\`). Draws submit as \`pending_cfo\` — **never auto-credited**. The CFO edits and approves via \`cfo-approve-credit-draw\`, which disburses into withdrawable. Reconciliation alerts land in \`credit_limit_reconciliation_alerts\`.

## 6.4 Recovery isolation rules

1. Recovery reads \`get_user_available_balance\`, never \`wallets.balance\`.
2. Float and commission custody are never swept.
3. The 15-min sweep adds no interest (that would double-count the daily cron).
4. Recovery legs are \`agent_repayment\` (wallet, \`recipient_type='user'\`) against \`agent_advance_repayment\` (platform, \`operational_wallet\`).

---

# 7. ROI (Returns) Engine

## 7.1 Model

A Supporter contributes capital into an \`investor_portfolios\` row (37 cols). Returns accrue on a **monthly flat-rate cycle** against the contributed principal, and are paid into the Supporter's **withdrawable** bucket (Returns are always withdrawable by rule).

## 7.2 Tables

\`investor_portfolios\`, \`supporter_roi_payments\`, \`roi_payout_schedules\`, \`portfolio_renewals\`, \`pending_wallet_operations\`, \`supporter_capital_ledger\`, \`investment_withdrawal_requests\`, \`portfolio_action_requests\`, \`angel_pool_investments\`.

## 7.3 Cycle

\`\`\`mermaid
sequenceDiagram
  participant Cron as pg_cron 06:00 UTC
  participant Fn as process-supporter-roi
  participant GL as general_ledger
  participant W as Wallet (withdrawable)
  participant Mail as Mailgun
  Cron->>Fn: invoke
  Fn->>Fn: select portfolios whose cycle matured (idempotency key per cycle)
  Fn->>Fn: net outstanding advance (apply_roi_advance_recovery)
  Fn->>GL: roi_wallet_credit (user) + roi_expense (platform)
  GL->>W: apply_wallet_movement routes to withdrawable
  Fn->>Mail: Returns statement email
\`\`\`

Rules:
- **Idempotency per cycle** — \`mem/business-model/roi-cycle-idempotency.md\`; duplicates are caught by the duplicate ROI credit monitor.
- **\`roi_accrued\` must exist before payout** — accrual precedes cash.
- **Partial split** — a payout can be split between cash and principal reinvestment (\`roi_compounded\`).
- **Contributed principal excludes \`roi_compounded\`** in statements (\`getContributedPrincipal\`), including manual portfolio edits.
- **Managed-proxy routing** — if the partner has an active, approved \`is_managed_account\` proxy, credits route to the proxy agent's wallet and the proxy receives the \`proxy-managed-payout-notice\` template (\`trg_enforce_managed_proxy_roi_routing\`).
- **Renewal** — \`auto_renew_due_portfolios()\` and \`apply-scheduled-portfolio-renewals\`; mid-cycle top-ups park in \`pending_portfolio_topup\` until merged.
- **Withdrawal of capital** requires 90-day notice, which pauses accrual.

---

# 8. Database Documentation

## 8.1 Domain map

| Domain | Representative tables |
|---|---|
| Identity | \`profiles\`, \`user_roles\`, \`staff_profiles\`, \`staff_permissions\`, \`kyc_profiles\`, \`user_device_sessions\` |
| Ledger | \`general_ledger\`, \`ledger_accounts\`, \`ledger_account_groups\`, \`ledger_balance_pivot\`, \`voided_ledger_entries\` |
| Wallet | \`wallets\` (view), \`wallets_physical\`, \`wallet_fresh_start_anchors\`, \`wallet_holds\`, \`wallet_projections\`, drift tables |
| Rent | \`rent_requests\`, \`repayments\`, \`subscription_charges\`, \`rent_history_records\`, \`rent_repayment_pauses\` |
| Property | \`house_listings\`, \`listing_photos\`, \`house_reviews\`, \`house_questions\`, \`property_viewings\` |
| Agents | ~50 \`agent_*\` tables |
| Landlords | \`landlords\`, \`landlord_payouts\`, \`landlord_account_ledger\`, \`lc1_chairpersons\` |
| Supporters | \`investor_portfolios\`, \`supporter_roi_payments\`, \`partner_agreements\`, \`angel_pool_*\` |
| Advances | \`agent_advances*\`, \`business_advances*\`, \`credit_access_*\` |
| Deposits/withdrawals | \`deposit_requests\`, \`withdrawal_requests\`, \`gmail_transactions\`, \`proxy_payout_settlements\` |
| HR / payroll | \`hr_staff\`, \`hr_positions\`, \`hr_pay_*\` (20 tables), \`hr_tasks\`, \`employee_requisitions\` |
| Recruitment | \`recruitment_campaigns\`, \`campaign_attributions\`, \`job_applications\`, \`internship_applications\` |
| Trust/risk | \`welile_trust_score_cache\`, \`user_risk_scores\`, \`kyc_*\`, \`fraud_identity_blocks\` |
| Ops/audit | \`audit_logs\`, \`system_events\`, \`client_error_reports\`, \`backup_runs\`, \`daily_platform_stats\` |

## 8.2 Key views

\`v_user_wallet_strict\` (the pivot), \`wallets\`, \`v_agent_daily_eligibility\`, \`wallet_strict_drift_view\`, \`wallet_anchored_drift_view\`, \`wallet_anchored_balance_drift_view\`, \`v_suspicious_duplicate_accounts\`, \`v_platform_pnl\`, \`v_receivables_summary\`.

## 8.3 Enums (25)

\`app_role\`, \`agent_tier\`, \`business_advance_status\`, \`system_event_type\`, \`expense_category\`, \`deposit_purpose\`, \`collection_payment_method\`, \`flag_severity\`, \`ai_priority\`, \`ai_recommendation_status\`, \`automation_action_type\`, \`disciplinary_action_type\`, \`leave_type\`, \`hr_task_status\`, \`hr_task_priority\`, \`hr_task_event_type\`, \`hr_measurement_mode\`, \`recruitment_campaign_status\`, \`recruitment_link_status\`, \`recruitment_link_type\`, \`recruitment_registration_status\`, \`recruitment_source\`, \`campaign_attribution_status\`, \`solvency_bypass_reason\`, \`sub_agent_draft_status\`.

## 8.4 Trigger families (382 total)

1. **Ledger integrity** (§4.5).
2. **Wallet routing/projection** — bucket stamping, projection maintenance, overdraw capture.
3. **Bonus payment** — house/landlord/LC1 verification, tenant placement, recruiter override, sub-agent registration, campaign bonuses (all idempotent).
4. **Validation** — phone normalization/uniqueness, full-name validity, rent formula, daytime listing window, Uganda region, TID uniqueness, single active advance, daily eligibility.
5. **Audit** — \`trg_log_profile_field_changes\` → \`profile_field_audit\`; \`system_events\` emission; \`audit_logs\`.
6. **KYC/trust** — activity-driven level upgrades, trust factor increments.
7. **Blockers** — retired features (legacy wallet deduction, proxy custody writes, retired instant house reward, merchant auto-debit), fraud earning/withdrawal blocks.

## 8.5 RLS

Every public table has RLS enabled and explicit \`GRANT\`s (Data API grants are not implicit). Policies scope by \`auth.uid()\` for user data and by \`has_role\`/ops predicates for staff surfaces. Roles are never read from \`profiles\` — always from \`user_roles\` through the SECURITY DEFINER \`has_role\` to avoid recursive policy evaluation.

## 8.6 Migration conventions

\`CREATE TABLE\` → \`GRANT\` → \`ENABLE ROW LEVEL SECURITY\` → \`CREATE POLICY\`, in that order, in the same migration. Functions use \`SET search_path = public\`. Time-dependent rules use triggers, never CHECK constraints. \`ALTER DATABASE\` is forbidden.

---

# 9. APIs

## 9.1 Surfaces

1. **PostgREST Data API** — RLS-scoped table reads and RPC calls from the client via \`@/integrations/supabase/client\`.
2. **Edge Functions** — 279 Deno functions; the only path for third-party IO, service-role work and orchestration.
3. **Public REST v1** — \`docs/welile-api-v1.postman_collection.json\` for partner integrations.
4. **Webhooks** — \`momo-webhook\`, \`mailgun-webhook\`, \`ussd-callback\`, \`auth-email-hook\`.

## 9.2 Edge Function families (representative)

| Family | Functions |
|---|---|
| Money movement | \`create-ledger-transaction\`, \`cfo-direct-credit\`, \`finops-wallet-move\`, \`platform-expense-transfer\`, \`ops-bucket-transfer\`, \`admin-float-to-withdrawable\`, \`admin-withdrawable-to-float\` |
| Deposits | \`approve-deposit\`, \`reject-deposit\`, \`cash-deposit-verify-code\`, \`gmail-poll-transactions\`, \`deposit-bridge-worker\`, \`auto-reject-unmatched-deposits\` |
| Withdrawals | \`approve-withdrawal\`, \`reject-withdrawal\`, \`redispatch-withdrawals\`, \`notify-merchants-new-withdrawal\`, \`release-stale-claims\`, \`withdrawal-receipt\` |
| Rent | \`approve-rent-request\`, \`auto-charge-wallets\`, \`apply-rent-overdue-penalty\`, \`recognize-fee-revenue-daily\`, \`register-tenant\` |
| Advances | \`process-agent-advance-deductions\`, \`sweep-agent-advance-recovery\`, \`cfo-approve-credit-draw\`, \`process-business-advance-compounding\`, \`send-advance-payment-reminder\` |
| Returns | \`process-supporter-roi\`, \`create-investor-portfolio\`, \`coo-create-portfolio\`, \`merge-pending-topups\`, \`apply-scheduled-portfolio-renewals\` |
| Landlord | \`issue-landlord-payout-otp\`, \`verify-landlord-payout-otp\`, \`landlord-payout-disburse\`, \`landlord-monthly-payout\` |
| Messaging | \`send-sms\`, \`sms-otp\`, \`inngest-send-sms\`, \`send-email\`, \`send-push-notification\`, \`whatsapp-login-link\` |
| Reports | ~20 \`*-report\` / \`generate-*\` functions |
| Admin/security | \`delete-user\`, \`admin-reset-password\`, \`fraud-cutoff-account\`, \`restore-archived-account\`, \`diagnose-auth\` |
| AI/SEO | \`welile-ai-chat\`, \`seo-scan\`, \`search-console-sync\` |

## 9.3 Edge Function conventions

- Manually define \`corsHeaders\` — never import a cors package.
- Authenticate with \`adminClient.auth.getUser(token)\`, then check roles server-side.
- Pass \`entries\` to \`create_ledger_transaction\` as a **raw JSON array**, never \`JSON.stringify\`.
- Use only allowlisted ledger categories.
- Cron-invoked functions must be idempotent and listed in \`config.toml\` with \`verify_jwt = false\` if invoked by \`net.http_post\`.

## 9.4 Most-used RPCs

\`create_ledger_transaction\`, \`get_user_available_balance\`, \`get_user_wallet_view\`, \`apply_wallet_movement\`, \`agent_allocate_tenant_payment\`, \`capture_trust_signal\`, \`has_role\`, \`get_agent_ops_overview\`, \`get_agent_daily_eligibility\`, \`get_agent_advance_potential\`, \`compute_rent_repayment\`, \`reconcile_wallet_from_ledger\`, \`reseed_anchored_withdrawable\`, \`hr_pay_is_preparer/approver/releaser\`, \`get_maps_browser_key\`.

---

# 10. Scheduled Jobs

98 \`pg_cron\` jobs (93 active). All times UTC unless noted; EAT = UTC+3.

| Cadence | Jobs |
|---|---|
| 30 s | \`deposit-bridge-worker-30s\`, \`process-agent-capability-jobs\` |
| 1 min | \`redispatch-withdrawals\`, \`release-stale-claims\`, withdrawal dispatch sweep |
| 2 min | \`gmail-poll-transactions\` |
| 10 min | \`reconcile-wallets-from-pivot\`, \`refresh-wallet-totals-cache\` |
| 15 min | \`detect_phantom_wallet_drift\`, \`detect_withdrawable_drift_alerts\`, \`sweep-agent-advance-recovery\`, \`repair-wallet-cache-drift-15m\`, \`wallet-projection-drift\`, \`refresh-tenant-idle-states\`, \`detect_sms_verification_failures\`, \`detect_ledger_group_imbalances\` |
| Hourly | deposit match alerts, bridge gap alerts, campaign attribution expiry, email routing retries |
| Daily 02:15 | \`nightly-wallet-ledger-reconciliation\` |
| Daily 03:00 | \`recalculate-trust-scores-nightly\` |
| Daily 00:30 | \`snapshot-agent-daily-eligibility\` |
| Daily 06:00 | \`auto-charge-wallets\`, \`process-supporter-roi\`, \`recognize-fee-revenue-daily\` |
| Daily 18:00 EAT | \`process-agent-advance-deductions\`, \`auto-apply-pending-topups\` |
| Daily 21:00 (00:00 EAT) | \`generate-daily-wallet-report\`, \`daily-wallet-inflows-report\` |
| Daily (various) | \`agent-ops-daily-report\`, \`agent-growth-daily-report\`, \`daily-cto-report\`, \`daily-cmo-users-report\`, \`daily-landlord-ops-report\`, \`merchant-cashout-daily-report\` (x2), \`generate-daily-merchant-commission\` |
| Daily 23:00 | \`auto_close_fully_repaid_rents\` |
| Weekly / monthly | \`landlord-monthly-payout\`, \`apply-welile-homes-monthly-interest\`, \`apply-scheduled-portfolio-renewals\`, backup runs, log pruning (7-day retention), SEO scans |
| Inactive (5) | \`process-debt-recovery\` and four retired detectors |

**Convention:** jobs invoke Edge Functions with \`net.http_post\` including \`apikey\`; such SQL is inserted with the insert tool (never a migration) because it embeds project-specific URLs and keys.

---

# 11. Event Flow

## 11.1 \`system_events\`

Every state change emits a \`system_events\` row (75% event-based architecture target). The \`system_event_type\` enum currently has ~50 values (payments, tenant/agent/supporter lifecycle, funds in/out, rent pipeline transitions, risk/flag changes, role changes, listing lifecycle, deposit/withdrawal outcomes, ledger classification backfills, report events). \`system_events\` has a \`metadata\` column and **no \`payload\` column** — inserts using \`payload\` fail silently.

## 11.2 Trust signal flow

\`\`\`mermaid
flowchart LR
  ACT[User or agent action] --> SE[system_events]
  ACT --> CTS[capture_trust_signal]
  CTS --> TSC[(welile_trust_score_cache)]
  TSC --> LIMITS[Credit limits, vouch limits, KYC level]
  TSC --> UI[Trust AI ID card]
\`\`\`

Constitution: any user-facing action with observable behavior must emit a \`system_event\` **and** increment a trust factor. Agent-initiated workflows must additionally write \`agent_visits\` or \`venue_visits\` with geo + AI ID.

## 11.3 Background events

Inngest carries fire-and-forget SMS (\`app/payment.sms.requested\`). \`agent_capability_ops_jobs\` is a durable job queue with batches, dead letters and undo snapshots, drained every 30 s.

---

# 12. User Roles

\`app_role\` enum (25): \`tenant\`, \`agent\`, \`landlord\`, \`supporter\`, \`manager\`, \`ceo\`, \`coo\`, \`cfo\`, \`cto\`, \`cmo\`, \`crm\`, \`employee\`, \`operations\`, \`super_admin\`, \`hr\`, \`senior_agent\`, \`sub_agent\`, \`admin\`, \`tenant_ops\`, \`landlord_ops\`, \`agent_ops\`, \`financial_ops\`, \`partner_ops\`, \`access_admin\`.

| Role | Primary surface | Core powers |
|---|---|---|
| tenant | \`/dashboard\` | rent plan, wallet, marketplace |
| agent | \`/agent/dashboard\` | onboarding, collection, float, advances, listings |
| sub_agent / senior_agent | agent dashboard variants | scoped agent powers, recruiter overrides |
| landlord | \`/landlord/dashboard\` | properties, payouts, tenants |
| supporter | \`/supporter/dashboard\` | portfolio, Returns, top-ups, withdrawals |
| agent_ops | Agent Ops dashboard | capacity, eligibility, advance queue, skip-CFO disbursement |
| tenant_ops | \`TenantOpsHub\` | tenant inbox, segments, reassignment |
| landlord_ops | Landlord Ops dashboard | listing verification, landlord approval |
| partner_ops | Partner Ops | portfolios, top-ups, proxy assignments |
| financial_ops | \`/admin/financial-ops\` | outbound verification, payouts |
| cfo | \`/cfo/dashboard\` | inbound capital, approvals, corrections, reconciliation |
| coo | \`/coo/dashboard\` | rent pipeline, withdrawals, Returns approvals |
| ceo | \`/ceo/dashboard\` | executive KPIs, payroll approval (position-dependent) |
| cto | \`/cto/dashboard\` | infrastructure, freezes, SMS exceptions; permission bypass |
| cmo | \`/cmo/dashboard\` | campaigns, merchandise, growth reports |
| crm | \`/crm/dashboard\` | customer issues, tenant support |
| hr | \`/hr/dashboard\`, \`/hr/pay/*\` | staffing, payroll, requisitions |
| manager | manager surfaces | escalations, deletions on sensitive tables |
| operations / employee | \`/operations\` | day-to-day ops tasks |
| admin / access_admin / super_admin | \`/admin/*\` | user administration, access grants, full bypass |

Single-role focus: the UI renders for the **active** role; \`switchRole\` performs an atomic state transition in \`useAuth\`. Separation of powers: CFO handles inbound/strategic/approval, FinOps handles outbound/verification; payroll prepare/approve/release are three distinct positions.

---

# 13. UI Documentation

## 13.1 Routing

All routes are declared in \`src/App.tsx\` (700+ lines) with lazy imports and \`RoleGuard\`. Route groups:

- **Public** — \`/\`, \`/find-a-house\`, \`/house/:id\`, \`/opportunities\`, \`/careers\`, \`/terms\`, \`/privacy\`, agreements (\`/agent-agreement\`, \`/landlord-agreement\`, \`/merchant-agreement\`, \`/partners-terms\`, \`/angel-pool-agreement\`), tokenized links (\`/r/:token\`, \`/s/:code\`, \`/join\`, \`/c/:token\`, \`/share-location\`, \`/resume-sms\`, \`/stop-sms\`, \`/unsubscribe\`).
- **Auth** — \`/auth\`, \`/staff-portal\`, \`/login-diagnostics\`, \`/oauth-consent\`, \`/oauth-funnel\`.
- **Tenant** — \`/dashboard\`, \`/my-loans\`, \`/payment-schedule\`, \`/wallet\`, \`/wishlist\`, \`/chat\`.
- **Agent** — \`/agent/dashboard\`, \`/agent/cash-payouts\`, \`/record-rent\`, merchant onboarding/referrals.
- **Landlord / Supporter** — respective dashboards plus \`/reinvestment-history\`, \`/investor-portfolio/:id\`.
- **Executive** — \`/ceo|coo|cfo|cto|cmo|crm|hr/dashboard\`, \`/executive-hub\`, \`/operations\`, \`/director/dashboard\`.
- **Finance deep links** — \`/cfo/ledger/:id\`, \`/cfo/money-flow-trace\`, \`/cfo/phantom-drift/:userId\`, \`/audit-log\`.
- **HR payroll** — \`/hr/pay/runs\`, \`/hr/pay/runs/:runId\`, \`/hr/pay/enrollment\`, \`/hr/pay/compensation\`, \`/approvals\`.
- **E2E harnesses** — \`/__e2e/*\` (test only).

## 13.2 Dashboard pattern

Executive dashboards are single routes rendering tabs by id with \`usePersistedActiveTab('<role>')\`; the sidebar is data-driven from \`src/components/layout/executiveSidebarConfig.ts\` (label, icon, route or tab id, permission). Adding a screen = add a config entry + a \`switch\` case.

## 13.3 Key shared components

\`WithdrawFlow\`, \`DepositFlow\`, \`FullScreenWalletSheet\`, \`WalletTransactionTimeline\`, \`AgentFrozenGate\`, \`PhoneCollectionGate\`, \`NameCompletionGate\`, \`PriorityCollectionQueue\`, \`AvailableHousesSheet\`, \`PropertyMapView\` (client-side \`DirectionsService\` route optimization), \`UserDrilldownDrawer\`, \`ActiveAdvancesPanel\`, \`PhantomDriftPanel\`, \`AnchoredCacheDriftPanel\`.

## 13.4 UI conventions

- Semantic design tokens only — no hardcoded color utilities.
- UGX via \`formatUGX\`; never underscores in user-facing labels; no emojis.
- Regulatory wording (§1.1); platform fees are hidden from tenants (Rent / Daily Amount / Start only).
- Gates are layered by priority: frozen-agent banner > name completion > phone collection > profile completion.
- Offline: profile/UI data may be cached; financial data is network-first and never trusted offline.

---

# 14. Administration

- **User administration:** \`/admin/users\` (search, role grant, archive, restore), \`delete-user\`, \`admin_purge_user_dependencies\`, \`restore-archived-account\`, \`/admin/account-conflicts\` for duplicate resolution.
- **Access administration:** \`staff_permissions\` grants per dashboard; \`/admin/access-audit\` shows who has what; \`access_admin\` role manages grants.
- **KYC administration:** \`/admin/kyc\` — \`admin_set_kyc_level\`, \`admin_freeze_kyc_account\`, \`admin_resolve_kyc_flag\`, with \`kyc_level_change_audit\`.
- **Financial administration:** §2.20 and §3.16; every action requires a ≥10-char reason and writes \`audit_logs\` (\`action_type\`, \`table_name\`, \`record_id\`, \`reason\`).
- **HR administration:** \`hr_staff\`, \`hr_positions\`, \`hr_departments\`, \`hr_assignments\`; payroll runs (\`hr_pay_runs\`) move draft → calculated → in_review → approved → paid → locked with prepare/approve/release authorities held by **positions**; \`employee_requisitions\` and \`director_requisitions\` credit the requester's wallet on CFO approval (CFO may edit the amount).
- **Data export:** table/query CSV via \`psql COPY … TO STDOUT\`; full database export only through Cloud → Advanced settings → Export data. There is no self-serve import.

---

# 15. Security

1. **RLS everywhere** — 1141 policies; explicit GRANTs; roles never stored on \`profiles\`.
2. **Ledger fortress** — four layers: session flag, deny-by-default RLS, revoked table privileges, strict-mode triggers.
3. **Fail-closed permissions** — \`useStaffPermissions\` denies on error; server always re-checks.
4. **Secrets** — stored as Edge Function secrets, never in the repo or a committed \`.env\`; the service role key and DB password are inaccessible by design.
5. **Referrer-restricted Maps key** — served only via \`get_maps_browser_key()\` and usable only from browser Maps JS.
6. **Audit immutability** — \`audit_logs\` INSERT policies restrict forgery; ledger rows can never be updated or deleted (reversals only).
7. **AML/fraud** — UGX 50,000/day cap for accounts ≤ 30 days, deposit-count gate on transfers, IP/device signup throttling, identity blocks, TID uniqueness, mandatory receipt upload for manual withdrawals, OTP for landlord payouts.
8. **Session security** — Supporter inactivity lock after 5 minutes requiring password; device session tracking.
9. **Data deletion** — restricted to \`manager\` on sensitive tables via RLS; soft delete (\`enabled\` flag) preferred.
10. **Separation of duties** — CFO vs FinOps; payroll prepare/approve/release; ops approvals chained across departments.

---

# 16. Integrations

See §1.7 for the credential map. Operational notes:

- **SMS:** Yoola primary with Africa's Talking and LANA fallback; delivery logged to \`sms_delivery_log\`; exceptions in \`sms_message_exceptions\`; opt-outs honored globally; **never set a custom sender ID**.
- **Email:** Mailgun US on \`notify.welile.com\`; single route (all inbound replies land in one route); partner emails use From/Reply-To pairing; suppression list and unsubscribe tokens enforced before every send.
- **Gmail deposits:** poll every 2 min, dedupe (\`gmail_dedup_audit\`), exclusions (\`gmail_deposit_exclusions\`), outgoing transactions excluded, auto-credit gated by an explicit per-row checklist (\`autoCreditGateReport\`).
- **Drive vault:** documents archived offsite with \`drive_archive_log\`.
- **USSD:** Africa's Talking \`ussd-callback\` menu for balance and payment.
- **Maps:** browser-only; server-side Routes/Geocoding calls 403 with the referrer-restricted key.

---

# 17. Monitoring

- **Health:** \`infrastructure_settings\`, CTO infrastructure panel, benchmarks at 15/40/80/150 concurrent users, 800 ms DB latency warning threshold.
- **Financial monitors:** phantom drift, anchored cache drift, withdrawable drift alerts, ledger group imbalance alerts, duplicate ROI credit monitor, deposit match/bridge gap alerts, credit limit reconciliation alerts, CFO threshold alerts, bulk payout stuck alerts.
- **Operational monitors:** SMS verification failure monitor, agent advance repayment monitor, tenant phone duplicate panel (collapsed by default), change-of-address monitor, browser compatibility events.
- **Client errors:** \`client_error_reports\` + hardened crash reporter.
- **Reports:** daily executive emails per function (§10) plus \`daily_platform_stats\` and \`daily_wallet_reports\` snapshots.
- **Retention:** 7-day log retention under the lean-DB write-suppression policy; \`backup_runs\` records backups.

---

# 18. Deployment

- **Frontend:** Vite build → static assets behind the Lovable proxy; HTML served \`no-cache\`. Chunk load failures recover with a plain \`window.location.reload()\`. Canonical custom domain: \`welileapp.com\` (plus \`www.welileapp.com\`); legacy receipt domains redirect there.
- **Edge Functions:** deployed individually; JWT verification configured per function in \`supabase/config.toml\`.
- **Database:** migrations only; every new public table ships with GRANTs and RLS in the same migration; cron registration uses the insert tool, not migrations.
- **Environments:** dev and prod each hold their own secret set (100-secret cap per environment).
- **Build guards:** \`scripts/guard-frontend-ledger-writes.mjs\`, \`guard-deposit-purpose.mjs\`, \`guard-legacy-domain.mjs\`, \`guard-persona-routes.mjs\`, \`site-domains.mjs\`.
- **Tests:** Vitest unit/integration (\`src/__tests__\`, \`src/test\`), SQL regression tests (\`supabase/tests\`), Playwright E2E (\`e2e/\`) against \`/__e2e/*\` harnesses.

---

# 19. Known Technical Debt

1. **Table sprawl** — 423 tables with many single-purpose alert/audit tables; several near-duplicate agent float tables.
2. **Function sprawl** — 1002 RPCs; naming is inconsistent (\`get_*\`, \`admin_*\`, \`agent_*\`, bare verbs) and some are superseded but retained for compatibility.
3. **Retired-but-attached objects** — \`sync_wallet_from_ledger\` is a permanent no-op; several \`trg_block_*\` triggers exist only to fence off removed features; \`wallet-deduction\` returns 410.
4. **Classification legacy** — \`legacy_real\` / \`test_dev\` rows predate the April 2026 cutoff and complicate every historical query.
5. **\`system_events\` schema gap** — no \`payload\` column and an incomplete enum, so some historical event inserts silently no-oped (notably advance repayment events).
6. **Drift machinery** — seven distinct drift detectors and repair RPCs exist because the cache and the pivot can still diverge; the real fix is to read the pivot everywhere.
7. **Cron centralization** — 98 jobs, several overlapping in purpose; five inactive rows remain registered.
8. **Client-side route optimization** — forced by the referrer-restricted Maps key; server-side routing is unavailable.
9. **Offline collection** — \`offline_collection_submissions\` is a queue without a full conflict-resolution UI.
10. **Deliberately absent** — no service worker or client cache-recovery system; do not reintroduce (§1.6).
11. **Docs drift** — \`SYSTEM_ARCHITECTURE.md\`, \`welile_architecture_guide.md\` and \`backend\` predate parts of the current design; this file supersedes them.

---

# 20. Future Roadmap

Directionally, from current code and memory:

1. **Pivot-only reads** — remove every remaining cache read so drift detectors become redundant.
2. **Ledger classification cleanup** — retire \`legacy_real\`/\`test_dev\` behind an archive schema.
3. **Event completeness** — extend \`system_event_type\` and add a \`payload\`-equivalent structure so every subsystem emits reliably; push toward the 100% event-based target.
4. **Trust score as the universal gate** — drive credit, vouch, withdrawal and capacity limits from one score.
5. **Payroll to full production** — statutory filings, bank export formats, payslip distribution at scale.
6. **Merchant network expansion** — automated float forecasting and dispatch scoring.
7. **Welile Homes scale-up** — guaranteed landlord payouts as a standalone product line.
8. **40M-user readiness** — server-side aggregation everywhere, snapshot dashboards, further write suppression.

---

# 21. Glossary

| Term | Meaning |
|---|---|
| **Rent Plan** | The financing product (never call it a loan). |
| **Supporter** | A retail funder/partner supplying capital (never "lender"). |
| **Returns** | Payout to Supporters (never "ROI" in user-facing copy). |
| **Ledger fortress** | The four-layer guard system making \`general_ledger\` the only writable source of financial truth. |
| **Pivot** | \`v_user_wallet_strict\` — the canonical comparator between the \`wallets\` cache and \`general_ledger\`. |
| **Bucket** | One of \`withdrawable_balance\`, \`float_balance\`, \`advance_balance\`. |
| **Float** | Company money held in an agent's custody; never withdrawable. |
| **Strict withdrawable** | \`get_user_available_balance\` output; caches may only reduce it. |
| **Drift** | Divergence between the wallet cache and the pivot. Phantom = cache too high; hidden owed = cache too low. |
| **Anchor** | \`wallet_fresh_start_anchors\` cutoff from which strict ledger net is computed. |
| **Classification** | Ledger partition: \`production\`, \`legacy_real\`, \`test_dev\`, \`admin_correction\`. |
| **Transaction group** | Set of ledger legs sharing \`transaction_group_id\`; must balance. |
| **recipient_type** | Sole bucket router: \`user\` → withdrawable, \`operational_wallet\` → float. |
| **Daily eligibility** | Agent gate: ≥20% of \`expected_daily\` collected, sourced only from \`agent_collections\`. |
| **expected_daily** | Sum of \`daily_repayment\` across funded, still-owing tenants (\`v_agent_daily_eligibility\`). |
| **Advance** | Cash issued against future earnings; recovered only from withdrawable. |
| **Access fee** | The 23/28/33% monthly compound fee on an agent advance. |
| **Merchant agent** | Agent who fronts personal MoMo cash to settle user withdrawals for 0.5% commission. |
| **Proxy agent** | Agent authorized to transact on a partner's behalf; managed proxies receive the partner's credits. |
| **LC1 chairperson** | Local council chairperson who verifies tenant residence. |
| **TID** | Telecom transaction ID used to match a MoMo deposit. |
| **RCT** | Prefix for cash receipt codes. |
| **Welile AI ID** | The user's digital trust identity. |
| **Trust score** | 6-factor behavioral score in \`welile_trust_score_cache\`. |
| **Angel Pool** | 8% equity pool sold at UGX 20,000 per share. |
| **Vouch** | Welile guaranteeing a borrower up to their trust-score limit with a lender partner. |

---

*This document supersedes \`SYSTEM_ARCHITECTURE.md\`, \`welile_architecture_guide.md\` and \`backend\` where they conflict. When code and this document disagree, the code and the database catalog are authoritative — update this file in the same change.*
`;
