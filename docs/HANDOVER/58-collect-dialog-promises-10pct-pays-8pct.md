# 58 — The collect dialog promises 10% and pays 8% to sub-agents

**Reported by:** agent +256748787893 (KENNETH DERRICK DALAA SEKABEMBE), "not getting commission"
**Status:** backend fixed in `20260917100000`. **Four UI sites remain — these are Gemini's.**

---

## The short version

He *is* getting commission. He is a **sub-agent**, so he earns **8%** and his
recruiter (Ssebunya Yasin) takes **2%**. That is exactly what his signed
agreement promises — `AgentAgreementContent.ts` §B states it correctly.

The collect dialog hard-codes **10%**. On his 8,000 collection it promised him
**800**; his wallet received **640**. He concluded the commission wasn't
arriving.

**No money is wrong.** Across all 222 collections since the 2026-09-16 float fix
(48 agents), agent share + recruiter override = exactly 10% on **222 of 222**.
118 correct 8/2 splits, 104 correct full 10%, zero mismatches. This is a
display defect only.

## Who else sees it

| | |
| --- | ---: |
| Verified sub-agent links | **32,199** |
| Recruiters | 751 |
| Whitelisted back to full 10% | 4 |
| Sub-agents who collected in September | **64** |
| Agents on 8% among all who have ever collected | **55 of 81** |

Every one of them is shown 10%.

## What the backend now gives you

`20260917100000` moved the rate out of the allocator into one function, so the
screen and the wallet read the same source.

**New RPC — call this when the dialog opens:**

```ts
const { data } = await supabase.rpc('get_my_commission_rate');
// → { agent_rate: 0.08, recruiter_rate: 0.02, total_rate: 0.10,
//     is_subagent: true, whitelisted: false, label: "8%" }
```

No arguments — it resolves the caller from `auth.uid()`. Safe to cache for the
session; an agent's rate only changes when Agent Ops re-links or whitelists them.

**The collection response now also carries the rate**, so post-collection
screens need no extra call:

```ts
res.commission // { credited_commission, recruiter_override,
               //   full_commission_whitelisted, rate, rate_label }
```

## The four sites

All in `src/components/agent/AgentTenantCollectDialog.tsx`:

| Line | Now | Should be |
| --- | --- | --- |
| [:334](../../src/components/agent/AgentTenantCollectDialog.tsx:334) | `Number(res?.commission?.credited_commission) \|\| Math.round(amount * 0.10)` | drop the fallback — the RPC always returns it |
| [:743](../../src/components/agent/AgentTenantCollectDialog.tsx:743) | `Your commission (10%)` / `Math.round(amount * 0.10)` | `Your commission ({label})` / `amount * agent_rate` |
| [:944](../../src/components/agent/AgentTenantCollectDialog.tsx:944) | `10% instantly credited to your Agent Wallet` | `{rate_label} instantly credited…` |
| [:1123](../../src/components/agent/AgentTenantCollectDialog.tsx:1123) | `Commission: +… (10%)` | use `agent_rate` |

And `src/components/agent/AgentTopUpTenantDialog.tsx` — [:110](../../src/components/agent/AgentTopUpTenantDialog.tsx:110),
[:222](../../src/components/agent/AgentTopUpTenantDialog.tsx:222),
[:238](../../src/components/agent/AgentTopUpTenantDialog.tsx:238),
[:362](../../src/components/agent/AgentTopUpTenantDialog.tsx:362) — same
hard-coded `0.10`.

### Two notes worth heeding

**Delete the `|| Math.round(amount * 0.10)` fallbacks rather than re-pointing
them.** A fallback that invents a number is what turned a correct payout into a
support ticket. If the rate hasn't loaded, render a spinner or nothing — not a
guess.

**Consider showing the sub-agent split rather than hiding it.** "Your commission
(8%) +640 · your recruiter (2%) +160" is honest and matches the agreement. The
recruiter override is already in the RPC response.

## Already correct — don't touch

- `AgentAgreementContent.ts` §B — states 8%/2% correctly
- `EarningsRankSystemSheet.tsx` — shows both tiers correctly
- `ListRegisterEarnDialog.tsx` — advertises "8% – 10%" correctly

## Not the fix

`agent_ops_set_subagent_commission_whitelist()` puts a specific sub-agent back on
the full 10%. It's a commercial lever (only 4 agents are on it) and a legitimate
answer to "should Kenneth be on 10%?" — but it is **not** the answer to this bug.
It would fix one agent and leave 32,198 reading the wrong number.

## One unrelated thing spotted

Kenneth's float is down to **1,755**. His next collection above that will be
refused with `INSUFFICIENT_FLOAT`, which will look like the same problem and
isn't.
