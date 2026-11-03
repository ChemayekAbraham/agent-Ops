# Zoe: gap review against world-class assistants, and three prompts to close it

*31 October 2026. Plain-language review. Nothing in the app, code or database was changed. Zoe's code was read from the latest `origin/lovable` (tip `563165cf07`); Zoe's, Nexa's and Neexa's live tables were queried read-only. It follows `docs/ZOE_WORLD_CLASS_ASSISTANT_REPORT.md`, whose four prompts have now been built.*

---

## 1. The short version

The previous round fixed the plumbing. The database has caught up (18 Zoe tables, 66 read tools, the read-only Analyst views), the screen is cleaner, general questions are allowed, and a second-to-last bug list was worked through. That is real progress.

But Zoe is still not an assistant people use, and you are right to be unimpressed. Five reasons:

1. **Nobody is using it, and it still misbehaves the few times it is used.** Since 29 October, exactly **one person** (you) has asked Zoe **8 questions**. 3 ended in an error, 2 in the old "no verified dataset" refusal, 3 were answered. This morning you typed "good morn ing" and Zoe answered a *different*, earlier question ("receivables like a five-year-old") instead of greeting you. Compare Neexa (section 4): **176 customer conversations, 1,622 messages, 89 referred partners**, still busy at 07:36 today.
2. **The tests are still not real, so they cannot catch real problems.** The new 200-question release suite reports 203 of 203 passed and a "time to first word" of **10 milliseconds**. No real AI model answers in 10 ms. These numbers come from a simulator. The bug you saw this morning would never show up in it.
3. **Several "done" features are switched off or cannot work.**
   - **Web research is off.** The `web_research_enabled` switch is false, and no search key (`BRAVE_SEARCH_API_KEY`) exists in the project secrets, so turning it on would still not work.
   - **The Analyst lane** (any data question, read-only) has been used **0 times**.
   - **The learning log** has **0 rows**: Zoe is not learning from anything yet.
   - **The knowledge base** has **10 entries** and the glossary **10**. ChatGPT-like answers about "how Welile works" need hundreds.
   - **The scheduled-report runner** is not deployed.
   - **The model in use is not the one chosen.** Live replies record `google/gemini-3.8-flash`, while the settings say `gemini-2.5-flash` and `gemini-2.5-pro`.
4. **Zoe is still mostly a set of department reports with a chat box.** The world-class assistants (ChatGPT, Gemini, Copilot, Claude) can:
   - read a file or photo you give them;
   - listen to your voice;
   - search the web;
   - draft a document with you;
   - know which screen you are looking at;
   - coach you on your own work.

   Zoe can do none of these today. For staff records, Zoe answers only the questions its 66 fixed tools anticipated. There is no "how am I doing, and how can I do better?" and no manager view of a team's work.
5. **It is not where people already work.** Zoe lives on one page, `/me/zoe`, plus a floating button. Neexa works because it sits in WhatsApp, where customers already are.

**The fix is three prompts** (section 8):

1. **Make Zoe honest and reliable**: real tests, fix the bugs, turn on what was built.
2. **Make Zoe capable**: files, photos, voice, research, drafting, page awareness, and coaching on work delivery.
3. **Make Zoe learn and get used**: the teaching loop, proactive help, adoption, and measured success.

**Not touched, as instructed:** Nexa, Neexa, the agent assistant and every other AI in the system (section 5 lists the exact files and tables).

---

## 2. What I checked

