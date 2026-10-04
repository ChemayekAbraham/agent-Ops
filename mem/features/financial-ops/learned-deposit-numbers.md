---
name: Learned deposit numbers
description: user_deposit_numbers is a third phone→user source learned only from positive identifications (manual FinOps routing or high-confidence name match)
type: feature
---
# Learned deposit numbers

`public.user_deposit_numbers (user_id, phone_last9 UNIQUE together, source,
linked_gmail_transaction_id, created_by)` is a growing list of numbers a user
has actually deposited from. It is the THIRD source, alongside
`profiles.phone` and `profiles.mobile_money_number`.

- Single lookup: `public.resolve_user_by_known_phone(p_last9)` (service_role
  only) checks all three. TS wrapper: `supabase/functions/_shared/depositNumberLearning.ts`
  (`toLast9`, `resolveUsersByKnownPhone`, `resolveUniqueUserByKnownPhone`,
  `learnDepositNumber`). All previously duplicated last9 `.ilike` queries in
  `gmail-poll-transactions` now route through it — never reintroduce a raw
  `phone.ilike.%last9` lookup.
- Learning happens ONLY after positive identification:
  - `cfo-direct-credit` with `source_phone` in the body (threaded from
    `RouteEmailDepositDialog`) → source `manual_route`, plus a ONE-TIME SMS
    telling the depositor the number was linked and to prefer their registered
    number. No SMS on repeat/known numbers.
  - `gmail-poll-transactions` when `matchMethod === 'name'` AND
    `nameMatchAudit.confidence === 'high'` AND exactly one Ugandan number was
    visible anywhere in the email → source `name_match_auto`. Never learn from
    medium/low-confidence tiebreakers.
- Conflicts: if the number already belongs to a DIFFERENT user, nothing is
  relinked — a row lands in `user_deposit_number_conflicts`, surfaced in
  FinOps → Email Transactions via `DepositNumberConflictsPanel`.
- Normalization is strictly last-9 digits (`toLast9`), identical across all
  three sources.
