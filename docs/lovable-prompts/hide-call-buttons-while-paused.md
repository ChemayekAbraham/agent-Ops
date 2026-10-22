# Lovable prompt: Hide in-app call buttons while human calling is paused

Our Africa's Talking phone line now belongs to the automated call centre, and calling from the app is **paused on the server**. Please hide the in-app call buttons while it's paused. **UI only.** Don't change any hook, the database or the edge functions.

## Data (already built)
- `useHumanCallingPaused()` from `src/hooks/useCrmVoiceCall.ts` returns `{ paused, reason, paused_at }`.
- While `paused` is true, the server refuses every in-app call anyway: a call attempt fails with "Calling from the app is paused. This line is now used for automated calls." Hiding the buttons avoids that dead end.

## What to change
1. **CRM Call Centre** (`src/components/executive/crm/call-centre/`): in CallCentreOverview, CallCentrePeople and CallCentreHistory, hide every button that opens `CallDrawer` to place a call ("Call", phone icons, redial).
   - Show a small notice at the top of the Call Centre instead: "Calling from the app is paused. This line is now used for automated calls." Add "Paused {relative paused_at}".
   - Keep history, people lists, summaries and the preview/demo mode working.
2. **Tenant Ops Calling Center** (`src/components/executive/tenant-ops/calling-center/`): hide the in-app dial / auto-dial buttons (anything that calls `dialer.dial` or `dialer.startAuto`) and show the same notice.
   - Keep the **"Dial on handset"** (`tel:`) and **WhatsApp** links visible, so staff can still call from their own phones.
   - Keep outcome recording and the reports working.
3. When `paused` is false, everything looks exactly as it does today.

## Copy
Use plain English. Don't say "API", "token" or "IVR".