| Check | What I found |
|---|---|
| Latest Zoe commits | Prompts 1 to 4 from the last report are built: parity guard, ChatGPT-style screen, general knowledge, true streaming, Brave search code, research mode, starters, memory, morning brief, knowledge base, a 200-question suite, governance doc. |
| Live database | 18 `staff_assistant_*` tables, 66 `assistant_staff_*` tools, 54 helper functions, the `zoe_ro` read-only schema. None of the previously missing functions is missing now. |
| Live settings | Zoe enabled, 50 questions a day, 3,200-token answers, temperature 0.2, cost cap USD 0.08 per question, fast model `gemini-2.5-flash`, deep model `gemini-2.5-pro`, **web research off**. |
| Live use | 16 messages since 29 Oct, 8 questions, **1 user**. Outcomes: 3 answered, 3 error, 2 blocked. The last question (31 Oct, 07:09) got an answer to an earlier question. |
| Learning and knowledge | Learning log 0 rows, notes 0, Analyst queries 0, feedback 1, knowledge base 10, glossary 10, data catalog 18 views. |
| Deployed functions | `staff-assistant` version 33, deployed 31 Oct 07:13 UTC (after your last question, so today's code has had **no real use yet**). `staff-assistant-schedule-runner` is **not deployed**. |
| Secrets (names only) | `LOVABLE_API_KEY` present. **No search key.** `NEEXA_API_KEY` and `NEEXA_WEBHOOK_SECRET` present (that is Neexa, section 4). |
| Evaluation | `docs/zoe/eval-results/release-200-2026-10-30.md`: 203/203, first word "10 ms". `docs/zoe/model-comparison-logs/` has request/response logs. They tested four models, none of which is the `gemini-3.8-flash` that live replies report. I could not confirm the logs came from real calls. |
| Migration numbering | **Two files share version `20261030100000`**: Zoe's `staff_assistant_parity_health_and_error_codes.sql` and my own Tenant Locations `tlb_tenants_multi_and_pdf_export_audit.sql`. The database's migration history lists only the Zoe name under that number. Both sets of objects exist live, but a rebuild from the folder would skip one. The earlier parity audit found four more such clashes for Zoe files. |
| Error codes | The new `error_code` column is empty on every logged failure; all of them predate the fix, and no failure has happened since. |

**Not verified:** I did not chat with Zoe myself. That needs a signed-in staff account, and I do not enter credentials. So today's deployed version (v33) is unobserved. The finding "it answers the wrong question" comes from your 07:09 conversation in the stored messages. The likely cause is that the history sent to the model includes an earlier question that never got a proper answer, but that is not proven.

---

## 3. What world-class assistants do that Zoe does not

General product knowledge of ChatGPT, Gemini (in Google Workspace), Microsoft 365 Copilot and Claude, plus the sources from the last two reviews. Where a claim is my own judgement, it says so.

| Ability | ChatGPT / Gemini / Copilot / Claude | Zoe today |
|---|---|---|
| **Answer anything** (general knowledge, explain, write, translate, maths) | Yes, the default | Allowed in the prompt; barely used; one wrong answer observed |
| **Read your files** (PDF, Excel, Word, screenshot, photo of a receipt) | Yes; upload, then ask | **No upload at all** |
| **Voice** (speak your question, hear the answer) | Yes | **No** |
| **Search the web with citations** | Yes; deep research mode takes minutes and cites sources | Code built, **switched off, no key** |
| **Draft long documents with you** (canvas or artifacts) | Yes, side-by-side editing, export | Short answers; file export only for report tables |
| **Know where you are** (Copilot and Gemini read the page or document you have open) | Yes | **No**; Zoe does not know which Welile screen you came from |
| **Your own work data, any question** | Copilot over your work graph; Genie and Cortex over company data | 66 fixed reports plus an Analyst lane nobody has used |
| **Coach you** ("how can I improve?") | Strong general coaching; grounded in your data when connected | **No** personal performance tool; no manager team view |
| **Projects** (pinned files and instructions for an ongoing piece of work) | Yes | **No** |
| **Memory that learns** | Yes, visible and deletable | Built; 0 notes saved |
| **Learns from the organisation** | Admins curate knowledge; feedback improves answers | Learning log empty; knowledge base 10 entries |
| **Meets people where they work** | Inside mail, docs, Teams, Slack, mobile apps | One page plus a floating button |
| **Honest measurement** | Real-traffic metrics, human review | Simulated suite |

---

## 4. What Nexa and Neexa teach us (studied, not touched)

The system has **three** customer-or-agent-facing AIs besides Zoe. I read them only.

**Nexa ("Welile Assistant", in the app at `/ai` and in the bottom bar):**
- Uses fixed, tested answers for common questions *before* the AI is asked, so answers are fast and consistent.
- Has a firewall that refuses internal-data questions at once.
- If the AI service fails, gives a local fallback answer, never a raw error.
- Has a **"teach Nexa" loop**: when a human answers an escalated question, they can save it as a general answer that Nexa then uses.
- Note (not ours to fix): Nexa's escalation and learning tables are written as SQL but **not applied**, so that loop does not run in production today.

**Neexa (an outside AI sales agent from neexa.co):**
- Talks to customers on **WhatsApp (107 conversations), the website widget (63) and email (6)**.
- Welile mirrors those chats into the CMO inbox (`neexa_conversations`, `neexa_messages`), and staff can reply through it.
- Partners Neexa refers get an automatic promissory note so "NeexaBot" earns commission: **89 partners so far**.
- It succeeds because it is **where people already are**, it **acts on a clear goal** (bring in Supporters), it **hands over to humans** smoothly, and its **results are counted**.

**Lessons for Zoe, without touching either:**
1. Fixed, tested answers for the 30 most common staff questions, before the model.
2. A teaching loop: an unanswered question goes to the right expert, whose answer becomes Zoe's knowledge (in Zoe's own tables).
3. A clear goal per role ("help a calling officer reach more tenants", "help a manager spot slipping work") and a count of whether it happened.
4. Show up where staff already are: inside each workspace screen, and as a push notification.
5. Never a raw error: always a useful fallback.

