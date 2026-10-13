# Awareness Call — Landlord Consent and Payment Code (OTP) Change

Prepared 8 Oct 2026. Research only — nothing in the app or data was changed.

## 1. What exists today (built 7 Oct)

Inside **Review Rent Request**, staff can save an **Awareness call** to the tenant, the landlord or the agent. For an answered call, the screen asks the same three questions whoever was called:

1. Does this person know a tenant who pays well can grow access up to UGX 30,000,000? (Knew / Heard but unsure / Did not know)
2. Does this person know they can pay by themselves using Welile merchant codes (self-payment)? — shows the MTN 090777 / Airtel 4380664 codes
3. Did you explain it to them? (Yes / Partly / No)

Plus an optional note. Every call is kept permanently (cannot be edited or deleted) and does not change approval or move money.

The answers feed the **Awareness Calls** page under Tenant Ops (Overview, By stage & team, By caller, Log), "My awareness calls", the per-plan call history, and the CSV/Excel export.

Live today: 2 calls saved, 1 of them to a landlord (answered).

## 2. Why the landlord question is wrong

Landlords do not repay Rent Plans, so asking a landlord about merchant-code self-payment is not useful. What matters for a landlord is:

- **Consent** — do they agree to the arrangement (a Welile tenant renting from them, rent paid to them through Welile)?
- **The payment code (OTP)** — when an agent pays the landlord's rent, the system texts the landlord a 6-digit code from **WELILE**: "You are receiving UGX … as rent. OTP: …. Valid 1 hour. Share with the agent ONLY if you want to receive this money." The agent must type that code to release the money. Wrong codes are counted and the code locks after too many tries; an expired code needs a new one. If the landlord does not know to expect this SMS, payouts get stuck or the code is ignored.

## 3. The proposed change (landlord calls only)

Tenant and agent calls stay exactly as they are. When **Who did you call? = Landlord** and the call was answered, show instead:

| # | Question | Answers |
|---|---|---|
| 1 | 30M access question | unchanged (Knew / Heard but unsure / Did not know) |
| 2 | **Does the landlord consent** to receive this tenant's rent through Welile? | Consents / Not sure, wants to think / Does not consent |
| 3 | **Does the landlord know about the payment code (OTP)** sent by SMS from WELILE when they are paid, valid 1 hour, shared only with the agent paying them? | Knew about it / Heard but unsure / Did not know |
| 4 | Did you explain it to them on this call? | unchanged (Yes / Partly / No) |

The merchant-code pills are hidden for landlord calls; a short script box explains the OTP in plain words for the caller to read out.

"Does not consent" is recorded and shown in red, but — like everything else in this feature — **does not block approval**. Staff still decide as usual.

## 4. Reports that must change too

- **Overview**: add a "Landlord consent" card (consents / unsure / does not) and "Knew about payment code" card. The "Knew about merchant-code self-payment" figure must count **tenant and agent calls only**, so landlord answers don't distort it.
- **By stage & team** and **By caller**: add consent and payment-code columns; self-payment columns exclude landlords.
- **Log** and per-plan history: landlord rows show Consent and Payment code; tenant/agent rows show Self-payment.
- **Export (CSV/Excel)**: new columns "Landlord consent" and "Knew about payment code (OTP)"; blank for non-landlord rows. Self-payment blank for landlord rows.
- **My awareness calls**: same split.
- Filters: allow filtering by consent answer (e.g. find every landlord who does not consent).

## 5. Existing records

The one landlord call already saved used the old merchant-code question. It stays as it is (records are permanent) and is labelled "old question" in reports; its consent/OTP answers show as "Not asked".

## 6. Decisions needed

1. Exact wording of the consent question — consent to what? (rent via Welile / being contacted / sharing their details). Draft above assumes "receive this tenant's rent through Welile".
2. Should "Does not consent" alert Landlord Ops, or just appear in reports? (Draft: reports only.)
3. Keep the 30M question for landlords? (Draft: keep.)

## 7. Prompt for Claude (implementation)

