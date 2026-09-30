# The Landlord Float Pool: a plain-language guide

**For:** the COO, Partner Operations, finance, CFO, agents' managers, and anyone who needs to understand where partner money goes.
**Status:** switched on 30 September 2026 at 09:29 (UTC), i.e. 12:29 in Kampala.
**The technical version** of this document is [LANDLORD_FLOAT_POOL_TECHNICAL.md](./LANDLORD_FLOAT_POOL_TECHNICAL.md).

---

## 1. What the pool is, in one sentence

When a partner puts money into a portfolio, that money is set aside in the **Landlord Float Pool**. It is reserved for paying landlords when tenants need their rent covered, and it is labelled so we always know whose money it is and where it came from.

The money stays in Welile's bank. Nothing leaves the bank when money enters the pool. It is simply ring-fenced: marked "for landlords only" so it is not spent on anything else.

---

## 2. The pool has two compartments

```
                  LANDLORD FLOAT POOL
   ┌──────────────────────────┬──────────────────────────┐
   │  COMPANY-MANAGED         │  SELF-SUPPORT            │
   │                          │                          │
   │  Portfolios with no      │  Portfolios where the    │
   │  tenant and no house     │  partner chose a tenant  │
   │  attached. Welile        │  or a house to support.  │
   │  decides which tenant    │                          │
   │  the money helps.        │                          │
   └──────────────────────────┴──────────────────────────┘
```

Every shilling in the pool sits in exactly one of the two compartments.

| Compartment | When money goes here |
|---|---|
| **Company-managed** | The portfolio has **nothing attached**: no tenant, no house. It does not matter who created it (the COO, Partner Operations, an agent, or the partner). |
| **Self-support** | The portfolio has **one or more tenants or houses attached**, chosen by the partner. |

---

## 3. Inside each compartment, money carries a label

The label does not split the compartment. It tells you **how the money got there**.

| Label | Meaning |
|---|---|
| **Principal** | the money put in when the portfolio was created |
| **Top-up** | extra money the partner added later |
| **Compound** | Returns that were added back into the portfolio instead of being paid out |
| **Returned rent** | money that came back when tenants repaid their Rent Plans |

So at any time we can say, for example: "The company-managed compartment holds 12.49 million, of which most is principal from new portfolios and about 1.3 million is returned rent."

---

## 4. What happens when a portfolio is created

These examples all use **UGX 1,000,000**.

### A. A portfolio with nothing attached (company-managed)

*Example: the COO creates a portfolio for a partner, with no tenant or house.*

1. **The partner's wallet goes down by 1M.** The money was already in their wallet from when they deposited it.
2. **The partner's portfolio shows 1M.** Welile now owes them 1M as a portfolio. It earns Returns and is paid back at the end.
3. **The 1M goes into the company-managed compartment.** It is labelled "principal" and linked to this portfolio.
4. **It waits there** until the CFO funds a tenant's rent. Then it is used for that rent, oldest money first.

### B. A portfolio with a tenant attached (self-support)

*Example: a partner chooses a specific tenant to support, and Partner Operations approve.*

1. **The partner's operational float goes down by 1M** when Partner Operations approve.
2. **The partner's portfolio shows 1M.**
3. **The 1M goes into the self-support compartment,** and **in the same moment** goes out to the agent who looks after that tenant. The agent uses it to pay that tenant's landlord.
4. **The tenant now owes 1M back** on their Rent Plan.

### C. A portfolio with a house attached, and no tenant yet (self-support)

*Example: a partner supports a verified empty house, and Partner Operations approve.*

1. **The partner's operational float goes down by 1M** when Partner Operations approve. Before approval, the amount is only **held**: the partner's available float is lower, but the money has not left.
2. **The partner's portfolio shows 1M.**
3. **The 1M goes into the self-support compartment,** labelled as house support. It **waits there**, because there is no tenant yet.

### Summary

| Portfolio type | Partner's money | Welile owes the partner | Pool | Tenant owes |
|---|---|---|---|---|
| Nothing attached | −1M | +1M | company-managed +1M (waits) | — |
| Tenant attached | −1M | +1M | self-support: in and straight out to the agent | +1M |
| House attached | −1M | +1M | self-support +1M (waits) | — |

---

## 5. Top-ups and compounding

- **Top-up:** when a partner adds money to a portfolio and it is applied, that amount goes into the **same compartment** as the portfolio, labelled "top-up".
- **Compounding:** when a portfolio is set to reinvest its Returns, each amount reinvested goes into the pool labelled "compound". This is not new cash arriving. It is money Welile would otherwise have paid out, now set aside for landlords instead.
- **Self-managed top-up that adds a tenant:** it goes in as self-support and straight out to that tenant's agent, just like a new tenant portfolio.

