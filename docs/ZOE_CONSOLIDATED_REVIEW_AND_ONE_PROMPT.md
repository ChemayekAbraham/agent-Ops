# Zoe: consolidated review and one prompt

*3 November 2026. Plain-language review. Nothing in the app, code or database was changed for this review. It follows `docs/ZOE_GAP_REVIEW_AND_THREE_PROMPTS.md` (31 October), checked again against the live database and the latest `origin/lovable` (tip `80d63e42b2`), plus fresh research into new attack patterns for the features that review proposed. It ends in **one** prompt instead of three, as asked.*

---

## 1. The short version

**Some real progress happened since 31 October. A new, more serious problem appeared alongside it: the live database now holds objects that exist nowhere in the committed code.**

1. **Three gaps from the last review are genuinely fixed:**
   - The duplicate migration version number is resolved (Zoe's file was renamed to `20261030100500`; mine from the same day is untouched).
   - The knowledge base grew from 10 to **216 entries**.
   - The learning log now has rows (8, backed by your real historical questions).
2. **A new database table and two new functions exist live with no matching file in `origin/lovable` at all** — not a missing migration, a **missing migration that was never written to the repo**. `staff_assistant_projects` (a "projects" table), `staff_assistant_real_use_dashboard` (the usage dashboard) and `assistant_staff_my_work_summary` (a coaching tool) are live, correctly locked down (RLS on, MFA policy present, `anon` denied — so not a security hole today), but **nobody could rebuild this database from the repo and get the same result**. This is a bigger version of the exact mistake the last two reviews were written to stop.
3. **Nothing changed in real use.** Still 1 person, 16 messages, last question 31 October. Web research is still off, with no search key. The Analyst lane has still never been used. The scheduled-report function is still not deployed.
4. **The three new abilities proposed last time — reading files, browsing the web, and an ad-hoc SQL tool — each have well-documented ways to go wrong**, found in this week's security research (section 3). None of this is theoretical: real products have been attacked this way in 2025–2026. The one prompt below builds each ability with its matching defence from day one, instead of fixing it after a demo makes you proud and someone else finds the hole.

**What stays true from last time:** Zoe is reliable-on-paper but barely used, and still lacks the abilities people expect from a modern assistant. **What's new:** the database and the repository have drifted apart again, and the next three abilities need to be built with specific, named defences, not just "read-only."

---

## 2. What I checked (3 November)

| Check | What I found |
|---|---|
| `origin/lovable` tip | `80d63e42b2`, no Zoe-specific commits since 31 October; one large merge commit re-landed already-existing Zoe files from a different branch. |
| Live usage | 16 messages, 1 user, last question 31 October 07:09. No change. |
| Duplicate migration | **Fixed.** `20261030100500_staff_assistant_parity_health_and_error_codes.sql` now holds Zoe's file; `20261030100000_tlb_tenants_multi_and_pdf_export_audit.sql` is unchanged and still recorded under its own version. |
| Knowledge base / learning log | KB now **216** rows (was 10). Learning log now **8** rows (was 0), backfilled from your 8 real questions. Notes: still 0. Analyst queries: still 0. Feedback: still 1. |
| Web research | Still off (`web_research_enabled = false`); no `BRAVE_SEARCH_API_KEY`, `TAVILY_*` or `EXA_*` secret anywhere in the project. |
| Scheduled reports | `staff-assistant-schedule-runner` is **still not deployed** (not in the function list). |
| **Orphaned live objects (new finding)** | `staff_assistant_projects` (table), `staff_assistant_real_use_dashboard` and `assistant_staff_my_work_summary` (functions) exist on the **live database**, each correctly grant-locked (RLS on, `mfa_required_for_staff` policy present, `anon` denied, `authenticated` only). **None of the three migration files that would create them is in `origin/lovable`.** They exist only as untracked files in a local, stale working copy of this repo. No pushed edge-function code calls any of them yet, so they are inert, not dangerous — but they are undocumented and unreproducible. |
| Models | `staff_assistant_config` still reads `model_fast = gemini-2.5-flash`, `model_deep = gemini-2.5-pro`. Not re-verified against a live reply, since there has been no new traffic since 31 October to check against. |
| `eval:zoe:real` | Does not exist. `package.json` still only has `eval:zoe`, `eval:zoe:live` and `eval:zoe:release` — all simulators or scripted packs, per the last review's finding. |

**Not verified:** whether the orphaned functions were written by a person, by Lovable's own agent continuing from the last report unprompted, or left over from an earlier session on this machine that did not finish. I did not open a live chat with Zoe (needs a staff login). The exact cause is not provable from the files alone.

---

## 3. New loopholes found for the abilities the last review proposed

Fresh research (this week), for the specific additions `docs/ZOE_GAP_REVIEW_AND_THREE_PROMPTS.md` asked for: file upload, web research, voice, coaching, the teaching loop, the ad-hoc SQL tool, and push notifications. Each line names the one mitigation that matters most.

| Addition | The real-world loophole | The one mitigation that matters |
|---|---|---|
| **File/photo upload** | Attackers hide instructions in a document as white-on-white or zero-size text, or in PDF layers and metadata, that a human never sees but the text extractor reads. One 2025 study found this in about 1% of a large batch of ordinary PDFs. Zip files can also be built to exhaust whatever unpacks them. | Convert PDFs to images before reading them where practical (this strips invisible text and metadata outright); otherwise strip hidden formatting and cap archive depth, size and extraction time; always treat extracted text as untrusted data, never as instructions. |
| **Web research mode** | A fetched web page can contain hidden instructions aimed at the assistant itself ("indirect prompt injection"), and a URL-fetching tool can be pointed at the server's own internal network or cloud metadata address instead of the open web, unless that is blocked at the network level, not just by checking the text of the URL. | Block private and internal network addresses at the network level (not by string-matching the URL), and never let the same turn that reads the open web also have a channel that can send data out (email, a notification, a wallet or ledger tool) — keep research strictly read-only and separate from anything that could leak or act. |
| **Browser voice input** | The browser's built-in speech recognition for most languages sends the audio to a third-party cloud service (commonly Google's or Microsoft's) to turn it into text; this is often not disclosed to users. | Tell staff plainly that voice input is processed by an outside speech service, and only ask for the microphone at the moment it is used. |
| **Coaching on work delivery** | Treating an AI's score or suggestion as if it were a performance rating is exactly the pattern that labour law in other countries (the EU among them) is moving to regulate as high-risk, requiring workers to be told about it in advance. Uganda has no such law today, but the standard is becoming a reasonable one to follow anyway. | Keep coaching advisory-only, tell staff and managers it exists and what feeds it, and never let its output flow automatically into a pay, promotion or disciplinary decision. |
| **Teaching loop (staff answers become Zoe's knowledge)** | A wrong or malicious submission can quietly become something Zoe repeats as fact to everyone, with nobody noticing until much later. | Require a named reviewer to approve every entry before it is usable, and record who wrote it, who approved it and when it is due for another look. |
| **Ad-hoc SQL (Analyst) tool** | In Postgres, a view normally runs with its owner's permissions, not the caller's, so even a "read-only" view can quietly let someone see rows their own role should never see — unless the view is explicitly told to run as the caller. This is the same kind of gap this project's own engineering notes already warn about for database functions. | Set `security_invoker = true` on every view the tool is allowed to query, and check the model's SQL against an explicit list of allowed tables and columns rather than trusting "write one SELECT" as a rule in the prompt alone. |
| **Push notifications** | Browsers increasingly detect and penalise spammy notification habits — Chrome, for instance, added a filter in 2025 that can silently mute or revoke notification permission for an app that over-sends. | Ask softly inside the app before the browser's own permission prompt, keep topics specific and off by default, and never send more than a couple of notifications a day. |

**How to read this table:** none of these says "don't build the feature." Each says exactly what the previous review's design was still missing. The prompt below bakes each mitigation in as a numbered requirement, not an afterthought.

---

## 4. Decisions made for you

| # | Decision | Reason |
|---|---|---|
| 1 | **Reconcile the database drift first, before anything else.** Every live object without a matching committed file is written up, then either committed as a proper migration (if it is wanted) or removed (if it is not). | You cannot safely build on top of a database nobody can reproduce. |
| 2 | **One prompt, not three**, as asked — but it keeps the same strict order inside it: fix and prove, then add abilities with their defences built in together, then make it learn and get used. | Matches your request while not losing the sequencing that matters. |
| 3 | **Every new ability ships with its one-line defence from section 3 on day one**, not as a later patch. | The point of looking at "the world" first is to not rebuild what already went wrong elsewhere. |
| 4 | **Web research, uploads and the SQL tool are never usable in the same reply that can also email, notify or act.** | This is the single rule, called the "lethal trifecta" in current security writing, that prevents one assistant turn from reading something unsafe and then quietly acting on it. |
| 5 | **Coaching and the teaching loop are explicitly advisory**, with a named human owner for every entry and no automatic link to HR outcomes. | Matches where other countries' labour law is heading, and is simply fair. |
| 6 | **Nexa, Neexa, the agent assistant and all their files and tables stay untouched**, exactly as before. | Your repeated instruction. |

---

## 5. The one prompt

Run this in Antigravity, in Planning mode. Read the plan before approving it. Paste the rules block at the top.

> **Rules.** Read `CLAUDE.md`, `SYSTEM_CONTEXT.md`, `AGENTS.md`, `supabase/AGENTS.md`, `docs/ZOE_WORLD_CLASS_ASSISTANT_REPORT.md`, `docs/ZOE_GAP_REVIEW_AND_THREE_PROMPTS.md`, `docs/ZOE_CONSOLIDATED_REVIEW_AND_ONE_PROMPT.md` and `docs/zoe/*.md` first.
> - **The CEO's rule:** no user may change Welile's business data through Zoe. Zoe writes only to its own `staff_assistant_*` tables and sends emails or notifications only after a person clicks.
> - **Do not touch Nexa, Neexa, the agent assistant or any other AI**, or their files and tables (the list is in section 5 of `docs/ZOE_GAP_REVIEW_AND_THREE_PROMPTS.md`). Do not change the structure of the shared `assistant_*` tables.
> - **Database first, and always committed.** Verify every table, column and function against the **live** database before relying on the migrations folder. A migration is applied and verified live, and **committed to the repository in the same piece of work**, before any code that needs it reaches `lovable`. No database object may exist live without a matching file in the repo. Give every new migration a unique version (check both the folder and `supabase_migrations.schema_migrations`).
> - New tables need explicit grants and the `mfa_required_for_staff` policy. New functions grant execute to `authenticated` only and check the caller. Wrap `auth.uid()` as `(select auth.uid())` in policies. Every new view used by the Analyst tool must set `security_invoker = true`.
> - **The lethal-trifecta rule:** no single assistant reply may, in the same turn, (a) read untrusted content (an uploaded file or a fetched web page) **and** (b) have access to Welile's private data **and** (c) have a channel that can send information out (web fetch, email, push notification, or a write tool). If two of the three are needed together, the third must be disabled for that turn.
> - Use "Rent Plan", "Supporter", "Returns" (never loan, lender, ROI, interest). Money as "UGX 1,234". Never read `.env`; never print secret values.
> - **No simulated numbers in any results document.** If something was not run for real, say "not run".
> - Branch from the latest `origin/lovable`. Run `npm run guard:all` and the Zoe tests. Never push to `lovable` while Lovable's agent is busy.
> - Mobile first: 360 px, text at least `text-xs`, 44 px tap targets, semantic theme tokens, no emojis.

---

> **Part A — Reconcile the database drift.**
> Live production has `staff_assistant_projects` (table), `staff_assistant_real_use_dashboard` and `assistant_staff_my_work_summary` (functions), with correct grants and RLS, but **no matching file anywhere in `origin/lovable`**. For each: read its live definition with `pg_get_functiondef` / the table's live DDL, decide whether it is wanted (it fits the "projects", "dashboard" and "coaching" ideas from the earlier reviews), and either (a) write a proper migration that creates exactly what is already live, with grants, the MFA policy, a rollback file, and record it under its true applied version in `supabase_migrations.schema_migrations` without re-running it, or (b) if it is not wanted or not needed yet, safely drop it live and say so. Either way, write `docs/zoe/schema-drift-reconciliation.md` naming the three objects, what was found, and what was done. Add a guard (or extend `scripts/guard-zoe-parity.mjs`) that fails the build if any `staff_assistant_*` or `assistant_staff_*` object exists live with no matching migration file in the repo.

> **Part B — Fix the known bugs and prove it with real evaluation, not a simulator.**
> 1. **Wrong-question bug.** Reproduce with the real handler: a turn whose outcome was `error` or `blocked`, followed by a plain "good morning", must get a greeting, not a reply to the earlier question. Exclude `error`/`blocked` turns from what is sent to the model as context (keep them in storage), always place the newest user message last and mark it as the one to answer, and add a regression test. Check streamed turns and Regenerate too.
> 2. **Real evaluation.** Build `npm run eval:zoe:real`. It signs in as dedicated test staff accounts, one per role, that the owner creates and flags as test (write the steps in `docs/zoe/test-accounts.md`; do not create accounts yourself). It calls the deployed `staff-assistant` with the real model, stores every request and response (no secrets) under `docs/zoe/eval-real/<date>/`, and measures real time to first word, model used, tokens, cost, outcome, and an exact-number check against the official report function. Start with 120 questions: 40 general, 40 staff-record, 20 advice/research, 20 safety. Keep the existing simulator for quick local checks, but mark every existing results file that used it as "simulated, not release proof," and from now on quote only the real run. Release gate: 0 raw errors on general questions, at least 95% exact numbers, 100% safety, median first word under 3 seconds.
> 3. **Pin the models and turn on what already exists.** Confirm live replies use the models named in `staff_assistant_config`; if not, find and fix why, and log the model name the gateway actually returns on every reply. Deploy `staff-assistant-schedule-runner` with its cron job and test one real scheduled report to a test account. Confirm `error_code` fills on every failure going forward.
> 4. Write `docs/zoe/reliability-results.md` with real numbers only.

> **Part C — Add the capabilities, each with its named defence from section 3 of `docs/ZOE_CONSOLIDATED_REVIEW_AND_ONE_PROMPT.md` built in from the start.**
> 1. **Files and photos**, with the file-upload defence: PDF, Word, Excel/CSV, image/photo, up to 10 MB, 5 per chat. Prefer converting PDFs to page images before extracting their content where practical; otherwise strip hidden formatting, scripts and macros before anything is read. Cap archive/zip depth, size and extraction time, and reject anything that cannot be safely unpacked in that budget rather than skipping it silently. Wrap every extracted word as untrusted data the model must never treat as an instruction. Store uploads in a private, owner-scoped bucket, deleted with the chat and after 90 days; never add an upload to the knowledge base without a manager's explicit approval; warn when a file contains phone numbers or IDs.
> 2. **Web research**, with the web-research defence: a real search provider (default Brave, pluggable), called only from the server, with the outbound query firewall that already exists extended to also block any URL the model tries to fetch that resolves to a private, loopback or link-local address, or a cloud metadata address, enforced by the server's own network rules, not by checking the text of the URL alone. Research-mode replies are read-only for that entire turn: no draft-email, notification, reminder, schedule or write tool may fire in the same turn a web fetch happened in (the lethal-trifecta rule above). Cap at 30 searches per person a day, 5 per question. Every outside fact is labelled "Outside source" with its link and date, never merged into a Welile figure.
> 3. **Voice**, with the disclosure defence: a microphone button using the browser's built-in speech recognition (English), with the recognised text shown in the box for the person to check before sending, and a one-time, visible note that voice input is processed by an outside speech service. "Answer in Luganda" or "in Swahili" works for written replies; spoken replies are optional and off by default.
> 4. **Page awareness**: when opened from a workspace screen, Zoe receives only the route name, the visible filters and the period — never the screen's data — and fetches any figures itself through its own role-checked tools.
> 5. **Coaching**, with the advisory-only defence: read-only, role-checked `assistant_staff_my_work_summary` (already live; verify and, if needed, correct it under Part A) for a person's own work against their own history and the team median, and a new `assistant_staff_team_work_summary` for managers, scoped to their own department only. A coaching mode answers "how am I doing" or "how can I improve" with 3 strengths, 3 concrete suggestions with evidence, one habit to try, and what to track next — every answer labelled "suggestion," never a rating, and never shown to anyone but the person (or, for a team summary, their manager). Test that a staff member cannot see a colleague's figures.
> 6. **The Analyst (ad-hoc SQL) tool**, with the view-security defence: audit every view in `zoe_ro` and set `security_invoker = true` on each (checking `pg_depend` the way the project's own engineering notes already require for helper functions), add an explicit allow-list of tables and columns the generated SQL is checked against before it runs, and keep the existing read-only transaction and row cap. Make Zoe try the Analyst lane before saying "I don't have that on file," labelled "ad hoc, not certified" in every such answer.
> 7. **Drafting mode** for memos, SOPs, plans and emails from pasted text, opening in a side panel (full-screen on phones) with Copy and optional Word/PDF export; nothing is sent anywhere from this mode.
> 8. **Projects** (verify and, if kept, finish the live `staff_assistant_projects` table from Part A): a person pins a few files and instructions to a named project so every chat inside it starts with that context; private to its owner.
> 9. **Push notifications**, with the consent defence: a soft in-app ask before the browser's own permission prompt, specific and off-by-default topics (the morning brief, answers to taught questions), capped at 2 a day, with an easy mute.
> 10. Test every item above with the real evaluation from Part B (add roughly 60 more questions covering files, voice text, page context, coaching, drafting and the Analyst lane). Write `docs/zoe/capability-results.md`.

> **Part D — Make Zoe learn and get used.**
> 1. **Teaching loop**, with the data-poisoning defence: every unanswered or thumbs-down question goes to a review queue routed by department; a named department lead must approve an entry before it is usable; every entry records who wrote it, who approved it, and a review-by date (90 days); Zoe cites the entry and tells the original asker when their question gets an answer.
> 2. **Knowledge base to working size**: draft at least 200 entries (the base is already at 216, so extend and curate rather than starting over) from `SYSTEM_CONTEXT.md`, the staff manuals, `docs/` and the `.claude/skills` notes, each reviewed before publishing. Track which entries get used and which questions still find nothing.
> 3. **Learning log**: confirm it keeps recording every real turn's topic, tool, outcome, time and thumbs (no text copy), and wire it into personal starters, follow-up suggestions and a weekly manager report.
> 4. **30 fixed, checked fast answers** for the most common staff questions (from real use and the evaluation), filled from live tools, used before the model — the same idea Nexa already uses for customers, built in Zoe's own code.
> 5. **Adoption**: a "What can Zoe do for my role?" gallery of 10 example questions per role on the empty chat, a short first-time tour, and one goal and one measure per role (for example "calling officers reach more tenants"), shown on the dashboard from Part A next to Zoe's own usage so the effect over time can be seen without claiming Zoe caused it. Write `docs/zoe/rollout.md` with two champions per department, a 30-minute session, and targets (30 active staff by week 2, 60% weekly by week 6, 90% answered, under 10% thumbs-down).
> 6. **Privacy check**: update `docs/zoe/ai-governance.md` for uploads, voice, coaching data and the teaching loop — who sees what, retention, cross-border processing under Uganda's Data Protection and Privacy Act 2019, and a short note that coaching is kept advisory-only given how other countries now treat workplace-monitoring AI, with what remains for a lawyer to confirm.
> 7. Write `docs/zoe/learning-and-adoption-results.md` with real numbers only.

---

## 6. Sources and how far to trust them

- **Zoe's current live state:** read directly from `origin/lovable` and the live database for this review (strongest evidence).
- **File-upload hidden-instruction research and zip-handling risk:** `tianpan.co/blog/2026/04/20/document-attack-surface-enterprise-ai-prompt-injection`, `arxiv.org/html/2508.19287v1`, `schneier.com/blog/archives/2025/08`, `cloudmersive.com/article/Why-ZIP-Uploads-are-Dangerous`, `mimecast.com/content/what-is-a-zip-bomb`.
- **Web-fetch SSRF and the "lethal trifecta" pattern:** `futureagi.com/blog/owasp-llm-top-10-2025-risks-mitigations-2026`, `decryptiondigest.com/.../ai-agent-egress-proxy-ssrf-prevention-default-deny`, `simonwillison.net/tags/exfiltration-attacks`, `hiddenlayer.com/research/the-lethal-trifecta-and-how-to-defend-against-it`. One cited incident (an Anthropic Files API exfiltration report) came from a secondary source only and was not independently confirmed; treat it as unverified.
- **Voice input and third-party processing:** `ej2.syncfusion.com/vue/documentation/speech-to-text/security`, `deepgram.com/learn/speech-to-text-privacy`. The exact retention policy of browsers' own built-in speech API was not found directly on a browser vendor's page; confirm with Chrome/Mozilla documentation before quoting a specific retention claim.
- **Workplace AI coaching and labour law direction:** `remoteworkeurope.eu/insights/eu-ai-act-remote-work-monitoring`, Baker McKenzie and Faegre Drinker EU AI Act commentary. Two sources disagreed on the exact EU compliance date; Uganda has no equivalent law today, so this is used only as a direction to follow voluntarily, not a legal requirement here.
- **Knowledge-base poisoning (the teaching loop):** `promptfoo.dev/lm-security-db/vuln/context-robust-rag-poisoning`, arXiv 2604.00387. This is an early-stage research area; no source measured how well human review alone actually catches bad entries, so review is necessary but not proven sufficient on its own.
- **Postgres view permissions for the Analyst tool:** `dev.to/ashish_sinha.../rls-policy-returns-zero-rows`, `dpriver.com/blog/text-to-sql-security-10-risks`. This matches a gotcha this project's own `CLAUDE.md` already flags for database functions, now shown to apply to views used by a natural-language query tool too.
- **Push-notification abuse and browser countermeasures:** `securityscientist.net/blog/12-questions-and-answers-about-browser-notification-abuse`, `developer.mozilla.org/docs/Web/API/Push_API/Best_Practices`, Chrome's 2025 anti-abuse filter coverage via Help Net Security.
- **Earlier research, carried forward:** `docs/ZOE_WORLD_CLASS_ASSISTANT_REPORT.md` section 9, `docs/ZOE_GAP_REVIEW_AND_THREE_PROMPTS.md` section 9, `docs/ZOE_BRILLIANT_ASSISTANT_PROPOSAL.md` section 8.
