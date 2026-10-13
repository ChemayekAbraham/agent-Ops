# Why the system "refreshes" in the middle of work — investigation

Date: 7 October 2026
Scope: Tenant Ops and Landlord Ops dashboards first (the Calling Center especially), and what the same problem does to every other staff screen.
Code was **not** changed. I read the code, queried the live database (read-only), and watched the signed-in preview as the Tenant Ops test user.

---

## 1. The short answer

There is no single "refresh bug". There are **several different things** that make a screen vanish and come back, and one of them is happening all the time without anyone doing anything:

1. **Every time a staff member comes back to the browser tab, the whole dashboard is thrown away and rebuilt.** The app re-checks the person's permissions, shows a full-screen loading dots page, and then builds the dashboard again from nothing. Anything half-done on screen is lost. **This is the main cause, and I could reproduce it.**
2. **Tapping a push notification re-loads the tab you are working in.**
3. **The app silently reloads itself** when it thinks a screen file is "old" (after we publish a new version) or when the connection is poor.
4. A few smaller things: pull-to-refresh on some screens, automatic retry-reloads when the app is slow to start, and being sent to the sign-in page when the session runs out.

**Why a phone call dies when this happens.** The Calling Center does not use the staff member's phone. It makes the call **inside the browser** (a live voice connection that exists only in that browser tab's memory). Two things end that call instantly:

- reloading the page destroys the connection, and
- the call screen has a safety rule, "never leave a live call running when the screen goes away", which **hangs up the moment the screen is removed**, even if the page was not reloaded. Rebuilding the dashboard (cause 1) removes the screen, so the call is hung up.

So an officer talking to a tenant sees a short flash of loading dots, the dashboard comes back, and the call is gone.

---

## 2. What I found, in order of how much it matters

### Cause 1 — The dashboard is rebuilt whenever the sign-in is "re-confirmed" (confirmed, reproduced)

**What happens, in plain words**

- The app keeps a note of who is signed in. Whenever the browser tab becomes visible again (switching tabs, switching from WhatsApp, unlocking the phone, laptop waking up), the sign-in library announces "signed in" again. This is normal and the team's own code comment says so ("SIGNED_IN also fires on every tab resume").
- Each announcement hands the app a **new copy** of the signed-in user. The app treats a new copy as a change.
- The screen that wraps every executive/operations dashboard (the Executive Hub, which hosts Tenant Ops, Landlord Ops, Agent Ops, CRM, CEO, CTO and others) asks "what is this person allowed to open?" again whenever that copy changes. While it asks, it **replaces the whole dashboard with the full-screen loading dots**. When the answer comes back, it builds the dashboard again from scratch.
- The same "ask again, show dots, rebuild" pattern is in the access guard that wraps the CFO, COO, CEO, CMO, CRM, HR, R&D, Director, Financial Ops and Admin Users pages.

**What I saw in the preview (signed in as the Tenant Ops test user, Awareness Calls page open, nothing being clicked):**

- In about 110 seconds of sitting still, the app's own log recorded **14 "signed in" announcements** (the preview pane flips between visible and hidden, which is the same thing a person does when switching tabs).
- Each time I watched for it, the dashboard was **removed and replaced by the full-screen dots, then rebuilt about 0.9 seconds later** (charts and all). I saw this four times in about a minute of watching. Before the rebuild there was nothing wrong on screen.
- That was on a fast office connection. On slow mobile data, the "ask again" step takes longer, so the dots page lasts longer.

**Why it is so common:** it needs no deploy, no error and no bad network. A normal day of switching between the Calling Center, WhatsApp, a notes tab and email triggers it.

**Which screens it hits:** every Tenant Ops, Landlord Ops and Agent Ops view inside the Executive Hub (all of Classic, the Calling Center, Calling Hub, Review Requests, Awareness Calls), plus every screen behind the permission-checked access guard.

**Where in the code:** `src/hooks/useStaffPermissions.ts` (re-runs on every new user copy, and flips "loading" back on), `src/pages/ExecutiveHub.tsx` (returns the full-screen loader whenever "loading" is on), `src/components/auth/RoleGuard.tsx` (same for permission-checked routes), `src/hooks/useAuth.tsx` (stores the new user copy on every "signed in" announcement).

