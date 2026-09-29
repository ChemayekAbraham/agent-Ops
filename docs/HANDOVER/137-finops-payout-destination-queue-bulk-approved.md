# 137 — Financial Ops payout-destination queue bulk-approved (62 rows)

**Date:** 2026-09-25 · **Instructed by:** Josh Wanda ("approve all that are waiting and document that batch in /handover")
**Applied:** live, directly against production (`payout_destination_verifications`). No migration.
**Follows:** doc 136 (payout destinations auto-verify without a Financial Ops call).

## What was approved

After doc 136's two auto-verify rules went live, the Financial Ops queue still showed **62 waiting**. This is the same filter as `finops_payout_verification_counts.waiting`:
- `status = 'waiting'`,
- ID photo and selfie on file,
- not a portfolio funder,
- not in `mv_identity_double_users`.

None of the 62 met either automatic rule:
- **60:** the account name differs from the ID name, and ownership is not proven (no SMS code confirmed on the destination, and it is not the person's login phone).
- **1:** the number is theirs, but `face_verified` is false.
- **1:** the number is theirs, but the ID number read from the photo differs from the one typed.

On Josh's instruction, all 62 were set to `verified` in one statement. The same statement wrote one `audit_logs` row per destination:
- `action_type = 'payout_destination_bulk_approved'`
- `new_values.batch = 'finops_queue_bulk_approve_2026-09-25'`
- `old_values` holds the prior `status`, `decision_reason`, `decided_by` and `decided_at`
- `decided_by` is null, because the write was not made through a staff session
- `decision_reason` starts with `Bulk-approved by Josh Wanda on 2026-09-25 (handover doc 137)`

No other side effects. Unlike `finops_decide_payout_destination`, `profiles.full_name` was **not** rewritten to the ID name.

Result: 62 updated, 62 verified, 0 flipped to rejected by `trg_auto_reject_duplicate_national_id`, 62 audit rows. The queue now reads **0 waiting**.

## Decisions this batch overrode (flagged at the time; Josh said approve all)

- **4 of Nyanzi Lydia Eseri's destinations** had earlier been "Set back for review: double submission of the earlier +256 750 223 152 account". These are Kange muzamiru 0751186622, musubika zulaika 0750920135, and wastla Enock on 256792975606 and 256731275813. A person made that call, and this batch reversed it.
- **Shanitah Nakalyango 256761545243** is on account ISA KATO (`d7f11416…`), whose profile has no `national_id_name`.
- **Concentration.** Several accounts added many destinations in other people's names:

  | Account | Destinations |
  |---|---|
  | Sharifu Kalule | 21 |
  | Nyanzi Lydia Eseri | 15 |
  | Ian Muhwezi | 6 |

  This may be legitimate, for example agents paying customers, but nothing in the system proves who owns those numbers.

## Still controlled after this batch

- `enforce_withdrawal_payout_account_lock`: a wallet withdrawal only pays to the person's registered `profiles.mobile_money_number`. Changing it still goes through the Financial Ops number-change queue.
- The auto-verify rules from doc 136 continue for new destinations. Anything new that fails them will enter the queue again.

## Not touched

After this batch, 2,742 rows are still `waiting` platform-wide. The queue hides them:
- 1,176 belong to portfolio funders, who are exempt from this gate;
- the rest have no ID photo and selfie on file.

## The 62 destinations

| Account (ID name) | user_id | Destination | Name on destination | Prior reason |
|---|---|---|---|---|
| amase rosemary | 003414e0… | 0785 534105 | nafula annet | New ID + selfie submitted |
| amase rosemary | 003414e0… | 0775 328566 | Nafula Annet | New ID + selfie submitted |
| amase rosemary | 003414e0… | 0731896533 | Namulinda merab | New ID + selfie submitted |
| AMOLO SURHAINE | fb6e6bf7… | 0754081966 | alele brian isaiah | Name no longer matches (number theirs; failed face or ID-number check) |
| AMOLO SURHAINE | fb6e6bf7… | 0705005085 | MBALIRE STEPHEN | — |
| CHARLES MUGISHA | 4457ff01… | 0755555176 | Mrs Mary Natembo | — |
| CHARLES MUGISHA | 4457ff01… | 0742824307 | Nakanwagi Edith | — |
| FRANCO WESINGE | 8edfa2ba… | 0731030696 | mugere robert | — |
| IAN MUHWEZI | 3d78f1f8… | 0766305139 | Evelyn Ayikirize | New ID + selfie submitted |
| IAN MUHWEZI | 3d78f1f8… | 0708271668 | Jamil Baluka | New ID + selfie submitted |
| IAN MUHWEZI | 3d78f1f8… | 0705075331 | musawo | New ID + selfie submitted |
| IAN MUHWEZI | 3d78f1f8… | 0752239931 | musubika bridget | New ID + selfie submitted |
| IAN MUHWEZI | 3d78f1f8… | 0752559839 | Namere Babra | New ID + selfie submitted |
| IAN MUHWEZI | 3d78f1f8… | 0709645114 | NAMUTEBI ROSE | New ID + selfie submitted |
| IMMACULATE NAMULINDWA | 1a88b1b8… | 0773078202 | Nabbagala Catherine | — (treasury route, doc 134) |
| IMMACULATE NAMULINDWA | 1a88b1b8… | Equity Bank 1046202587076 | Skybubbles Trading | — (treasury route, doc 134) |
| NAKIMULI KAUTHARA | 627193e0… | DTB 5316 9205 2246 4640 | Derrick Ntwasi | — |
| Nalubiri Angel | 50589da8… | 0706039855 | ssemakula karim | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0751116262 | annah mutonyi | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0705148746 | Belize betty | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0748473248 | ELIZABETH KATEME | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0758958343 | JOHN BOSCO NSEMBE | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0751186622 | Kange muzamiru | **Set back: double submission** |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0757010397 | mbeiza mariam | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0793490947 | munyagira joseph | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0750920135 | musubika zulaika | **Set back: double submission** |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0744777429 | MUWAYA FALUKU | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0706400382 | mwesigwa Erisa | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0743730556 | Namuhooya Stella | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 0755527599 | waiswa salima | — |
| Nyanzi Lydia Eseri | e1bb1b7c… | 256792975606 | wastla Enock | **Set back: double submission** |
| Nyanzi Lydia Eseri | e1bb1b7c… | 256731275813 | wastla Enock | **Set back: double submission** |
| Nyanzi Lydia Eseri | e1bb1b7c… | 256750223152 | watsala Enock | Name no longer matches |
| PETER BUKOMA | 35fba2e3… | 0791844340 | nandudu mary | Name no longer matches (number theirs; failed face or ID-number check) |
| PETER MUSOBA | e8c7c3f3… | 0747521564 | bukoma peter | Name no longer matches |
| SAMUEL SAMUEL | bd5d2690… | 0754509128 | Zalwango Christine | — |
| semyalo benon | 3fede92e… | 0788570812 | Bisaso semyalo Peter | — |
| semyalo benon | 3fede92e… | 0741978152 | Nasali Florence | — |
| SHAKIRAH NAKIMBUGWE | 34ed279b… | 0707556990 | kayemba sharif | — |
| SHARIFU KALULE | 98ee118b… | 0773505074 | Atukei Joyce | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0731132355 | Benon Sebulime | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0772363578 | Emilio Odongo | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0740502332 | Kamuzungu Faruk | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0790554050 | Kasanga Shafick | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0704403438 | Kawuma Ronald | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0781390666 | Kilya john | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0701029964 | kimera samuel | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0773204676 | masika Agnes | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0753526327 | Mr jamesi | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0754626387 | Mubiru Brighet | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0700396066 | Muwonge Johnbosco | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0731286760 | nakamalanya edisa | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0746582023 | Nake Joan | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0705288086 | Nakiwala Fatumah | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0709024881 | Namatome Madina | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0756568483 | Nshemerirwe Christine | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0760758384 | Odur Solomon | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0700838327 | Rogers Sande | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0751602348 | Roset | New ID + selfie submitted |
| SHARIFU KALULE | 98ee118b… | 0782293964 | Tumisiime Benon | New ID + selfie submitted |
| WALYAMBOGA ISAAC | aab93167… | 0703763128 | kakayi margret | — |
| (no ID name) ISA KATO | d7f11416… | 256761545243 | Shanitah Nakalyango | — |

(The 2 rows marked "number theirs" are the ones that failed rule 2 on the face or ID-number check rather than on ownership.)

## Find or reverse the batch

```sql
-- the batch
select * from audit_logs
where action_type = 'payout_destination_bulk_approved'
  and new_values->>'batch' = 'finops_queue_bulk_approve_2026-09-25';

-- reverse one or all: restore the prior state from the audit row.
-- Only do this on instruction; it re-blocks withdrawals to these numbers.
update payout_destination_verifications d
   set status        = a.old_values->>'status',
       decision_reason = a.old_values->>'decision_reason',
       decided_by    = nullif(a.old_values->>'decided_by', '')::uuid,
       decided_at    = nullif(a.old_values->>'decided_at', '')::timestamptz
  from audit_logs a
 where a.action_type = 'payout_destination_bulk_approved'
   and a.new_values->>'batch' = 'finops_queue_bulk_approve_2026-09-25'
   and d.id::text = a.record_id;
```

Note: the BEFORE trigger from doc 136 re-runs the auto-verify rules on a row being restored to `waiting`. That is harmless, because none of these 62 pass them.
