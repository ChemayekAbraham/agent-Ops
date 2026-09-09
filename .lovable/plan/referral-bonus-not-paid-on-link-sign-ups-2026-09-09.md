# Referral bonus not paid on link sign-ups

## What is wrong

Sheila Asiimwe signed up on 9 September through Timothy Kalyango's referral link. Her profile
correctly records Timothy as the referrer, but **no referral record was ever created for her**,
and the UGX 100 bonus is only paid when a referral record is created. So nothing was paid.

This is not specific to Timothy. Confirmed on live data:

- **1,837 people** carry a referrer on their profile but have no referral record, so their
  referrer was never paid. **1,213** of those signed up in the last 30 days.
- **283 different referrers** are affected. Timothy alone is missing **11**.
- Every one of them is fully qualified for the bonus — sign-up alone is the only requirement.

## Why it happens

Two different sign-up paths exist and only one of them pays:

```text
Agent registers someone in the app
   -> referral record created -> bonus trigger fires -> UGX 100 credited   PAYS

Person signs up themselves via a referral link (/join?r=...)
   -> only referrer stamped on their profile
   -> no referral record -> trigger never fires -> nothing credited        DOES NOT PAY
```

The account-creation routine writes the referrer onto the new profile and even links agent
sub-agents, but it never creates the referral record that the payment trigger listens for.
Verified: the payment trigger fires only when a referral record is inserted, and the bonus
qualification check returns "qualified" for Sheila.

## The fix

1. **Close the gap permanently.** Whenever a new profile is created with a referrer, or an
   existing profile first gains one, create the matching referral record automatically. The
   existing bonus trigger then credits UGX 100 to the referrer's wallet with no further work.
   Guards kept: no self-referral, no frozen referrer, one record per referrer/person pair.

2. **Pay the 1,837 people who were missed.** Create the missing referral records in one
   controlled backfill so the existing bonus trigger credits each referrer UGX 100 through the
   normal ledger path. Total roughly **UGX 184,000**. Timothy receives UGX 1,100 for his 11,
   including Sheila.

3. **Verify.** Re-count records after the backfill to confirm zero remaining gaps, confirm
   Timothy's balance moved by the expected amount, and confirm no duplicate credit was created
   for anyone already paid.

Not touched: the older 9,750 referral records from January to August that were recorded but
never paid (about UGX 975,000). Those were created before sign-up alone became enough to
qualify, and the payment trigger only reacts to new records, never to later qualification. Left
for a separate decision.

## Technical detail

- Payment path: `referrals` INSERT -> `trg_credit_signup_referral_bonus` ->
  `credit_signup_referral_bonus()` -> `try_credit_qualified_referrals()`, which posts a balanced
  double-entry transaction (platform `marketing_expense` cash out / wallet `referral_bonus`
  cash in, `recipient_type: user`) via `create_ledger_transaction` under idempotency key
  `referral_signup:<referral_id>`. Wallet credit is therefore ledger-driven; no direct wallet write.
- Root cause: `handle_new_user()` inserts into `profiles` (with `referrer_id`) and
  `agent_subagents`, but never into `referrals`.
- Change 1: new `AFTER INSERT OR UPDATE OF referrer_id ON public.profiles` trigger inserting
  `(referrer_id, referred_id, bonus_amount 100, restricted_amount 100)` with
  `ON CONFLICT (referrer_id, referred_id) DO NOTHING`, wrapped in an exception block so a
  referral failure can never block account creation.
- Change 2: backfill insert selecting the 1,837 profiles with a referrer and no matching
  `referrals` row, same conflict guard. The idempotency key prevents double crediting anyone
  who somehow already has a ledger entry.
- The trigger fires on INSERT only, so backfilled records credit on insertion as intended.
