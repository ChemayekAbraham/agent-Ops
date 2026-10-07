# Double Rent Requests – Investigation Report (version 2)

*Prepared 7 October 2026 for Tenant Ops. Plain language. Nothing in the system was changed while investigating.*

**What's new in this version:** every count now separates **"Funded" (the agent got the money as float)** from **"Landlord paid" (the landlord actually got the money)**. These are two different moments, and the first version treated them as one.

---

## 1. Two different moments: "Funded" vs "Landlord paid"

When the CFO approves a Rent Plan, the money does **not** go to the landlord at once:

| Step | What happens | What the screen says |
|---|---|---|
| 1. **Funded (float sent to agent)** | The CFO sends the rent money to the agent's **landlord-payment float**. The money is still with Welile, held by the agent. | Status becomes "Funded" |
| 2. **Landlord paid** | The agent pays the landlord from that float. Only now has money really left Welile for that house. | The float record shows an amount paid out |

So **"Funded" does not mean the landlord was paid.** A duplicate that is only "Funded" can still be pulled back from the agent's float. A duplicate where the landlord was paid means money has already left, and must be recovered.

There is also a third, older group: **"Funded, no float record"**. These plans were marked funded (mostly before May 2026) but the system has no record of float being sent or the landlord being paid. We cannot tell from the records where the money went.

---

## 2. The short version

- **Some tenants really do have two Rent Plans for the same house.** It is not only a screen problem.
- **Cause:** the agent submits the same request several times in a few minutes (slow network, no clear "received" message), and the system only blocks repeats once a plan is already funded and owing.
- **Nampijja Florence's own records are clean** – one Rent Plan, UGX 276,000, fully paid. The serious case is **Nampijja Deborah**: the same house was funded twice **and the landlord was paid twice**.

---

## 3. Granular figures – exact copies (same tenant, same landlord, same rent, same day)

Requests still alive (not rejected, cancelled or deleted):

| Stage of each copy | Requests | Tenants | Rent value | Float sent to agent | Paid to landlord | Still shown as owing |
|---|---|---|---|---|---|---|
| **Not funded yet** (still in review) | 22 | 13 | UGX 3,380,000 | UGX 0 | UGX 0 | UGX 3,895,534 * |
| **Funded – float only, landlord not yet paid** | 0 | 0 | UGX 0 | UGX 0 | UGX 0 | UGX 0 |
| **Landlord paid** | 6 | 4 | UGX 3,300,000 | UGX 3,300,000 | UGX 3,300,000 | UGX 584,000 |
| **Funded, no float record** (old) | 3 | 2 | UGX 600,000 | none recorded | none recorded | UGX 125,100 |
| **Total** | **31** | **15** | UGX 7,280,000 | UGX 3,300,000 | UGX 3,300,000 | UGX 4,604,634 |

\* The amount a request *would* owe once funded. Not-yet-funded requests should not count as owing, but some screens still add them – see section 5.

**Key point:** today there are **no exact-copy duplicates sitting in float only**. Every funded exact copy either reached the landlord or is an old plan without a float record. So there is nothing to quietly pull back from an agent's float – each case needs recovery.

### Tenants with an exact copy funded more than once

| Tenant | Rent | Requested | Copy 1 | Copy 2 | Extra money that left Welile |
|---|---|---|---|---|---|
| **Nampijja Deborah** | 200,000 | 25 Aug | Funded 15 Sep, **landlord paid**, 58,000 repaid | Funded 1 Oct, **landlord paid again**, 0 repaid | **UGX 200,000 to the landlord** (still owing on both) |
| IAN MUHWEZI | 1,050,000 | 20 May | Funded 26 May, landlord paid, fully repaid | Funded 26 May, landlord paid, fully repaid | UGX 1,050,000 paid twice – but the tenant repaid both, so no loss now |
| katabila prossy | 200,000 | 13 May | Funded 13 May, **no float record**, completed | Funded 13 May, **no float record**, repaying | Unknown – no record of where the money went |

