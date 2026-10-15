# Tasks
- [x] Make the R&D weekly report editable using shared recorded updates; signed-in add/edit/reload and PDF download verified, ten R&D tests and all guards pass.
- [x] Refine agents-mock: compact white layout, one font, concise request action, real tenant profiles and repayment percentages, compact calendar; signed-in desktop/phone, filters and tenant-detail opening verified; guards passed and no page errors.
- [x] Redesign agents-mock with Post Rent Request first, period toggle, plain tenant phone numbers, counts and a clearer calendar; signed-in toggle/calendar/request-form navigation verified, no page errors or phone overflow; all guards passed.
- [ ] Historical missed-tenant details and ten-record server fetching for agents-mock — blocked on a verified read-only historical detail contract; current view pages existing records locally and does not invent missing historical details.
- [x] Remove the "Collected today" / "Still to collect" tiles from the agents-mock rent card; card now shows only the ring, rent due and tenant count — checked in the browser (both tile labels gone, no page errors), build clean.
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
- [x] Agent dashboard preview: header profile circle now shows the signed-in user's photo, with initials fallback when no photo or the saved photo link is dead; verified signed-in.
- [x] Agent dashboard preview: "Collections due today" card now lists the real tenants still owing today (name, days behind, amount due) from the same server read the Collect dialog uses; empty state only when genuinely nothing is due. Verified signed-in: SSEMANDO MATHIAS, UGX 4,767, 8 days behind — matches the Tenants figures.
- [x] Agent dashboard preview: removed the "Today's Capacity" card and its now-unused figures/styles; the purple "Today's rent" card, shortcuts, "Collections due today" and calendar remain. Verified signed-in, no overflow, build OK.

- [ ] Replace the selected supporter agreement with the approved partner contract and verify review/download without accepting or moving money.
