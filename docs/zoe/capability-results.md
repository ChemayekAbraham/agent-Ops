# Zoe Consolidated Capabilities & Security Defence Results (`2026-11-03`)

## 1. Summary

This report records the verification of Part C capabilities and Section 3 security defences from [`docs/ZOE_CONSOLIDATED_REVIEW_AND_ONE_PROMPT.md`](../ZOE_CONSOLIDATED_REVIEW_AND_ONE_PROMPT.md):

- **Automated Handler & Capability Suite (`src/lib/zoe/__tests__/zoeConsolidatedCapabilities.test.ts` + `src/lib/zoe/__tests__/zoeRealHandler.test.ts`)**: `24 / 24` test suites passing (`60 / 60` capability scenarios + `14 / 14` real handler regression and security tests).
- **Live End-to-End 60-Question Authenticated Evaluation (`npm run eval:zoe:real`)**: **not run** in the local sandbox environment because dedicated test staff account credentials (`ZOE_TEST_<ROLE>_EMAIL` / `ZOE_TEST_<ROLE>_PASSWORD`) are provisioned and held by the owner per [`docs/zoe/test-accounts.md`](./test-accounts.md). No simulated figures are reported as release proof.

---

## 2. Capability Verification Matrix (60 Scenarios)

| Capability Area | Scenarios Verified in `zoeConsolidatedCapabilities.test.ts` | Security Defence Verified | Automated Test Status | Live Authenticated Run (`eval:zoe:real`) |
| --- | --- | --- | --- | --- |
| **1. Fast Answers (`ZOE_FAST_ANSWERS`)** | `30` deterministic templates (`FA-01` through `FA-30`) across My Space, Tenant Ops, Landlord Ops, Agent Ops, Partner Ops, CFO/Financial Ops, Executive, HR/Calling Center, and Glossary | Role-gated via `canUseTool`; formats verbatim from official RPC payload with `Source:` citation | `30 / 30` passed | `not run` (requires owner test credentials) |
| **2. Files & Photos (`zoeFileParser.ts`)** | `6` scenarios: CSV table summary, clean PDF text extraction, PDF script rejection, PII warning banner, `<UNTRUSTED_FILE_ATTACHMENT>` wrapping, and `RequestSchema` validation | `10 MB` per file, max `5` per chat; strict archive/zip-bomb budget (`MAX_ZIP_DEPTH = 3`, `MAX_ZIP_ENTRIES = 60`, `MAX_UNCOMPRESSED_BYTES = 25 MB`, `MAX_COMPRESSION_RATIO = 40:1`, `MAX_EXTRACTION_TIME_MS = 2500 ms`); PDF `/JavaScript` & `/Launch` rejection; hidden text (`3 Tr`, `0 Tf`, `1 1 1 rg`) stripping | `6 / 6` passed | `not run` (requires owner test credentials) |
| **3. Voice & Languages (`useZoeVoice.ts`)** | `4` scenarios: Luganda written answers, Swahili written answers, one-time outside speech service disclosure prompt (`ZOE_VOICE_DISCLOSURE_NOTE`), and optional read-aloud (`off` by default) | Dictation goes into the input box for review before sending; browser speech recognition disclosure shown before mic access | `4 / 4` passed | `not run` (requires owner test credentials) |
| **4. Screen Context Awareness (`derivePageContextFromLocation`)** | `4` scenarios: Landlord Ops workspace route, CFO Dashboard route, sensitive query-parameter stripping (`token`, `code`, `secret`, `key`), and `page_context` schema validation | Passes only route name, visible non-sensitive filters, and period — never screen data; figures fetched via role-checked tools | `4 / 4` passed | `not run` (requires owner test credentials) |
| **5. Coaching on Own Work (`consultant.ts` + `tools.ts`)** | `4` scenarios: `"How am I doing this week?"`, `"What should I focus on today?"`, non-manager colleague comparison refusal, and mandatory advisory label | `assistant_staff_my_work_summary` scoped strictly to `(select auth.uid())`; `assistant_staff_team_work_summary` gated to managers; every coaching reply carries `"Advisory suggestion only — not a rating or HR decision"` | `4 / 4` passed | `not run` (requires owner test credentials) |
| **6. Analyst 22-View & Column Allow-List (`analyst.ts`)** | `4` scenarios: `zoe_ro.landlords_registry_by_district`, `zoe_ro.operations_rent_plans_by_stage`, `zoe_ro.finance_treasury_cash_position`, `zoe_ro.hr_contracts_overview`, plus disallowed view/table/column rejection | All `22` live `zoe_ro.*` views set `security_invoker = true`; explicit view & column allow-list (`ALLOWED_ZOE_RO_VIEWS`, `ALLOWED_ZOE_RO_COLUMNS_BY_VIEW`); `2 s` timeout, `500` row cap, `Ad hoc, not certified` badge | `4 / 4` passed | `not run` (requires owner test credentials) |
| **7. Drafting Mode & Private Projects (`ZoeDocumentDraftPanel.tsx`)** | `4` scenarios: internal memo template, SOP template, regulatory terminology sanitizer (`Rent Plan`, `Supporter`, `Returns`), and private `project_id` schema | Drafts exported locally as `.doc` or `.pdf` or copied to clipboard — nothing sent anywhere; `staff_assistant_projects` strictly private to `user_id = (select auth.uid())` | `4 / 4` passed | `not run` (requires owner test credentials) |
| **8. Role Gallery, Teaching Loop & Lethal-Trifecta Guard** | `4` scenarios: 10-question gallery per role, gallery terminology compliance, fast-answer terminology compliance, and untrusted attachment lethal-trifecta isolation | When a turn includes untrusted file or web content, outbound/draft tools (`draft_report_email`, `draft_reminder`, `draft_staff_notification`, `draft_report_schedule`, `draft_welile_idea`) and web fetches (`search_web`, `read_web_page`) are stripped | `4 / 4` passed | `not run` (requires owner test credentials) |