(Patrick Kagame's second copy, funded 2 Oct, was later cancelled, so it is no longer in these figures.)

Ndagire Esther, inyero beatrice and Ndagire Sumayiyah each have one funded copy and one unfunded copy of the same request – the unfunded copy should be closed before anyone funds it.

---

## 4. Granular figures – tenants with two or more plans owing at the same time

Not all of these are copies; some are real renewals or a second house. Split by stage:

| Tenant | Owing plans | Landlord paid | Float only | No float record | Total shown as owing |
|---|---|---|---|---|---|
| Atimango Joyce | 2 | 2 | 0 | 0 | UGX 5,650,000 |
| Namyalo Margret | 2 | 2 | 0 | 0 | UGX 1,091,000 |
| mbabazi oliver | 2 | 2 | 0 | 0 | UGX 505,700 |
| **Nampijja Deborah** | 2 | 2 | 0 | 0 | UGX 494,000 |
| nalunjoji Teddy Nalongo | 2 | 2 | 0 | 0 | UGX 385,200 |
| Nanyonga Mariam | 2 | 2 | 0 | 0 | UGX 23,001 |
| SSEKATE HAMIDU | 3 | 0 | **1** | 2 | UGX 1,067,027 |
| Walugembe George William | 2 | 0 | **1** | 1 | UGX 969,300 |
| Ndagire Esther | 2 | 0 | 0 | 2 | UGX 202,200 |

What this tells us:
- **6 tenants** have two plans where **both landlords were paid** – real money out twice. For each, someone must confirm whether it is a genuine second house/renewal or a copy.
- **2 tenants (SSEKATE HAMIDU, Walugembe George William)** have one plan in **float only** – the money is still with the agent. If that plan is a copy, it can be recalled from the agent's float **before** the landlord is paid. These are the cheapest to fix and should be checked first.
- **3 tenants** have old plans with **no float record** – these need a finance check of the original payment.

---

## 5. Why the tenant's "money owed" goes wrong

1. **Copies count twice.** The tenant screen adds every live plan's balance. Two copies of one plan doubles what the tenant appears to owe (Deborah: about UGX 494,000 shown instead of about UGX 218,000).
2. **"Funded" is treated like "landlord paid."** Some screens start counting a plan as owed as soon as it is funded, even when the money is still in the agent's float. A tenant should only owe once the landlord has been paid (or the tenant has started repaying).
3. **Old plans with no float record still count**, even though nobody can show the money reached the landlord.

---

## 6. Why it happens

1. The *Submit* button protects itself only on the phone. There is no server check that "this exact request was already received", so slow-network retries create copies.
2. The server blocks a new request only once a plan is **funded and owing**. While requests are in review, any number of copies are accepted.
3. At funding, nothing checks "is another plan for this tenant and house already funded?"
4. At landlord payout, nothing checks "has this landlord already been paid for this tenant and house?"
5. Reviewers can't see sibling requests on the review screens.

---

## 7. Recommended solution (in order)

1. **Stop copies at the door** – one open request per tenant per house; double-tap safe.
2. **Two payout checks** – one when the CFO funds (float to agent), and a second, separate one when the agent pays the landlord.
3. **Owed = landlord paid** – show and count a plan as owed only once the landlord was paid or repayment started; show "Funded – awaiting landlord payment" otherwise.
4. **Clean up by stage** – float-only copies: recall the float. Landlord-paid copies: finance-approved recovery. No-float-record plans: finance investigation. Always by proper reversal records, never by editing balances.

---

## 8. Build prompts (use one at a time, in order)

### Prompt 1 – Stop duplicate submissions
> Read the live database first (the migrations folder is not reliable). On `public.rent_requests`, extend the existing BEFORE INSERT duplicate guard so it also refuses a new request when the same `tenant_id` already has a request in any non-terminal status (pending, service_center_review, agent_ops_approved, tenant_ops_approved, landlord_ops_approved, coo_approved, funded, repaying, and any other live non-terminal status) for the same `landlord_id` (or `house_listing_id` when set). Exempt `registration_type` in ('renewal','outstanding_balance') only when the earlier plan is fully repaid. The error names the existing request's stage and date in plain words ("Rent Plan", never "loan"). Add an optional `client_request_key uuid` column with a partial unique index; `AgentRentRequestDialog.tsx` creates one key per dialog session and treats a unique violation on it as "already submitted" (show success). Ignore taps while a submit is in flight using a ref. Show the server's message to the agent. Don't change approval steps. Test in a self-rolling-back transaction. Run `npm run guard:all`.

### Prompt 2 – Two payout checks: at funding and at landlord payment
> Read the live funding path (`fund-agent-landlord-float` and anything that sets `funded_at`) and the landlord payout path (whatever increases `agent_landlord_float_allocations.paid_out_amount`). (a) At funding: refuse when the same tenant already has another request with `funded_at` set for the same landlord/house within 60 days, unless it is a renewal of a fully repaid plan. (b) At landlord payout: refuse paying out an allocation when another allocation for the same tenant and landlord already has `paid_out_amount > 0` and its Rent Plan is still owing. Both errors list the other Rent Plan (rent, funded date, landlord-paid date, amount repaid). A CFO override needs a written reason of 10+ characters, saved to `audit_logs` with a `system_event`. No ledger or wallet changes. Test in rolled-back transactions using Nampijja Deborah's pattern. Run `npm run guard:all`.

### Prompt 3 – "Owed" only after the landlord is paid; duplicate warnings for reviewers
> Using `src/lib/collectibleRentRequests.ts` and `v_agent_daily_eligibility` as the single rule, make every tenant-facing and agent-facing "money owed" figure count a Rent Plan only when the landlord was paid (`paid_out_amount > 0`) or the tenant has started repaying; show other funded plans as "Funded – awaiting landlord payment" with no owed amount. List every surface that sums `total_repayment - amount_repaid` and switch it to the shared rule. Add a read-only, role-gated function `rent_request_duplicate_siblings(p_request_id)` returning same-tenant requests with the same landlord/house or rent within 30 days, each with its stage: not funded / float only / landlord paid / funded with no float record. Show a "Possible duplicate" warning card on every pipeline review screen without changing Approve/Reject. Add a "Duplicate Requests" page under Tenant Ops → Classic with those stage columns and filters (agent, date, "landlord paid twice", "float only"). Add "Close as duplicate" for unfunded copies only (rejected with reason "Duplicate of <id>", plus `audit_logs` and `system_event`).

### Prompt 4 – Clean up tenants already funded twice, by stage
> Read-only first: list every tenant with two or more funded Rent Plans for the same landlord/house, each with its stage (float only / landlord paid / no float record), amounts sent, paid to landlord, repaid, and agent commission paid. Write it to a report and stop for CFO approval. After approval: for **float-only** copies, recall the unspent float from the agent through the existing approved float-recall path, then close the copy. For **landlord-paid** copies, post a finance-approved reversal of the copy's receivable and the duplicate commission through `create_ledger_transaction` (never edit wallets), and open a recovery case for the extra landlord payment. For **no-float-record** copies, open a finance investigation and do not move money. Start with Nampijja Deborah, SSEKATE HAMIDU and Walugembe George William. Every step writes `audit_logs` and a `system_event`. Run `npm run guard:all`.

---

## 9. Questions for you
- Please send a screenshot of where Nampijja Florence looked doubled, so we know which screen it was.
- Can a tenant ever have two Rent Plans for different houses at the same time?
- Who approves recovering Deborah's extra UGX 200,000 – the CFO alone, or CFO and COO?
