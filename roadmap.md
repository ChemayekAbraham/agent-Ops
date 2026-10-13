# Tasks
- [x] Swap the Transactions shortcut on agents-mock for Leaderboard that opens /dashboard/agents/leaderboard; click checked in the browser (real rankings load), build clean.
- [x] Swap the Sub-Agents shortcut on agents-mock for Service Center that opens /agent/service-center; click checked in the browser (lands on the real Service Center page), build clean.
- [x] Show "Today's Capacity" (collected of expected today, progress, tenants completed) in place of Today's Collections on agents-mock; card text, progress value and phone layout checked in the browser, build clean.
- [x] Remove the Deposit/Withdraw/Transfer row from agents-mock; shortcuts, collections, calendar and bottom nav checked in the browser, balances hide/show correctly, no side scroll, build clean.
- [x] Match agents-mock to the latest screenshot, including wallet, shortcuts, empty collections and calendar; wallet visibility, calendar navigation, safe action dialogs and phone-width overflow checked; build clean.
- [x] Restyle agents-mock using the latest compact reference: purple collection card, earnings inside rent-request CTA, compact tenant rows and slim bottom navigation; browser verified 10/20/24 sample loading, buttons, filtering and phone layout without page errors.
- [x] Create and verify design-only /dashboard/agents-mock with ten-at-a-time sample tenants; existing agent dashboard and payment rules unchanged. Browser checked loading 10/20/24, detail, post preview and mobile filtering; build clean.
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