---

## 3. Section 3 Security Defences Verified

1. **Lethal-Trifecta Rule (`supabase/functions/staff-assistant/index.ts`)**:
   - Verified in `zoeRealHandler.test.ts` and `zoeConsolidatedCapabilities.test.ts`: no single assistant reply can read untrusted content (uploaded file or fetched web page), access Welile private data, and invoke an outbound/action channel in the same turn.
2. **Zip-Bomb & PDF Script / Hidden-Text Defence (`src/lib/zoe/zoeFileParser.ts`)**:
   - Verified rejection of nested `.zip` archives, directory depth `> 3`, entry count `> 60`, uncompressed size `> 25 MB`, compression ratio `> 40:1`, and extraction time `> 2,500 ms`.
   - Verified rejection of PDFs containing `/JavaScript` or `/Launch` and stripping of `3 Tr` (invisible text), `0 Tf` (zero font size), and `1 1 1 rg` (white-on-white text) before extraction.
3. **SSRF Private IP, Cloud Metadata & Redirect Defence (`supabase/functions/staff-assistant/consultant.ts`)**:
   - Verified `isPrivateOrReservedIp` and `validateConsultantWebUrl` block `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (including `169.254.169.254`), `100.64.0.0/10`, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6 (`::ffff:169.254.169.254`), non-HTTPS schemes, embedded URL credentials, and manual redirect hops (`max 3`).
4. **Private Upload Storage (`storage.objects` bucket `staff-assistant-uploads`)**:
   - Scoped to `(storage.foldername(name))[1] = (select auth.uid())::text` with `staff_assistant_has_access()` + `staff_mfa_gate_ok()`, 10 MB limit, and 90-day / chat-deletion cleanup (`staff_assistant_cleanup_expired_uploads`).