```
Adjust the rent-pipeline Awareness Call feature for LANDLORD calls only. Tenant and agent calls must stay byte-for-byte the same in behaviour. Do not touch approve/reject, rent_requests status, money, or the landlord payout OTP functions.

Context: table public.rent_pipeline_awareness_calls (append-only trigger, insert only via SECURITY DEFINER record_awareness_call) has aware_30m, aware_merchant_codes, explained, with CHECK rent_pipeline_awareness_calls_answers_check requiring all three when call_result='answered'. Reporting functions reading aware_merchant_codes (verify live with pg_proc first, the migrations folder is not reliable): record_awareness_call, awareness_calls_summary, awareness_calls_scoped, awareness_calls_by_caller, awareness_calls_by_team, awareness_calls_log, my_awareness_calls_summary, my_awareness_calls_log. Frontend: src/components/pipeline/AwarenessCallPanel.tsx, src/lib/awarenessCallLabels.ts, src/lib/awarenessMonitoringLabels.ts, src/lib/awarenessCallsExport.ts, src/hooks/useAwarenessCalls.ts, src/hooks/useAwarenessMonitoring.ts, src/hooks/useMyAwarenessCalls.ts, src/components/pipeline/MyAwarenessCallsCard.tsx, src/components/executive/tenant-ops/awareness/{OverviewTab,StageTeamTab,CallerTab,LogTab}.tsx, plus their tests.

1. Migration (additive): add nullable columns landlord_consent text CHECK IN ('consents','unsure','refuses') and aware_payout_otp text CHECK IN ('knew','heard','did_not_know'). Replace the answers CHECK so that: answered tenant/agent calls require aware_30m, aware_merchant_codes, explained and have both new columns NULL; answered landlord calls require aware_30m, landlord_consent, aware_payout_otp, explained and aware_merchant_codes NULL; unanswered calls have all answers NULL. Add it NOT VALID then VALIDATE only if every existing row passes; the one existing answered landlord row uses the old shape, so allow it with an explicit legacy branch (recorded_at before the migration timestamp and subject_type='landlord' with aware_merchant_codes set). Keep the append-only trigger untouched.
2. record_awareness_call: add p_landlord_consent and p_aware_payout_otp params (DEFAULT NULL, appended last; drop the old signature in the same migration and re-grant EXECUTE to authenticated). Enforce the rules above with clear errors. Include the new fields in the system_events payload.
3. Reporting functions: return the new columns in logs; add consent counts (consents/unsure/refuses) and payout-OTP counts (knew/heard/did_not_know) to summary, by_team, by_caller and my_* functions; compute aware_merchant_codes counts only over tenant/agent rows. Support an optional consent filter in awareness_calls_scoped/log consistent with existing filter params. Regenerate src/integrations/supabase/types.ts.
4. AwarenessCallPanel: when subject is landlord and answered, replace the merchant-code question and pills with "Does the landlord consent to receive this tenant's rent through Welile?" (Consents / Not sure, wants to think / Does not consent) and "Does the landlord know about the payment code (OTP)? When they are paid, Welile sends an SMS from WELILE with a 6-digit code valid for 1 hour, to share only with the agent paying them." (Knew about it / Heard but unsure / Did not know), plus a short read-aloud script. Clear incompatible answers when the subject changes. Show "Does not consent" in the destructive token colour; never block approve/reject. Use semantic tokens only.
5. Labels/reports/export: add LABEL_LANDLORD_CONSENT and LABEL_PAYOUT_OTP; Overview cards, Stage/Team and Caller columns, Log and per-plan history show landlord vs tenant/agent fields appropriately; legacy landlord row shows "Old question" for self-payment and "Not asked" for the new fields. Export adds "Landlord consent" and "Knew about payment code (OTP)" columns.
6. Terminology: "Rent Plan", "Supporter", "Returns"; amounts as UGX via formatUGX.
7. Update/extend the existing tests (panel, labels, export, monitoring hook, page). Run npm run guard:all, typecheck and tests. Verify in the browser as a tenant_ops user: save one landlord call and one tenant call on a test Rent Plan, confirm both read back correctly in the panel, Log, Overview and export. Record the rule in AGENTS.md (landlord awareness calls ask consent + payout OTP instead of merchant codes).
```
