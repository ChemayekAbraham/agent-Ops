# Tasks
- [x] Build CFO landlord float budget setter first, miscellaneous approvals and period history.
- [x] Add COO budget gating/miscellaneous UI and CFO Return to COO/excess warnings without changing existing handlers.
- [x] Run budget UI tests, project guards and desktop/phone checks; no live budget amounts saved.
- [ ] Set today's and this week's landlord float budgets — waiting for the designated CFO to enter the approved amounts.
- [x] Make CRM Broadcast visible; tests and guards pass.
- [ ] Verify Broadcast publishing and acknowledgement end to end — blocked: the signed-in preview account lacks CRM publishing permission.
- [x] Add protected CRM communications publishing, scheduling, versioning and audience checks; live RLS and revoked direct-write/TRUNCATE privileges verified.
- [x] Add CRM editor/preview and shared recipient dialogs with cross-device acknowledgement; 25 tests, phone/desktop preview, mandatory-dialog queue and guards pass.
- [ ] Verify CRM publish → recipient acknowledgement → cross-device readback with authorised accounts — blocked: injected account has neither CRM nor super-admin; own-account session mint failed. No messages published or money moved.
- [x] Make the R&D weekly report editable using shared recorded updates; signed-in add/edit/reload and PDF download verified, ten R&D tests and all guards pass.
- [x] Diagnose and fix Service Centre tenant-request Claim failures; four tests pass and signed-in location/server errors verified without claiming real requests or moving money.
- [x] Update Landlord Ops principal recovery with disbursed-float comparison, three KPIs, fee breakdown dialog and table; verified signed-in live figures, Today/All time, dialog, phone-width graph, guards and three accounting tests; no money moved.
- [x] Add and verify repayment progress and today's expected-versus-collected rent in the selected Agent Ops product profile; checked Joel's live figures and charts without moving money.
- [x] Simplify lending to four entry choices and add a five-user directory with photos, IDs, locations, phone and available vouched amounts; guards and pagination test passed.
- [ ] Verify lending navigation in the signed-in preview — blocked by inconsistent dashboard loading and stacked notices; no money-moving actions tested.
- [x] Align Agent Ops Shopping Advance counts, lists and dossiers with rolling 24-hour received transfers; verified signed-in count, list and real-user dossier without moving money.
- [x] Add selected-note Approve & Pay with live proxy-agent payout preview and explicit confirmation.
- [x] Run logic guards and confirm error-free compilation.
- [ ] Verify signed-in preview and cancellation without sending real payouts — blocked because the requester has no matching sign-in account; preview sign-in required.
- [x] Match Tenant Products & Services to the supplied reference without changing financial logic.
- [x] Verify tenant product tabs, live figures and layout in the signed-in preview.
- [x] Match Payables to the Receivables workspace layout without changing financial logic.
- [x] Verify Payables navigation, live totals and detail views in the signed-in preview.
- [x] Replace the lending sidebar section with Receivables Forecast matching Payables periods and layout.
- [x] Verify Receivables Forecast periods, projections and navigation in the signed-in preview.
- [x] Base Receivables behavior projections on completed past weeks and months and verify live figures.- [x] Merchandise categories: company issued (handover) vs out-sourced (CFO to wallet).
- [x] Widen tenant transfer agent search to all enabled agents.

## Open (8 Oct 2026)
- [ ] Flagged agent wallets: lift only after ID + fraud checks — waiting for which agents, and who approved
- [ ] Agent dashboard: move direct table writes to secure server procedures — waiting for the user to choose where to start
- [x] Remove the duplicate "Schedules" card from the agent menu People section; verified signed-in that it is gone and the other People cards remain.
- [x] Agent dashboard preview: header profile circle now shows the signed-in user's photo, with initials fallback when no photo or the saved photo link is dead; verified signed-in.
- [x] Agent dashboard preview: "Collections due today" card now lists the real tenants still owing today (name, days behind, amount due) from the same server read the Collect dialog uses; empty state only when genuinely nothing is due. Verified signed-in: SSEMANDO MATHIAS, UGX 4,767, 8 days behind — matches the Tenants figures.
- [x] Agent dashboard preview: removed the "Today's Capacity" card and its now-unused figures/styles; the purple "Today's rent" card, shortcuts, "Collections due today" and calendar remain. Verified signed-in, no overflow, build OK.

- [x] Replace the selected supporter agreement with the approved partner contract; isolated browser review and PDF download target verified, guards and build clean; signed-in dashboard check unavailable because requester has no matching auth account. No acceptance or money movement.

- [x] CFO Approved Rent Requests: Approved tab lists every CFO approval all time; Paid only after Financial Operations payout.
- [x] Usage report amount matching: popup + CFO review + server rules live; matching rule tests pass. Not yet clicked through signed-in.
- [x] CFO Approved Rent Requests: date filters (Today etc.) use the CFO approval time; Approved column shows CFO approval time.