### Cause 2 — Tapping a push notification reloads your open tab (confirmed in code, not tested live)

The notification service worker (`public/sw.js`, the "notificationclick" handler) finds the tab that is already open and **forces it to navigate to the notification's link**. That is a full page load of the tab you are using. If an officer is on a call and a payment, concern or approval notification arrives and they tap it, the tab reloads and the call drops.

Ops staff receive many notifications, so this is a realistic second source.

### Cause 3 — Silent automatic reloads for "old file" problems (confirmed in code)

- **`src/lib/lazyWithRetry.ts`** loads each screen section on demand. If a section fails to load three times (a poor connection, or the file was replaced when we published a new version), it **reloads the whole page without asking**, once every 30 seconds at most. A weak Ugandan mobile connection is enough to trigger it, not only a new release.
- **`src/components/ChunkErrorBoundary.tsx`** wraps the whole app. It treats any error whose technical trace mentions an app file path as an "old file" error, and when that happens it **rebuilds the entire app tree once**. That can be set off by an ordinary bug anywhere, not only by old files.
- **`src/components/financial-ops/FinancialOpsCommandCenter.tsx`** reloads once per session on certain errors.
- The "new version available" prompt (`BuildUpdateWatcher`) is **well behaved**: it only offers, never reloads by itself.

None of these checks whether a call or a form is in progress.

### Cause 4 — Smaller automatic reloads and sign-outs

- **Pull-to-refresh** (`src/App.tsx`): a downward swipe at the top of a screen reloads the whole app. It is switched off for the Executive Hub and Landlord Ops, but **still on for other staff screens**, for example `/tenant-ops/workspace` and the `/dashboard/*` pages. The code comment itself says "a stray pull-to-refresh inside a long panel reloads the whole app mid-task".
- **Slow start auto-retry** (`src/main.tsx`): if the app has not appeared after 10 seconds it reloads itself with growing delays, up to 4 times. In the last 14 days the app logged **2,692 "startup-timeout-slow"** events and 118 "app-load-failed". This one only happens while opening the app, but it adds to the feeling of "the system keeps refreshing".
- **Session expiry** (`src/hooks/useAuth.tsx`): when the sign-in can no longer be renewed, the app sends the person to the sign-in page with a hard redirect. It holds off while the tab is hidden or the phone is offline, but does it as soon as the tab is visible.

### Cause 5 — Things that end a call even without a refresh (call-specific)

In `src/hooks/useCrmVoiceCall.ts` and `src/lib/atVoiceClient.ts`:

- If the voice service reports "not ready" (a brief registration drop, for example a network blip), the code **throws the voice connection away, which hangs up a live call**.
- If it reports "offline" or "closed", the call is ended and the officer sees "The voice connection expired" or "Lost the connection to the voice service."
- The voice key is valid for about an hour.

These at least show a message. The refresh-style endings (causes 1 to 3) show **nothing**, which is why officers describe the call as "just disconnecting".

---

## 3. Protection that exists but is not used where it matters

