# Zoe Learning, Knowledge & Adoption Results (`2026-11-03`)

## 1. Summary

This report records the verification of Part D deliverables from [`docs/ZOE_CONSOLIDATED_REVIEW_AND_ONE_PROMPT.md`](../ZOE_CONSOLIDATED_REVIEW_AND_ONE_PROMPT.md):

1. **Teaching Loop (`staff_assistant_teaching_queue`)**:
   - Live table `public.staff_assistant_teaching_queue` and RPCs (`staff_assistant_enqueue_teaching_item`, `staff_assistant_department_teaching_queue`, `staff_assistant_teach_from_review_queue`, `staff_assistant_my_taught_updates`) verified live on database `43e6c2e1-18a6-4503-badb-5bb6c23491cc`.
   - Every unanswered or thumbs-down question routes by department (`Landlord Ops`, `Tenant Ops`, `Agent Ops`, `Partner Ops`, `Financial Ops`, `HR & People`, `CRM & Support`, `General Operations`).
   - Department lead approval (`staff_assistant_teach_from_review_queue`) writes a published entry to `public.staff_assistant_knowledge_base` with the lead's name, approval timestamp, and a **90-day review expiry** (`review_due_at = now() + interval '90 days'`).
   - When the person who asked opens Zoe, `staff_assistant_my_taught_updates` surfaces the banner `"Zoe learned this from <Department>"`.
2. **Knowledge Base to Working Size (`>= 200` Curated Entries)**:
   - Verified live on `public.staff_assistant_knowledge_base`: **205 published entries** (`is_active = true`, `review_status = 'published'`, `review_due_at` set to 90 days) covering Welile products (`Rent Plan`, `Supporter`, `Returns`, Welile Homes, Welile Schools, Welile Medicine), workspace processes, `"where do I find"`, accounting definitions (`A1 + A5` Treasury Cash Position vs `A2` Agent Float), and measurement gotchas (`expected vs collected` pinned 00:05 EAT bills).
   - Full-text search (`websearch_to_tsquery` + synonym expansion) and hit counting (`hit_count`, `last_hit_at`) verified live.
3. **Learning Log (`staff_assistant_learning_log`)**:
   - Verified in `zoeRealHandler.test.ts`: every non-temporary turn calls `recordLearningLogTurn`, recording the fixed topic enum, tool used, outcome (`answered`, `clarify`, `unanswered`, `refused`, `blocked`, `error`), `latency_ms`, `cost_usd`, and thumbs rating — with **zero duplicate copies of raw question text**.
   - Live authenticated run (`npm run eval:zoe:real`) to populate production rows from dedicated test staff accounts: **not run** in the local sandbox (requires owner test account credentials per [`docs/zoe/test-accounts.md`](./test-accounts.md)).
4. **30 Fast Answers (`ZOE_FAST_ANSWERS`)**:
   - Verified in `zoeConsolidatedCapabilities.test.ts` (`30 / 30` passing): deterministic, role-checked templates (`FA-01` through `FA-30`) format figures verbatim from official RPC payloads and pass `checkAnswer`.
5. **Show Up Where Staff Work (Consent-First Web Push, 10-Question Gallery, First-Time Tour)**:
   - Web Push preferences live in `public.staff_assistant_push_preferences` (`morning_brief_push = false`, `taught_updates_push = false`, `muted = false`, `daily_cap = 2`).
   - Soft in-app consent drawer (`zoe-push-consent-drawer`) asks which specific topics the staff member wants before requesting browser permission, capped at 2 pushes/day (`staff_assistant_can_send_push`), with a one-tap **Mute all push** switch.
   - Empty chat displays the `"What can Zoe do for my role?"` 10-question gallery (`getRoleGalleryQuestions`) and the dismissible first-time tour (`zoe-first-time-tour`).
   - No WhatsApp channel is exposed for Zoe.
6. **Real-Use Dashboard & Non-Causal Role Goals (`ZoeConversationsPanel.tsx`)**:
   - Live RPCs `public.staff_assistant_real_use_dashboard` and `public.staff_assistant_role_goals_and_measures` power the **Real-Use Dashboard** tab in CRM Zoe Review, reporting daily/weekly active staff, questions per role, answer/error/thumbs-up rates, median and 95th-percentile TTFB and total time, daily cost in USD, top unanswered themes, and role goal figures alongside Zoe adoption with the explicit non-causal disclaimer: *"Descriptive trend only — shows role goal figures alongside Zoe adoption for context, never a causal claim."*