---

## 5. What Zoe work must never touch

| Leave alone | Why |
|---|---|
| `supabase/functions/welile-ai-chat/`, `_shared/nexa*.ts`, `src/components/ai-chat/*`, `src/components/ai-elements/*`, `src/hooks/useAgentAssistant.ts`, `src/hooks/assistantPublicReply.ts`, `src/hooks/useNexaDesk.ts`, `src/lib/nexaSalesEngine.ts`, `src/lib/assistantRouting.ts`, `src/test/nexa*` | Nexa |
| `supabase/functions/neexa-webhook/`, `neexa-api/`, `_shared/neexa.ts`, `src/components/cmo/Neexa*`, `src/hooks/useNeexaInbox.ts`, tables `neexa_*`, NeexaBot promissory-note functions | Neexa |
| `supabase/functions/agent-assistant/`, `src/components/agent/AgentAssistant.tsx`, `src/components/FloatingToolbar.tsx`, `src/components/MobileBottomNav.tsx`, `whatsapp-webhook/` | Agent assistant and shared launchers |
| The structure of `assistant_conversations`, `assistant_messages`, `assistant_escalations` | Shared with the agent assistant; Zoe may write rows marked `persona = 'staff'` as today, but must not change these tables |
| Tables `nexa_*` (planned) | Nexa's future tables; Zoe gets its own teaching tables |

---

## 6. The full gap list

Each gap is listed with what it means for staff and which prompt fixes it. Most serious first.