- **A "critical flow" guard already exists** (`src/lib/criticalFlowGuard.ts`) to stop update prompts and cache clearing while a sensitive task is open. It is used only for the agent payment screens and sign-in. The Calling Center, Calling Hub, Landlord Ops calling, awareness call panel and Review Request forms never register themselves with it.
- **No "are you sure you want to leave?" warning** is used for calls (the browser's leave-page warning is used in only a few unrelated places, none of them calling).
- **A small "remember my screen state" helper exists** (`src/hooks/useSessionPersistedState.ts`) but only one Landlord Ops screen uses it. So after any rebuild, tabs, search text and the person's place in a sequence are lost.
- Our own earlier work on the awareness call panel keeps a note of "a call was started" so the form can reopen. Most other screens do not.

---

## 4. What I checked and ruled out

- **Data refetching on tab focus** is off app-wide, so it is not the cause.
- **The service worker does not update the app by itself** (no automatic reload when a new one installs). The old one is cleaned up at start-up.
- **The "new version" toast** only offers.
- **The Calling Center is not on a pull-to-refresh route** (Executive Hub is excluded).
- The sign-in screen's own "loading" flag only turns on once at start-up, so it is not the cause by itself.

## 5. What the database can and cannot tell us

- Last 60 days of browser calls: **110 completed (answered, about a minute on average)**, 173 + 154 + 72 + 30 not answered, **169 "cancelled" with an unknown ender**, and **150 "never placed" closed by the system**.
- A cancelled call and a call dropped by a screen rebuild are written the same way (the screen's clean-up writes "ORIGINATOR_CANCEL" with an "unknown" ender), so **the data cannot prove how many calls were lost this way**. It is consistent with it, not proof of it.
- The error logs do not show cause 1 at all, because a rebuild is not an error. That is why nobody has seen it in a report: **nothing records that it happened.**

## 6. What I could not test

- A real phone or laptop switching apps, a real notification tap, and a weak connection. I reproduced cause 1 in the preview and read the code for the rest.
- I did not place a call or save anything.

---

## 7. What to tell staff in the meantime

- Finish or wrap up a call before switching tabs or apps; keep the call tab in front.
- Avoid tapping a notification while on a call; open it later.
- Do not swipe down at the top of the screen on staff pages.

---

## 8. The fix, as two prompts

The fix is mostly **logic** (sign-in state, permission checks, reload rules, call hang-up rules), which is Claude's lane. Anything that only changes how a loading state looks is Gemini's.

### Prompt 1 — Stop the rebuild, and protect live work

```
READ CLAUDE.md first. Logic and hooks only. HARD RULE: do not change any approve, reject, verify, decline or
payment behaviour, any pipeline status, the ledger or wallets, or the call recording rules (crm_* functions).
Do not restyle anything; if a loading look must change, tell me and leave it for Gemini.

Problem: staff lose their screen (and a live Calling Center call is hung up) every time they come back to the
tab. Cause: useAuth stores a new user object on every SIGNED_IN / TOKEN_REFRESHED event; useStaffPermissions
re-runs on that new object and sets loading back to true; ExecutiveHub then returns <ScreenLoader /> and the
whole dashboard unmounts. RoleGuard has the same pattern for routes with requiredPermission. The call hook
(useCrmVoiceCall) hangs up when its screen unmounts.

1. useAuth: when an auth event carries the same user id and the same access token as the state already held,
   do NOT replace user/session (keep the same object). Only update on a real change (different user, new
   token, user data changed). Keep every existing sign-out and redirect behaviour as it is.
2. useStaffPermissions: depend on user?.id and a stable roles key (joined string), not on object identity.
   Only report loading=true on the FIRST load (when there is no answer yet). When the answer is refreshed in
   the background, keep the old permissions on screen and swap quietly. Keep "fail closed" on error.
3. ExecutiveHub and RoleGuard: show the full-screen loader only while there is no permission answer at all.
   Never replace an already-open dashboard with the loader during a background refresh.
4. Register live work with the existing criticalFlowGuard: while a Calling Center / Calling Hub (tenant and
   landlord) call is connecting or live, while a call outcome is waiting to be saved, and while an awareness
   call form is open or a Review Rent Request sheet has unsent text. Make sure BuildUpdateWatcher and other
   prompts already stand down for it.
5. While a call is live, add a browser "leave this page?" warning (beforeunload) so a reload, a tab close or a
   pull-down is not silent.
6. Keep each screen's view state (active tab, filters, current queue position, open row) with the existing
   useSessionPersistedState helper in the Tenant Ops Classic shell, Calling Center, Calling Hub and Landlord Ops
   so a rebuild never sends someone back to the start.
7. Record WHY a live call ended: add an ended reason when the screen goes away (for example 'screen_removed')
   to the existing finalise path without changing its outcome rules, so we can count real cases afterwards.
8. Tests: a same-user SIGNED_IN does not change the user object; permissions do not flip to loading on a
   background refresh; ExecutiveHub keeps its children while permissions refresh; the call screen is not
   unmounted by an auth event. Run npm run guard:all.
9. Verify in the signed-in preview as the Tenant Ops user: open Awareness Calls, mark a heading element, let the
   tab flip hidden/visible several times, and confirm the element is never removed and the loader never
   appears. Report the numbers. Do NOT place or save a real call; if a live call is needed to prove the call
   stays up, stop and ask me.
Plain wording only: "Rent Plan", "Supporter", "Returns".
```

### Prompt 2 — Stop the silent reloads, and make future cases measurable

```
READ CLAUDE.md first. Logic and hooks only. HARD RULE: no change to approvals, rejections, payments, the
ledger or any pipeline status. Do not restyle; wording and look of any banner are for Gemini.

Problem: several places reload or navigate the whole page without asking, with no check for a call or a form
in progress: lazyWithRetry (reloads after 3 failed section loads), ChunkErrorBoundary (rebuilds the whole app
for any error whose trace mentions an app file), FinancialOpsCommandCenter, the push notification click
handler in public/sw.js (client.navigate on the open tab), pull-to-refresh on staff routes not in
PTR_DISABLED_PREFIXES (for example /tenant-ops/workspace and /dashboard/*), the slow-start auto-retry in
main.tsx, and the hard redirect to /auth on session expiry.

1. Add one small helper, for example safeReload(reason), used by every automatic reload above. It must: do
   nothing and show the existing "new version ready" style prompt instead when isCriticalFlowActive() is true
   (or a call is live); otherwise save the reason and a time in sessionStorage and reload.
2. lazyWithRetry / lazyNamed: reload only for a genuine stale-file case, not for a plain network failure;
   when a flow is active, show the existing stale-chunk card instead of reloading.
3. ChunkErrorBoundary.classifyChunkError: stop treating "stack contains an /assets or /src path" as a chunk
   error; keep the explicit message matches only. Do not rebuild the whole app for an ordinary error.
4. Notification clicks: change the service worker so it does NOT navigate a busy tab. Post a message to the
   open tab; the app receives it and moves to the link with the in-app router (no page load), or, if a flow is
   active, opens the link in a new tab. Keep the branded-URL rules in sw.js unchanged.
5. Pull-to-refresh: turn it off for every staff route (tenant-ops, executive-hub, landlord-ops, agent-ops,
   coo, cfo, admin, hr, crm and the /dashboard/* staff dashboards). Keep it only where it already helps (public
   and tenant pages).
6. Session expiry: when a flow is active, show a prompt "Your session ended. Save your work, then sign in
   again" instead of redirecting at once; redirect after the flow closes.
7. Reload reasons: on app start, read any saved reload reason, send it to user_telemetry_events as
   event_type 'app_reload' with the reason, route and role, then clear it. This lets us measure each cause
   afterwards. Add a short section to docs/TOPS_BUILD_LOG.md.
8. useCrmVoiceCall / atVoiceClient: on a 'notready' event while a call is live, do not discard the client (that
   hangs the call up); only discard it when no call is live. Keep the 'offline' and 'closed' handling.
9. Tests for safeReload (blocked during a flow, allowed otherwise), classifyChunkError, the PTR route list and
   the notification message handling. Run npm run guard:all. Verify in the preview as the Tenant Ops user that
   pulling down or a simulated stale-file error while a call screen is "live" no longer reloads. Do NOT place
   or save a real call.
Plain wording only: "Rent Plan", "Supporter", "Returns".
```

Do Prompt 1 first: it removes the everyday cause. Prompt 2 closes the rarer causes and gives us numbers.

---

## 9. Appendix — where each item lives

| Item | File |
|---|---|
| Dashboard rebuilt on every "signed in" | `src/hooks/useStaffPermissions.ts`, `src/pages/ExecutiveHub.tsx`, `src/components/auth/RoleGuard.tsx`, `src/hooks/useAuth.tsx` |
| Call hangs up when its screen is removed | `src/hooks/useCrmVoiceCall.ts` (clean-up on unmount), `src/lib/atVoiceClient.ts` |
| Call dropped on "not ready", "offline", "closed" | `src/hooks/useCrmVoiceCall.ts` |
| Notification tap navigates the open tab | `public/sw.js` (notificationclick) |
| Silent reload for old files | `src/lib/lazyWithRetry.ts`, `src/components/ChunkErrorBoundary.tsx`, `src/components/financial-ops/FinancialOpsCommandCenter.tsx` |
| Pull-to-refresh | `src/App.tsx` (PTR_DISABLED_PREFIXES, handlePullRefresh) |
| Slow-start auto retry | `src/main.tsx` |
| Session expiry redirect | `src/hooks/useAuth.tsx` |
| Existing protection not applied to calls | `src/lib/criticalFlowGuard.ts` (used only by agent payment screens and sign-in) |
| State helper used in one place | `src/hooks/useSessionPersistedState.ts` |
