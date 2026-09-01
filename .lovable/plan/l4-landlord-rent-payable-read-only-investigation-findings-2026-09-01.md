# L4 Landlord Rent Payable — read-only investigation findings

No changes were made. Everything below was checked against the live database and the
current source, and the query behind each claim is named in the technical section.

## Headline

L4 cannot be fixed by correcting a mapping, because **there is nothing to map**. The
ledger has never recorded the raising of a landlord obligation. Rent funding is posted
as cash gone and a tenant receivable created, in one step, with no payable in between.
So L4 is not mis-mapped — the liability it is meant to report was never journalised.

Two consequences follow, and both are visible today:

- **L4 renders at zero and is flagged as unsourced.** `ledger_account_map` holds nine
  liability rows in total, covering only L1, L2 and L6. There is no L4 row (nor L3, L5,
  L9). The trial balance produced by `sofp_ledger_legs(now())` returns 18 account codes
  and L4 is not among them.
- **The Company Managed / Self Managed split is dead code.** The split function joins
  `ledger_account_map` for `account_code = 'L4'`, matches no rows, and therefore always
  returns `total = 0`, `self_managed = 0`. The frontend then applies a `0` share, so
  Self Managed prints as zero and Company Managed absorbs the whole (zero) line. The
  split has never displayed a real number.

## What the obligation actually is, and where it lives

The real landlord payable is money already advanced for rent that is sitting with agents
and not yet handed to the landlord. It is tracked operationally, and it reconciles
exactly:

- `agent_landlord_float_allocations`, status `open`, remaining: **UGX 62,002,727** across
  100 allocations.
- `agent_landlord_float.balance`, summed over 778 agents: **UGX 62,002,727**.

Those two agree to the shilling, so the operational record is internally consistent and
is a credible measure. None of it appears anywhere in the ledger as a liability.

## Which categories and legs should feed L4

The lifecycle needs three points, and only the middle one exists today:

```text
  funding        money advanced for a tenant's rent, parked with an agent
                 today:   Cr A1 cash  /  Dr A3 tenant receivable
                 missing: the Cr should be L4 while the cash is still held
  holding        agent holds the cash on the company's behalf
                 no ledger representation at all
  payout         agent pays the landlord
                 exists:  agent_landlord_payout, landlord_payout_request
                 should:  Dr L4, releasing the obligation
```

- **Release side — already present.** `agent_landlord_payout` (84 platform legs,
  UGX 17,461,000; 4 wallet float legs, UGX 540,000) and `landlord_payout_request` are the
  legs that discharge a landlord obligation. `agent_landlord_payout` is currently mapped
  to A1; `landlord_payout_request` has no mapping and has produced no posted legs yet.
- **Raise side — absent.** The funding leg is `rent_disbursement`, mapped to A1, paired
  with `bridge / rent_receivable_created` to A3. Confirmed on sampled groups: every
  `rent_disbursement` group is exactly those two legs. No third leg, and no separate
  category, ever credits a landlord payable.

**This is why a mapping-only fix would make the statement worse.** Pointing
`agent_landlord_payout` at L4 while no category credits L4 would give L4 a permanent
*debit* balance — a negative liability — because only the release half of the pair
exists. L4 must gain its credit side before, or in the same change as, its debit side.

Two legitimate routes, in order of preference:

1. **Journalise the payable.** Post a landlord-payable credit when rent is funded into
   agent landlord float, and map the existing payout categories to L4 as the debit. This
   needs a one-time opening recognition of the UGX 62,002,727 already outstanding,
   otherwise the payout legs will drain an account that starts empty.
2. **Disclose it as a schedule.** Keep L4 sourced from the operational allocations and
   label it explicitly as a non-ledger disclosure. Cheaper, but it breaks the rule that
   every balance sheet figure comes from the trial balance, so it should be a stopgap
   only.

## The correct source for the Company vs Self Managed split

The current axis is wrong on top of being inert. It groups by
`landlords.is_agent_managed`, which describes who manages the *landlord relationship* —
not who **funded** the rent, which is what "Self Managed" means on this statement.

The funding axis is already recorded on `agent_landlord_float_allocations`, on the same
rows that measure the balance: `funded_by_partner_id` together with `source`. On the 100
open allocations:

| Source | Open allocations | Remaining (UGX) |
| --- | --- | --- |
| `cfo_disbursement` | 82 | 37,292,727 |
| `legacy_backfill` | 9 | 23,470,000 |
| `manual_test` | 1 | 300,000 |
| `welile_homes_payout` | 4 | 540,000 |
| `test` | 1 | 50,000 |
| `partner_self_funding` (partner-funded) | 3 | 350,000 |

So Self Managed is UGX 350,000 and Company Managed is UGX 61,652,727 — before any
decision about the `manual_test` and `test` rows (UGX 350,000 combined), which look like
non-production residue and should be confirmed rather than silently included.

## Recommendation

Do not touch the L4 mapping on its own. The ordered fix is: recognise the landlord
payable at funding, bring the existing UGX 62,002,727 on-ledger as an opening balance,
then map the payout categories to L4, and only then rewrite the split to key off
`funded_by_partner_id` / `source` instead of `landlords.is_agent_managed`. Each of those
is a separate change and each needs CFO sign-off, so nothing here should be applied
without approval.

## Technical notes

Evidence, so any of this can be re-checked:

- `select ... from ledger_account_map where account_code like 'L%'` — 9 rows, codes L1,
  L2, L6 only; per-code counts confirm no L4 row exists.
- `select account_code, sum(dr)-sum(cr) from sofp_ledger_legs(now()) group by 1` — L4
  absent from the result.
- `public.get_landlord_float_management_split` joins `ledger_account_map` on
  `account_code = 'L4'`; with no such row the CTE is empty and the function returns
  zeros. `expandLandlordFloat` in `src/components/cfo/balanceSheetClassification.ts` then
  computes `share = 0`.
- `agent_landlord_float_allocations` open remaining and `agent_landlord_float.balance`
  both sum to 62,002,727.
- Sampled `rent_disbursement` transaction groups contain exactly two legs (`platform`
  cash_out + `bridge / rent_receivable_created` cash_in).
- `agent_landlord_payout` platform groups pair with `bridge / rent_receivable_created`,
  `agent_commission_payable` and `agent_commission_earned`, sourced from
  `agent_collections`.
- `log_landlord_payout_request_to_ledger` queues category `landlord_payout_request` into
  `pending_wallet_operations`; that category has zero posted legs in `general_ledger`.

One thing I could not verify and am not asserting: whether the cash represented by the
UGX 62,002,727 is currently reflected in A2 (Cash at Hand — Float with Agents). A2 and A1
both carry very large gross balances and I did not trace them, so the offsetting debit for
any opening recognition of L4 needs to be established before it is booked.