Each top-up and each compounding payment is its own separate record, so they are always visible separately and never mixed into the original principal.

---

## 6. When the pool is used

**The CFO funds a tenant's rent (company-managed money).**
When the CFO gives an agent landlord float to pay a tenant's landlord, the amount is taken from the company-managed compartment, oldest money first. If the pool does not hold enough, it pays what it has and Welile's general money covers the rest, exactly as before.

**A partner's chosen tenant is funded (self-support money).**
This happens automatically when Partner Operations approve the portfolio (section 4B).

---

## 7. When tenants repay

When a tenant repays an instalment on their Rent Plan:

- **The rent part comes back into the pool.** If the pool funded that tenant, it goes back to the compartment that funded them. Repayments on older Rent Plans that the pool did not fund are also kept in the pool, labelled "returned rent": in the self-support compartment if a partner funded that tenant themselves, otherwise in the company-managed compartment.
- **Welile's fees** (access fee and registration fee) are Welile's income. They **never** go into the pool.
- If a repayment is later reversed, its rent part is taken back out of the pool.

Money that comes back into the pool can then fund the next tenant.

---

## 8. When a Rent Plan is cancelled

If a Rent Plan is cancelled, for example because the agent did not pay the landlord within 24 hours:

- The float given to the agent is taken back.
- **If the pool funded that tenant, the money goes back into the pool.**
- The agent and the tenant are both sent an SMS.

The 24-hour recall now runs automatically as the system itself. It does not depend on any staff member's account.

---

## 9. When a partner cashes out

When a portfolio is redeemed, fully or partly, or cancelled:

- Whatever is still sitting in the pool for that portfolio goes back to Welile's general money.
- The partner is paid the normal way. That part has not changed.
- Money still out with tenants comes back as they repay, and goes straight back to general money.

A portfolio that **matures** does not release anything, because it may be renewed.

---

## 10. What finance will see

The treasury cash figure now shows three things:

| Figure | Meaning |
|---|---|
| **Free cash** (the existing "total cash") | money Welile can freely spend. **This is lower than before**, by whatever sits in the pool |
| **Landlord Float Pool** | money set aside for landlords, split into self-support and company-managed |
| **Total including the pool** | free cash plus the pool: all of Welile's cash |

**Important:** the drop in free cash is not a loss. The money is still in the bank; it is just set aside for landlords.

---

## 11. The rules that keep it safe

1. **Only portfolios created from the switch-on (30 Sep 2026, 09:29 UTC) are included.** Older portfolios never enter the pool. Their top-ups and compounding also stay outside the pool. This was decided so that no old money is moved without a proper review.
2. **Nothing is guessed.** Each portfolio is stamped the moment it is created: "pool" or "not pool". That stamp can never be changed afterwards, even if someone edits the portfolio's date.
3. **Money only enters the pool when the portfolio is live.** A portfolio waiting for approval or for partner details is not in the pool yet.
4. **The books and the pool's own records must always match.** Every movement is written in both places.
5. **Nothing can happen twice.** If a step is retried, it is recognised and not repeated.
6. **A problem never blocks a partner or a tenant.** If a pool step fails, it is recorded for someone to fix, and the partner's portfolio or the tenant's funding still goes ahead.

### Checked on 30 September 2026

- All **94** pool money movements balance.
- The books and the pool's records match to the shilling: self-support **50,000**, company-managed **12,491,125**.
- No portfolio that should be in the pool is missing, and no pool step has failed.

---

## 12. What is not finished yet

| Item | What it means today |
|---|---|
| **House support, when a tenant later takes the house** | The money waits in the self-support compartment. There is no step yet that sends it to the tenant's agent. It is returned when the partner cashes out. |
| **Re-using a partner's returned self-support money on a new tenant** | Returned money waits in the pool under that partner. There is no screen yet for the partner to choose the next tenant. |
| **Returned rent is one shared line per compartment** | It is not traced back to individual portfolios. |
| **6 older Rent Plans funded twice before this work** | About 1.35M of agent float was never recorded in the books. A decision is needed on correcting them. |
| **Screens** | Pool tiles, labels and reports on dashboards are still to be designed. The data is ready. |

---

## 13. Words used in this guide

| Word | Meaning |
|---|---|
| **Portfolio** | a partner's investment with Welile, which earns Returns |
| **Partner / Supporter** | the person who puts money into a portfolio |
| **Rent Plan** | the tenant's arrangement to repay rent that was paid to their landlord |
| **Returns** | what a partner earns on their portfolio |
| **Operational float** | the part of a partner's wallet set aside for supporting tenants and houses |
| **Landlord float** | money given to an agent to pay a specific landlord |
| **Free cash** | Welile's money that is not set aside for anything |