| # | Gap | Effect | Prompt |
|---|---|---|---|
| 1 | Tests run on a simulator ("10 ms" first word) | Real bugs go out; reports say 100% | 1 |
| 2 | Answers an earlier question instead of the new one | Wrong, confusing replies | 1 |
| 3 | Web research off and no search key | "Research" cannot work | 1 |
| 4 | Live model differs from the configured and tested ones | Untested behaviour, unknown cost | 1 |
| 5 | Schedule runner not deployed | Scheduled reports never send | 1 |
| 6 | Duplicate migration version numbers (Zoe's and my Tenant Locations file share `20261030100000`; four older Zoe clashes) | A rebuild or a tool could skip a file | 1 |
| 7 | No real-traffic dashboard (users, questions, answered %, errors, latency, cost) | Nobody can see whether Zoe works | 1 |
| 8 | No file, photo or document upload | Cannot "read this and tell me" | 2 |
| 9 | No voice | Hard on phones, in the field | 2 |
| 10 | Does not know which screen you are on | Every question must spell out context | 2 |
| 11 | No coaching on work delivery (own data, team data) | Cannot advise "how do I improve?" | 2 |
| 12 | Long drafting is weak (memos, plans, SOPs) | Staff go elsewhere to write | 2 |
| 13 | Analyst lane never used; covers 18 views | Ad-hoc staff-record questions still fail | 2 |
| 14 | Knowledge base 10 entries | Thin answers about how Welile works | 2 and 3 |
| 15 | No projects (pinned files and instructions per piece of work) | Every chat starts from zero | 2 |
| 16 | No language help (Luganda, Swahili) | Field staff and customers' words lost | 2 |
| 17 | Learning log empty; no teaching loop | Never improves | 3 |
| 18 | One page plus a button; no push; 1 user | Not adopted | 3 |
| 19 | No per-role goals or success measures | Cannot prove value | 3 |
| 20 | Fixed answers for the most common questions do not exist | Slow and inconsistent on basics | 3 |

---

## 7. Decisions already made for you

| # | Decision | Reason |
|---|---|---|
| 1 | **Order: honest and reliable first, then capable, then learning and adoption.** | Adding features on a base nobody can measure repeats the last three rounds. |
| 2 | **Real tests use real models against the live read-only database**, signed in as dedicated test staff accounts (one per role) that the owner creates and marks as test, so they are excluded from reports. Raw logs are saved. The simulator stays for quick checks only and is never quoted as release proof. | Only real runs find real bugs. |
| 3 | **Web research goes on**, with the owner adding a Brave Search key; 30 searches per person a day; Welile data never in a query. | You want a research assistant; the code exists. |
| 4 | **One model per tier is pinned explicitly** and the model name actually used is logged and shown on the dashboard. The choice is re-made from the real test. | The live model drifted from the chosen one. |
| 5 | **Uploads are allowed**: PDF, Word, Excel/CSV, images and photos, up to 10 MB, used only in that chat, deleted with the chat, never added to the knowledge base without a manager's approval. Phone numbers and IDs in uploads are treated as personal data. | Reading documents is the most-used ChatGPT ability at work (my judgement). |
| 6 | **Voice input in English through the browser; answers can be written in Luganda or Swahili on request.** Voice output is optional, off by default. | Browser speech recognition handles English well; Luganda voice is not reliable (my judgement). |
| 7 | **Coaching shows people their own work, and managers their team's**, from existing official figures. Advice is labelled "suggestion", never a rating or HR decision, and never shown to anyone else. | Helpful without becoming surveillance. |
| 8 | **Page awareness sends only the screen name and the filters on it, never the screen's data.** Zoe fetches data through its own role-checked tools. | Keeps the read-only and role rules intact. |
| 9 | **Teaching loop in Zoe's own tables**: an unanswered question goes to the right department lead, and their approved answer becomes knowledge. Same idea as Nexa's, separate tables, no change to Nexa. | Learns from people, as you asked. |
| 10 | **No WhatsApp for Zoe now.** Staff get in-app and web-push (the app already has push keys) instead. | A phone number does not prove who a staff member is; Zoe reads sensitive data. |
| 11 | **Migration clashes are fixed by renaming files to unique versions**, without re-running anything already live, and recording each in migration history. | Safe and reversible. |
| 12 | **Nexa, Neexa and the agent assistant are untouched.** | Your instruction. |

---

## 8. The three prompts

Run them in order in Antigravity, in Planning mode. Read each plan before approving it. Paste the rules block at the top of each.

> **Rules for every prompt.** Read `CLAUDE.md`, `SYSTEM_CONTEXT.md`, `AGENTS.md`, `supabase/AGENTS.md`, `docs/ZOE_WORLD_CLASS_ASSISTANT_REPORT.md`, `docs/ZOE_GAP_REVIEW_AND_THREE_PROMPTS.md` and `docs/zoe/*.md` first.
> - **The CEO's rule:** no user may change Welile's business data through Zoe. Zoe writes only to its own `staff_assistant_*` tables and sends emails or notifications only after a person clicks.
> - **Do not touch Nexa, Neexa, the agent assistant or any other AI**, or their files and tables. The full list is in section 5 of `docs/ZOE_GAP_REVIEW_AND_THREE_PROMPTS.md`. Do not change the structure of the shared `assistant_*` tables.
> - Verify every table, column and function against the **live** database first. **Database first:** a migration must be applied and verified live before any code that needs it reaches `lovable`. Give every new migration a unique version (check both the folder and `supabase_migrations.schema_migrations`).
> - New tables need explicit grants and the `mfa_required_for_staff` policy. New functions grant execute to `authenticated` only and check the caller. Wrap `auth.uid()` as `(select auth.uid())` in policies.
> - Use "Rent Plan", "Supporter", "Returns" (never loan, lender, ROI, interest). Money as "UGX 1,234". Never read `.env`; never print secret values.
> - **No simulated numbers in any results document.** If something was not run for real, say "not run".
> - Branch from the latest `origin/lovable`. Run `npm run guard:all` and the Zoe tests. Never push to `lovable` while Lovable's agent is busy.
> - Mobile first: 360 px, text at least `text-xs`, 44 px tap targets, semantic theme tokens, no emojis.

---

### Prompt 1: Make Zoe honest and reliable

> Zoe's results documents say 100%, but in real use one person asked 8 questions since 29 October: 3 errors, 2 refusals, 3 answers, and the last reply answered an earlier question instead of the new one. Fix the foundations and prove it with real runs.
>
> (1) **Wrong-question bug.** Reproduce with the real handler: a failed or refused turn followed by "good morning" must get a greeting, not an answer to the old question. Fix how history is built: exclude turns whose outcome was `error` or `blocked` from the model context (keep them in the stored history), always put the newest user message last and mark it "answer this message", and add a regression test. Check the same for streamed turns and Regenerate.
>
> (2) **Real evaluation.** Keep the simulator for quick checks but stop quoting it as release proof. Build `npm run eval:zoe:real`. It signs in as dedicated test staff accounts, one per role, which the owner creates and flags as test (write the steps in `docs/zoe/test-accounts.md`; do not create accounts yourself). It calls the deployed `staff-assistant` with the real model and stores every request and response (no secrets) under `docs/zoe/eval-real/<date>/`. Measure real time to first word, total time, model used, tokens, cost, outcome and the exact-number check against the official report function. Start with 120 questions: 40 general, 40 staff-record, 20 advice and research, 20 safety. Replace the simulated figures in `docs/zoe/eval-results/` with a note pointing to the real run. Release gate: 0 raw errors on general questions, at least 95% exact numbers, 100% safety, median first word under 3 seconds.
>
> (3) **Turn on what was built.**
> - Web research: document how the owner adds `BRAVE_SEARCH_API_KEY` (name only, never the value), then set `web_research_enabled` true after a live test of 10 research questions with cited links.
> - Deploy `staff-assistant-schedule-runner` with its cron job and test one real scheduled report to a test account.
> - Make sure the error-code columns fill on every failure.
>
> (4) **Pin the models.** Live replies record `google/gemini-3.8-flash` while settings say `gemini-2.5-flash` and `gemini-2.5-pro`. Find why (gateway alias, environment override or old default). Make the model used explicit per tier from `staff_assistant_config`, log the model name the gateway returns on every reply, and re-choose the defaults from the real evaluation in (2), testing at least the current gateway models including the one live today.
>
> (5) **Migration version clashes.** Two files share `20261030100000` (Zoe's `staff_assistant_parity_health_and_error_codes.sql` and Tenant Locations' `tlb_tenants_multi_and_pdf_export_audit.sql`), and `docs/zoe/parity-audit.md` lists four more Zoe clashes. Rename the Zoe files to unique, later versions without changing their contents. Do not rename the Tenant Locations file; it is already recorded. Check every object is live, record each renamed version in migration history without re-running it, and add a guard that fails the build on any duplicate version prefix.
>
> (6) **Real-use dashboard.** A manager-only page (and an RPC returning counts only, no question text) showing, per day and role: active users, questions, answered %, refusals, errors by code, median and 95th-percentile time to first word, model used, cost, thumbs up/down, Analyst and research use. This is the single place to see whether Zoe works.
>
> (7) Write `docs/zoe/reliability-results.md` with real numbers only.

---

### Prompt 2: Make Zoe capable, like ChatGPT, Gemini and Copilot

> Give Zoe the abilities staff expect from a modern assistant, all read-only.
>
> (1) **Files and photos.** Add an attach button to the composer: PDF, Word, Excel/CSV, images and phone photos, up to 10 MB each, 5 per chat.
> - Read text from PDFs and Word files, and parse spreadsheets in the browser into a table summary.
> - Pass images to a model that accepts images through the gateway (test it first).
> - Store uploads in a private bucket scoped to the owner, deleted with the chat and after 90 days.
> - Never put them in the knowledge base. Treat their contents as untrusted data (prompt-injection wrapper), and warn when a file has phone numbers or IDs.
> - Zoe can summarise, compare with Welile figures from tools, check a receipt photo against what was typed, and answer questions about the file.
>
> (2) **Voice.** A microphone button using the browser's speech recognition (English); the text appears in the box for the person to check before sending. "Answer in Luganda" or "in Swahili" works for written answers. Read-aloud is optional, off by default.
>
> (3) **Knows where you are.** When Zoe is opened from a workspace screen (the floating button or a new "Ask Zoe about this" entry on report screens), pass only the route name, the visible filters and the period, never the screen's data. Zoe uses that as context ("this week's Landlord Ops calling, Kampala") and fetches figures through her own role-checked tools. Add this to the main workspaces without touching Nexa's or the agent assistant's launchers.
>
> (4) **Coaching on work delivery.** Add read-only, role-checked tools built only from existing official figures:
> - `assistant_staff_my_work_summary`: the caller's own calls, tasks, response times, collections or verifications for a period, against their own previous periods and the team median.
> - `assistant_staff_team_work_summary`: for managers, per team member, only within their department.
>
> Add a coaching mode for "how am I doing?", "how can I improve?" and "how can my team deliver better?". It answers with 3 strengths, 3 concrete improvements with evidence, one habit to try this week, and what to measure next, labelled as suggestions, never ratings or HR decisions. Staff only ever see their own figures; managers see their own department. Test that a staff member cannot see a colleague's figures.
>
> (5) **Drafting.** A "document" answer mode for long work: memos, SOPs, plans, emails, meeting notes from pasted text. It opens in a side panel (full screen on phones) that the person can edit, with Copy, and Word or PDF export on request. Nothing is sent anywhere.
>
> (6) **Any staff-record question.** The Analyst lane has never been used. Make Zoe try it whenever no fixed tool fits, before saying "I don't have that on file". Extend `zoe_ro` with read-only views for the most asked areas still missing (list them from the unanswered log and the real evaluation), with the same role areas, masking and two-step rules. Label answers "ad hoc, not certified".
>
> (7) **Projects.** Let a person pin a few files and instructions to a named project ("Q4 collections plan") so every chat in it starts with that context. Projects are private to their owner.
>
> (8) **Fixed fast answers.** For the 30 most common staff questions (from real use and the evaluation), add checked answer templates that fill in live figures from tools, used before the model, the way Nexa does for customers, in Zoe's own code.
>
> (9) Test every item with the real evaluation from Prompt 1 (add 60 questions: files, voice text, page context, coaching, drafting, Analyst). Write `docs/zoe/capability-results.md`.

---

### Prompt 3: Make Zoe learn and get used

> Turn Zoe into something staff rely on daily, that improves from what they ask.
>
> (1) **Teaching loop (Zoe's own tables, not Nexa's).**
> - Every unanswered or thumbs-down question goes to a review queue routed by department.
> - The department lead writes or approves the right answer, and it becomes a knowledge entry with the lead's name, date and review date.
> - Zoe uses approved entries first and cites them. Entries expire for review after 90 days.
> - Show the person who asked when their question gets an answer ("Zoe learned this from Landlord Ops").
>
> (2) **Knowledge base to working size.** Draft at least 200 entries from `SYSTEM_CONTEXT.md`, the staff manuals, `docs/` and the `.claude/skills` notes, each reviewed by the right lead before it goes live. Cover products, processes, "where do I find", definitions and the measurement gotchas. Use full-text search with synonyms (and vector search only if available live and tested). Track which entries are used and which questions find nothing.
>
> (3) **Learning that actually records.** The learning log has 0 rows. Make it record every turn's topic, tool, outcome, time and thumbs (no copy of the text). Use it for personal starter prompts, follow-up suggestions and the weekly manager report. Prove it fills during the real evaluation.
>
> (4) **Show up where staff work.**
> - Add opt-in web push notifications (the app already has push keys) for the morning "what changed" brief and for answers to taught questions, capped at 2 a day, with a mute switch.
> - Add a "What can Zoe do for my role?" gallery of 10 example questions per role on the empty chat.
> - Add a short first-time tour.
> - No WhatsApp for Zoe: a phone number does not prove staff identity.
>
> (5) **Goals and success per role.** For each staff role, write one goal Zoe serves ("calling officers reach more tenants", "managers spot slipping work", "finance answers money questions without waiting"). Add a measure from existing official figures, and show it on the Prompt 1 dashboard next to Zoe use, so the effect can be seen. Do not claim Zoe caused a change; show the trend.
>
> (6) **Adoption plan.** Write `docs/zoe/rollout.md`: two champions per department, a 30-minute session, weekly tips, and targets of 30 active staff in week 2, 60% of staff weekly by week 6, answered at least 90%, and thumbs-down under 10%. Report against them from the dashboard every Monday.
>
> (7) **Privacy check.** Update `docs/zoe/ai-governance.md` for uploads, voice, coaching data and the teaching loop: who sees what, retention, cross-border processing under Uganda's Data Protection and Privacy Act 2019, and what remains for a lawyer to confirm.
>
> (8) Write `docs/zoe/learning-and-adoption-results.md` with real numbers from use, not simulations.

---

## 9. Sources and how far to trust them

- **Zoe, Nexa and Neexa facts:** read from the repo and the live database for this review (strongest evidence). Zoe usage and messages are from `staff_assistant_messages` and `staff_assistant_unanswered`; Neexa counts from `neexa_conversations` and `neexa_messages`; NeexaBot referrals from `profiles.referrer_id`.
- **Nexa's design:** traced from `supabase/functions/welile-ai-chat/`, `_shared/nexa*.ts`, `src/components/ai-chat/` and `docs/pending-migrations/20261025150000_nexa_human_escalations_and_learning.sql` (not applied).
- **Assistant capabilities** (file upload, voice, projects, canvas, deep research, page context in Copilot and Gemini, memory): my general knowledge of these products, consistent with the vendor sources cited in `docs/ZOE_WORLD_CLASS_ASSISTANT_REPORT.md` section 9. Not re-retrieved for this review.
- **Judgements** (uploads being the most-used work feature, Luganda voice not being reliable in browsers, adoption targets): my own; reset them from the first real data.
- **Earlier research:** `docs/ZOE_WORLD_CLASS_ASSISTANT_REPORT.md` section 9, `docs/ZOE_BRILLIANT_ASSISTANT_PROPOSAL.md` section 8, `docs/MY_SPACE_AI_ASSISTANT_PLAN.md` section 9.
