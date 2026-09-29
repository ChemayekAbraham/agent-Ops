# 160. "Write permission denied." on agent phones: clipboard fallback; TID-float refusals are the rule working (2026-09-29)

**Status:** Fixed in code 2026-09-29, frontend only. Goes live on the next Lovable publish.
**This is issue #4** from the Agent Collections Monitor pass (docs 158, 159).

## A. "Write permission denied."

- **What:** `client_error_reports`, `source: unhandled-rejection`, `/dashboard/agent`. All 9 since
  2026-09-23 come from one agent, Mwaka Isaac (`8853f6f4…`), on Chrome 111 / Android 10.
- **Not ours:** the string is Chromium's `NotAllowedError` text for a refused
  `navigator.clipboard.writeText()`. The earlier "Document is not focused." row is the same API.
- **Why it matters:** there are 164 `writeText` call sites and many have no `catch`. Most toast "Copied!" regardless, so the
  agent pastes nothing. The likely hit is copying the MoMo merchant code in `DepositFlow`, and this same agent
  is being refused collections for having a TID-backed balance of 0.
- **Fix:** `src/lib/clipboardFallback.ts`, installed first thing in `src/main.tsx`. It patches
  `navigator.clipboard.writeText` once. If the native call is rejected, it retries with the legacy
  hidden-textarea + `execCommand('copy')` path and only rejects if that fails too. Devices with no async API
  get the legacy path. The 164 call sites are unchanged.
- **Verify after publish:** no new `Write permission denied.` / `Document is not focused.` rows.

## B. `INSUFFICIENT_TID_BACKED_FLOAT` (12 in the last 2 days)

This is the hard rule of 2026-09-21 (only Gmail-matched TID deposits may fund tenant rent collection)
working as designed: every refusal has `requested > TID-backed balance`, and nothing is broken. Worth knowing: about half
are short by under UGX 300 (e.g. 6,962 vs 6,984; 20,966 vs 21,000), because the agent tries the full daily
amount against a nearly-exhausted TID balance. Allowing a partial collection up to the TID balance would be a product change
to the collection rule and has **not** been made.
