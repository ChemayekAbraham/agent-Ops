# Zoe Rollout Plan & Adoption Playbook (`docs/zoe/rollout.md`)

## 1. Rollout Principles

1. **Read-Only by Design (The CEO's Rule)**:
   - Zoe never modifies Welile business records, wallets, ledger entries, or approvals.
   - Zoe writes only to its own `staff_assistant_*` tables (`staff_assistant_notes`, `staff_assistant_projects`, `staff_assistant_teaching_queue`, `staff_assistant_learning_log`, `staff_assistant_push_preferences`, `staff_assistant_feedback`, `staff_assistant_reminders`, `staff_assistant_report_schedules`, `staff_assistant_ideas`) and sends emails or notifications only after a human explicitly clicks confirm.
2. **No WhatsApp Channel for Zoe**:
   - A phone number does not prove staff identity or MFA (`aal2`) session state. Zoe runs exclusively inside authenticated Welile web/PWA sessions (`/me/zoe`, the My Space launcher, and workspace `"Ask Zoe about this screen"` buttons).
3. **Opt-In Notifications Only**:
   - Web Push notifications are **off by default**, preceded by a soft in-app topic selector (`07:30 Morning "What changed" brief` and `Answers to your taught questions`), capped at **2 per day** (`staff_assistant_can_send_push`), and equipped with an instant **Mute all push** switch.

---

## 2. Phased Rollout Schedule by Department

| Phase | Target Roles / Departments | Key Capabilities Introduced | Department Lead / Champion | Success Gate Before Next Phase |
| --- | --- | --- | --- | --- |
| **Phase 1 — Calling Center & Operations Pilot (Week 1)** | `landlord_ops`, `tenant_ops`, `agent_ops` (Calling Center & Pipeline teams) | - 30 Fast Answers (`FA-01` to `FA-30`)<br>- `"Ask Zoe about this screen"` on Landlord Ops, Tenant Ops, and Agent Ops<br>- Personal coaching (`"How am I doing this week?"`)<br>- Luganda & Swahili written replies | Landlord Ops Lead & Tenant Ops Lead | `0` raw errors on general questions; `>= 98%` exact-number match on `eval:zoe:real`; open teaching queue items reviewed within 48 hours |
| **Phase 2 — Partner Ops & CRM / Support (Week 2)** | `partner_ops`, `crm`, `hr` | - Department Teaching Queue (`ZoeConversationsPanel` → **Teaching Queue** tab)<br>- Drafting Mode for internal memos, SOPs, and partner summaries<br>- File/receipt upload comparison (`<= 10 MB`, max 5 per chat) | CRM Lead & HR Lead (Mark Bwayo) | Department leads approve initial taught answers (`90-day` review cycle); Real-Use Dashboard shows active weekly usage across all pilot roles |
| **Phase 3 — Financial Ops, CFO, COO & CEO (Week 3)** | `fin_ops`, `cfo`, `coo`, `ceo`, `super_admin` (`aal2` MFA enforced) | - Certified CFO tools (`Treasury Cash Position`, `Money In / Out`, `Receivables vs Payables`, `Revised Budget Position`)<br>- Analyst read-only `zoe_ro.*` ad-hoc SQL with `Show the data` & SQL transparency<br>- Private Projects (`staff_assistant_projects`) for monthly packs | CFO & COO | `0` role-boundary or MFA violations; `guard-zoe-parity.mjs --check-live` passes with `0` drift |

---

## 3. In-App Onboarding & Discoverability

1. **First-Time Tour (`zoe-first-time-tour`)**:
   - Shown once on an empty chat with a one-tap `"Got it"` dismiss button. Explains certified figures, receipt/spreadsheet uploads, Drafting Mode, voice dictation, and Zoe's read-only guarantee.
2. **Role Question Gallery (`"What can Zoe do for my role?"`)**:
   - Every staff role has 10 tailored, one-click example questions on the empty chat screen (`getRoleGalleryQuestions(roles)` in `src/components/zoe/zoeConfig.ts`), using mandatory Welile terminology (`Rent Plan`, `Supporter`, `Returns`).
3. **Contextual Workspace Entry (`AskZoeAboutScreenButton.tsx`)**:
   - Passes only `{ route, title, filters, period }` to Zoe — never screen DOM data — so Zoe answers using her own role-checked database tools.

---

## 4. Weekly Operations Rhythm

- **Daily**: Department leads check the **Teaching Queue** tab in CRM Zoe Review (`staff_assistant_department_teaching_queue`) and approve answers for unanswered or thumbs-down questions. Staff who asked see `"Zoe learned this from <Department>"` on their next visit.
- **Weekly**: CRM and Operations review the **Real-Use Dashboard** (`staff_assistant_real_use_dashboard`) for active staff, answer rate, error rate, p50/p95 TTFB and total latency, daily cost in USD, and top unanswered themes, and promote cleaned recurring questions into the regression suite via **Add to tests** (`staff_assistant_promote_to_eval_set`).
