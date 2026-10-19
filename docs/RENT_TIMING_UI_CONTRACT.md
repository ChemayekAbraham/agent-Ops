# Rent Plan application timing: UI contract (hand-off to Gemini)

Data and logic are done and tested: `rent_request_timing` / `rent_request_timing_history` (migration `20261019100000`, not applied yet), `src/lib/rentTiming.ts`, `src/hooks/useRentRequestTiming.ts`. No shared JSX was changed. Nothing below needs a calculation in the browser: every value is a string or number the helpers already return.

## 1. The row (every applicable review card)

One compact three-column row, built from `timingRow(timing)`:

| column | cell | content |
|---|---|---|
| 1 | `row.current` | label ("At Tenant Ops", "With the agent for correction", "Review finished", "Closed"), value ("10 d", "5 h 20 min", "Not available"), detail ("Since 9 Oct 2026, 15:00") |
| 2 | `row.previous` | label ("Before: Agent Ops"), value ("3 d"), detail ("6 Oct 2026, 15:00 to 9 Oct 2026, 15:00"); "None" when there was no earlier visit |
| 3 | `row.total` | label "Total journey", value ("13 d"), detail ("Started 6 Oct 2026, 15:00") |

- Each cell has `quality`: `confirmed` (show nothing extra), `estimated` (a small "Estimated" tag, `QUALITY_LABEL`), `unavailable` (the value already reads "Not available"; show the tag "Not recorded").
- `row.note` is one plain sentence to show under the row when something is missing or estimated (otherwise null). It explains; it is never styled as a deadline or an alarm.
- A clock/chevron control at the end of the row opens the full vertical journey with the existing expansion/details pattern of the card. Reject / Details / Approve stay exactly as they are and keep their order.
- 360px and 390px: three columns, each cell `label` over `value` over (optional, smaller) `detail`; text no smaller than `text-xs`; the control is at least 44px. From md the same three cells in a row. Semantic tokens only; no emojis; no colour that implies "late" (there is no overdue threshold).
- Words: "Rent Plan", never "loan". Durations and dates are already formatted (`formatElapsed`, `formatKampala`); do not reformat them.

## 2. The vertical journey (opened on demand)

`useRentRequestTimingHistory(requestId, enabled)` where `enabled` is the open state of the expansion. It returns the same timing plus `visits[]`:

```
{ desk, start, end, seconds, quality, source }
```

Render one line per visit, newest last, with `deskLabel(desk)`, `formatElapsed(seconds)`, `formatKampala(start)`, and the `quality` tag. A "correction" visit is "Waiting for agent correction". Repeated visits to the same desk are separate lines (never combined). A combined time per desk may be shown only as a separately labelled "All visits to Tenant Ops" detail if wanted. Skipped desks (`skipped_desks`) are listed as "Not visited: Partner Ops", never as a zero-length visit. Loading: a skeleton in the expansion. Error: a message with a Retry button (the hook returns `error` and `refetch`); never show zero or an empty journey on failure.

## 3. Where it goes and what to pass

One call per desk, not per card: `const timing = useRentRequestTiming(ids)` with the ids the desk has already loaded, then `timingRow(timing.byId.get(request.id))` for each card. A request the server left out has no entry and `timingRow(undefined)` reads "Not available".

- `src/components/executive/RentPipelineQueue.tsx` (and its consumers AgentOpsPipelineHub, TenantOpsDashboard, LandlordOpsDashboard, landlord-ops/pipeline/RentRequests, COO and CFO desks): ids = the loaded requests of the active desk. The same `useRentDeskOrder` ids are fine.
- `src/components/executive/tenant-ops/PipelineStatusHub.tsx`: same hook, same helper, so the same request shows the same strings at the same `timing.asOf`.
- CFO funded / Financial Ops execution surfaces (`CFOApprovedRentPayouts`, `RentDisbursementQueue`): the review row stops at funding. Show `timing.byId.get(id)?.payout` separately: "Waiting for the landlord payment" with `formatElapsed(payout.waiting_seconds)` while `payout.still_waiting`, else "Landlord paid after N"; always with the word "approximate" next to the landlord payment time (`payout.landlord_paid_quality` is `estimated`). Repayment completion has no recorded time: show nothing for it.
- Limit: the hook sends at most 200 ids per call; `timing.omitted` says how many were not asked for. A desk with more than 200 loaded cards should page (ask for the visible page), not ignore `omitted`.

## 4. States every surface must have

loading (skeleton row, no numbers), error with Retry (`timing.error`, `timing.refetch`), unavailable (cell value "Not available" plus `row.note`), estimated (tag), empty desk (no hook call, nothing rendered).

## 5. Must not

- No timer ticking in the browser and no `Date.now()` arithmetic: the server's `as_of` is the time of the numbers. To refresh, call `timing.refetch` (there is no polling).
- No "overdue", "late", "SLA" wording or colour thresholds.
- Do not use `updated_at` or a reviewer timestamp as a time.
- Do not recompute the previous visit or the total from dates.
