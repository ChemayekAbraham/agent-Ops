# 252. Renewal confirmation-code step vanished when the tenant profile reloaded (2026-11-02)

**Status: CODE CHANGE ONLY, NOT DEPLOYED.** Frontend state fix in `src/components/agent/TenantProfileView.tsx`. No database change.

## Report
Yaseen Kc (agent) said the page reloads on the last step of a renewal, while he taps Renew.

## Cause
`TenantProfileView` returns a full-screen spinner while `loading` is true, and the renewal dialogs (`renewalFlow.dialogs`)
are rendered after that return. Two paths set `loading` while a renewal was in progress:
1. The mount effect depends on `[tenantId, user?.id]` and called `loadFullProfile()` (non-silent). When the session
   re-resolves (token refresh, returning from the SMS app to read the tenant's code), `user?.id` changes, the spinner
   shows, and the open confirmation-code dialog is unmounted. The renewal promise is left pending and nothing is submitted.
2. After a successful `renew_rent_request`, `loadFullProfile()` (non-silent) swapped the whole view for a spinner.

## Fix
- The effect remembers the tenant already on screen (`loadedTenantRef`) and refreshes silently when only `user?.id` changed.
- The post-renewal refresh is silent.

## Not changed (same pattern, not reported)
`loadFullProfile()` is still non-silent after a collection (`AgentTenantCollectDialog.onSuccess`) and after reversing an allocation.

## Verify
Open a completed tenant, start Renew, reach the code box, background the app for 30s, return: the code box must still be open.
