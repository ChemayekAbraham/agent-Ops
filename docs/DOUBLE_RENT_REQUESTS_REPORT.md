# Double Rent Requests – Investigation Report

*Prepared 7 October 2026 for Tenant Ops. Plain-language summary. Nothing in the system was changed while investigating.*

---

## 1. The short version

- **Some tenants really do have two (or more) Rent Plan requests for the same house.** This is not only a display problem. The extra requests sit in the records, and some of them were **funded and paid out a second time**.
- **It happens when an agent submits the same request more than once** – usually several taps within a few minutes, often on a slow connection, when the app does not clearly confirm the first one went through.
- **The system blocks a new request only once a tenant already has a funded Rent Plan that is still owing.** It does **not** block a second request while the first is still being reviewed. So duplicates slip in at the start, then move through approvals side by side, and both can end up funded.
- **Nampijja Florence herself is clean.** She has exactly one Rent Plan (UGX 200,000 rent, UGX 276,000 total), fully paid. If her screen looked doubled, it is a display issue, not her records. The tenant with the serious problem is **Nampijja Deborah** (details below) – she may be the one that was seen.

---

## 2. How big is the problem?

| What we checked | Count |
|---|---|
| Tenants with **more than one request still open** (not rejected, cancelled, deleted or completed) | **129 tenants, 281 requests** |
| Of those, open repeats for the **same landlord and same rent** (clear duplicates) | **50 tenants** |
| Tenants with **two Rent Plans both owing money at the same time** | **11 tenants** |
| Same-day, same-house, same-rent requests where **both got funded** | **4 tenants** |
| Pairs of near-identical requests sent within 10 minutes of each other (all time) | 119 pairs, 32 tenants |

Some open repeats are genuine (a real renewal, or a new house). The "same landlord, same rent, same day" group is the clear-cut duplicate group.

---

## 3. Worked examples

### Nampijja Deborah – funded twice for the same house
- On **25 August 2026** her agent submitted **6 requests in 9 minutes** – same landlord, same UGX 200,000 rent.
- 3 were rejected, 1 is still pending, and **2 were funded**:
  - First plan funded **15 Sep** – UGX 200,000 paid to the landlord, UGX 58,000 repaid so far.
  - Second plan funded **1 Oct** – **another UGX 200,000 paid out** for the same house, UGX 0 repaid.
- Result: her screen shows she owes about **UGX 494,000** instead of about **UGX 218,000**. A second UGX 200,000 left the company, and the agent was also paid a second set of commission.

### The other three tenants funded twice on the same day
| Tenant | Rent | Date requested | What happened |
|---|---|---|---|
| Patrick Kagame | UGX 450,000 | 23 Sep | One repaying, the second funded on 2 Oct and later cancelled |
| katabila prossy | UGX 200,000 | 13 May | Both funded the same day; one now completed, one repaying |
| IAN MUHWEZI | UGX 1,050,000 | 20 May | Both funded the same day; both completed |

### Other tenants showing two owing plans at once (to review)
Atimango Joyce, KAKOOZA MUZAFALU, mbabazi oliver, nalunjoji Teddy Nalongo, Namyalo Margret, Nanyonga Mariam, Ndagire Esther, Semakula Faizo, SSEKATE HAMIDU (three plans), Walugembe George William. Some of these are real renewals or a new house. Others look like leftovers (for example, plans with UGX 0 or UGX 1 rent that are still marked funded). Each needs a person to check it.

### Nampijja Florence
- One request, funded 10 April, fully repaid (UGX 276,000 of UGX 276,000).
- Five payment records. Four of them also show in the agent collections list – that is normal: each agent-collected payment is written in more than one place.
- If a screen showed her twice, it was most likely a different screen (the Tenant Ops "workspace" view or the plan history) or an old, cached page. **A screenshot of exactly what was seen would settle it.**

---

## 4. Why it happens (the causes)

1. **The submit button only protects itself on the phone.** When the agent taps *Submit*, the button greys out, but there is no "this exact request was already received" check on the server. If the connection is slow, the first request may arrive while the agent thinks it failed, and they tap again.
2. **The server's duplicate guard has a gap.** It refuses a new request only when the tenant **already has a funded, still-owing Rent Plan**. While requests are still in review (pending, service centre, agent ops, and so on), any number of copies are accepted.
3. **Nothing re-checks at payout time.** When the CFO funds a request, the system does not ask "is another Rent Plan for this tenant and house already funded or about to be?" So two copies that both reach the end are both paid.
4. **Reviewers can't easily see siblings.** On the review screens each request looks like a standalone case. Nothing warns "this tenant has 5 other requests for the same house from the same day".
5. **Stats add up every live plan.** The tenant screen adds the balance of every funded/repaying plan. This is correct for real second plans, but it doubles what a tenant owes when one plan is a copy.

---

## 5. What this affects

- **Tenants:** shown, and chased for, money they don't owe. Daily targets for their agent go up too.
- **Company money:** a second rent payment to the landlord, plus duplicate agent commission and fees.
- **Reports:** amounts owed, Receivables and collection rates are overstated.
- **Staff time:** reviewers spend time rejecting copies one by one.

