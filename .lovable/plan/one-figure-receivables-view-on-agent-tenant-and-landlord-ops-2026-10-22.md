# One-figure receivables view on Agent, Tenant and Landlord Ops

## What you will see

Opening Agent Ops, Tenant Ops or Landlord Ops shows one card and nothing else:

```text
Total receivable
UGX 1,204,530,116
1,547 open items   As at 22 Oct 2026, 18:03 EAT      [Refresh]   [Show all dashboard]
```

- The figure is the same number the CFO dashboard shows (read from the existing
  `get_receivables_total` RPC — no new calculation, no new server work).
- **Show all dashboard** reveals the dashboard exactly as it is today; the button
  then reads **Hide all dashboard** and the figure stays pinned at the top.
- Collapsed every time a dashboard is opened fresh.
- **Refresh** re-reads the figure immediately (it does not wait for the normal
  five-minute cache).

## Rules that decide what opens

- If the figure cannot be loaded, the card shows **Unavailable** — never 0 — and
  the full dashboard opens automatically so nothing is hidden behind a figure you
  cannot see. This is the case for accounts whose role is not allowed to read
  receivables: only CEO, CFO, COO, CTO, manager, financial operations and
  super admin are permitted today; everyone else (for example an account holding
  only `operations` or `employee`) gets "Unavailable".
- A link carrying anything besides `tab` — for example
  `/executive-hub?tab=agent-ops&section=directory` or
  `/landlord-ops?decide=…` — opens the full dashboard straight away, because such
  a link asks for something specific.
- `/landlord-ops` shows the figure only on its home page. Its other pages
  (payouts, verification, registers, reports…) open normally, because each one was
  asked for by name.
- While loading, the card reads "Loading…" rather than showing a number.

## Where this goes

| Destination | What happens |
|---|---|
| `/executive-hub?tab=agent-ops` | Figure first, Agent Operations behind the button |
| `/executive-hub?tab=tenant-ops` | Figure first, Tenant Operations behind the button |
| `/executive-hub?tab=landlord-ops` | That link already jumps to `/landlord-ops`, so the figure appears there |
| `/landlord-ops` home | Figure first, the day's Landlord Ops content behind the button |

CEO, CTO, CMO, CRM, Partners Ops and Locations dashboards are untouched.

## Technical details

- New shared component `src/components/receivables/ReceivablesSummaryGate.tsx`.
  It owns one `useReceivablesTotal()` call (the hook already exists in
  `src/hooks/useReceivables.ts`), renders the card, and either renders or hides its
  children. Because it uses the same query key, a dashboard that reads receivables
  itself reuses the cached result rather than asking twice.
- Amount: `formatUGX` from `src/lib/rentCalculations.ts` (the platform UGX
  helper). Open items: `item_count`. As-at time: the RPC's `as_at` timestamp
  formatted with `Intl.DateTimeFormat` in `Africa/Kampala` and labelled EAT — the
  same pattern already used in `src/lib/agentNetwork.ts`.
- `src/pages/ExecutiveHub.tsx`: wrap the mounted dashboard in the gate for the
  three tabs only; "extra query parameters besides `tab`" is computed from the URL
  so a deep link arrives already open.
- `src/pages/landlord-ops/LandlordOpsPage.tsx`: the gate wraps the destination
  content on the index route only. The top bar and sidebar stay available so you
  can still move to a named page; the phone-only floating "Landlord Verification
  Queue" button is part of the collapsed content.
- Display only: no database, migration, permission or RPC changes, and no edge
  function deployment.

## Checks

New test `src/test/receivablesSummaryGate.test.tsx` asserting the three rules you
stated: a failed read shows "Unavailable" and not 0 and opens the full dashboard;
a link with an extra query parameter opens the full dashboard; a plain `?tab=`
link starts collapsed. Then the project's safety guards and the preview build.

## Separate item: one security finding needs your decision

A scan flagged the access rule on `staff_mfa_config`: it currently lets any
signed-in user read the table. The table holds a single row recording the
organisation-wide multi-factor sign-in setting (mode, when it changed, who changed
it) — it is not per-person data, and nothing in this codebase reads it. I have not
changed it. Tightening it means a database change, which your message rules out for
this task, so it needs your say-so:

- **Restrict it to the staff who administer sign-in settings** — the setting stays
  readable where it is managed, and everyone else loses access to it.
- **Leave it as it is** — the flag stays open on the security list.

Tell me which, and I will do it separately from the dashboard work above.