---

## 6. Recommended solution (in order)

1. **Stop new duplicates at the door** – one open request per tenant per house, enforced by the server, with a clear message to the agent ("A request for this tenant and house is already under review – open it instead"). Also make the submit button safe against double taps and retries.
2. **Block a second payout** – at CFO funding, refuse if the tenant already has a funded or repaying Rent Plan for the same house in the last 60 days, unless it is marked as a renewal.
3. **Show duplicates to reviewers and let them clean up** – a "Possible duplicates" warning on every review screen, plus a Tenant Ops list of all current duplicates, with a one-click "Close as duplicate" that keeps the original.
4. **Fix the figures and recover money** – a finance-approved correction for tenants already funded twice (Nampijja Deborah first). This is done through proper reversal records, never by editing balances.

The four prompts below build these steps one at a time.

---

## 7. Build prompts (use one at a time, in order)

### Prompt 1 – Stop duplicate submissions
> Read the live database first (the migrations folder is not reliable). On `public.rent_requests`, extend the existing BEFORE INSERT duplicate guard (`trg_enforce_no_duplicate_rent_request` / its function) so that, in addition to today's "active funded plan" rule, it refuses a new request when the same `tenant_id` already has a request in any in-review status (pending, service_center_review, agent_ops_approved, tenant_ops_approved, landlord_ops_approved, coo_approved, or any other non-terminal status found live) for the same `landlord_id` (or same `house_listing_id` when set). Exempt `registration_type` in ('renewal','outstanding_balance'). The error must name the existing request's stage and date, in plain words, using "Rent Plan" (never "loan"). Add an optional `client_request_key uuid` column with a partial unique index, have `AgentRentRequestDialog.tsx` generate one key per dialog session and send it on insert, and treat a unique-violation on that key as "already submitted" (show success, don't retry). Keep the existing button disabling; additionally ignore taps while a submit is in flight using a ref. Show the server's message to the agent instead of a generic error. Do not change approval steps. Test with a self-rolling-back transaction: two identical inserts → second refused; a renewal → allowed. Run `npm run guard:all`.

### Prompt 2 – Block a second payout at funding
> Read the live CFO funding / rent disbursement path (the RPC or edge function that sets `funded_at` and posts `rent_disbursement`). Before any money moves, refuse funding when the same tenant already has another request with `funded_at` set (status funded/repaying/completed) for the same landlord or house within the last 60 days, unless the new one is `registration_type = 'renewal'` and the earlier one is fully repaid. The error must list the other Rent Plan (rent, date funded, amount repaid). Add a CFO override only with a written reason of at least 10 characters, saved to `audit_logs` and emitted as a `system_event`. No ledger or wallet changes in this step. Test inside a rolled-back transaction using Nampijja Deborah's pattern. Run `npm run guard:all`.

### Prompt 3 – Show duplicates to reviewers and allow safe clean-up
> Add a read-only, role-gated server function `rent_request_duplicate_siblings(p_request_id)` that returns other requests for the same tenant with the same landlord/house or same rent, created within 30 days, with their status, stage and funded date. On every rent pipeline review screen (Service Centre, Agent Ops, Tenant Ops, Landlord Ops, COO, CFO), show a warning card "Possible duplicate – N other requests for this tenant and house" listing them, without changing the Approve/Reject buttons' behaviour. Add a "Duplicate Requests" page under Tenant Ops → Classic listing all current duplicate groups (tenant, agent, landlord, rent, dates, statuses, whether more than one was funded), with filters by agent, date and "funded twice". Add a "Close as duplicate" action for unfunded copies only, which sets the existing rejected status with reason "Duplicate of <id>", writes an `audit_logs` row and a `system_event`. Never touch funded copies here.

### Prompt 4 – Correct tenants already funded twice
> Read-only first: produce a list of every tenant where two Rent Plans for the same house were funded within 60 days (start with Nampijja Deborah, Patrick Kagame, katabila prossy, IAN MUHWEZI), showing amounts paid out, repaid, commission paid and current balance per plan. Then, only after CFO approval, build a correction flow in the CFO area: for each chosen duplicate plan, mark it ended as a duplicate so it stops counting towards what the tenant owes and agent targets, and post the reversal through the existing approved finance reversal function (never edit ledger rows or wallet balances directly). Any repayments made on the duplicate move to the original plan. Record who approved, why (10+ characters) and the before/after figures in `audit_logs`, and emit a `system_event`. Show the tenant's corrected balance afterwards. Use "Rent Plan", "Supporter", "Returns" only.

---

## 8. Things to confirm

- Please send a screenshot of the doubled screen for Nampijja Florence, so we can tell whether it was her or Nampijja Deborah, and which page.
- Should a tenant ever have two Rent Plans for **different houses** at the same time? The fix above blocks only the same house.
- Who should approve recovering the second payout (for example Deborah's extra UGX 200,000) – CFO alone, or CFO and COO?
