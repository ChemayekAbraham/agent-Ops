# Voice Calling API — Engineer Integration Guide

**Audience:** engineers adding calling to any part of the app (CRM dashboard, Calling Hub, ops tools, future surfaces).
**Provider:** Africa's Talking Voice.
**Status:** Production. Outbound-only, outbound-bridged ("call centre") model — see below.

---

## 1. What this API does (and does not do)

The voice system lets an authenticated, authorized staff member place a phone call
to any platform user (tenant, landlord, agent, supporter, …) **without ever seeing
or handling a raw phone number on the client**, and every call is recorded.

Two call transports exist:

| Mode | How it works | Use when |
|---|---|---|
| **Handset bridge** (default) | Africa's Talking rings the **staff member's own phone** first. When they pick up, the system bridges that leg to the customer via `<Dial/>`. | Field ops, CRM staff on mobile, no mic/headset |
| **Browser WebRTC** | The staff member's **browser** becomes a soft-phone (mic + speaker) using a short-lived capability token. | Desk agents in the Calling Hub |

What the system deliberately does **not** do:

- **No inbound calls / IVR.** `crm-voice-callback` rejects any inbound leg. Don't build inbound features against it.
- **No direct dial of arbitrary numbers from the client.** Targets resolve server-side from a platform `userId`; a raw `targetPhone` is only a fallback for targets without a profile row.
- **No API key in the browser.** `AFRICASTALKING_API_KEY` lives only in edge-function secrets.

---

## 2. Architecture at a glance

```text
┌────────────┐   POST crm-place-call        ┌─────────────────────┐
│  App UI    │ ───────────────────────────▶ │  Edge function      │
│ (React)    │ ◀──── { callId, status } ─── │  auth + authorize + │
└────────────┘                              │  insert session row │
      │                                     └─────────┬───────────┘
      │ realtime / polling                            │ POST /call
      │ crm_call_sessions                             ▼
      │                                     ┌─────────────────────┐
      │                                     │ Africa's Talking    │
      │                                     │ rings staff handset │
      │                                     └─────────┬───────────┘
      │                                               │ staff answers
      │                                               ▼
      │                                     ┌─────────────────────┐
      │   POST crm-voice-callback (PUBLIC)  │ AT posts events to  │
      │ ◀────────────────────────────────── │ crm-voice-callback  │
      │                                     │ → answers <Dial/>   │
      │                                     │ (bridges customer)  │
      │                                     └─────────────────────┘
      ▼
 Browser reads status/duration/recording from crm_call_sessions

 WebRTC variant:
   POST crm-voice-capability-token → { token, clientName }
   new Africastalking(token)  → browser registers as AT WebRTC client
   client.call(customerPhone) → AT routes the call, callback endpoint
                                records terminal facts the same way
```

### The four edge functions

| Function | Auth | Purpose |
|---|---|---|
| `crm-place-call` | JWT (staff) | Start an outbound handset-bridge call. Creates the `crm_call_sessions` row, rings the staff handset. |
| `crm-hangup-call` | JWT (staff) | Cancel/end a call. Authoritative flag via `crm_cancel_call` RPC + best-effort provider leg drop. |
| `crm-voice-capability-token` | JWT (staff) | Mint a 1-hour AT WebRTC capability token for browser calling. |
| `crm-voice-callback` | **PUBLIC** (Africa's Talking posts here) | Bridges the staff leg to the customer, records status/duration/cost/recording. **You do not call this from the app.** |

All functions live under `supabase/functions/` and follow the project standard:
manual `corsHeaders`, `adminClient.auth.getUser(token)` for auth, JSON responses.

---

## 3. Authorization — who may call

Every staff-facing function runs:

```sql
select public.crm_call_centre_authorized(_user_id := auth.uid());
```

If your feature needs calling for a new role, **extend that RPC's role list** (or
add your own gate) rather than bypassing it. Errors you can receive:

- `401 { "error": "unauthenticated" }` — missing/expired JWT.
- `403 { "error": "not_authorized" }` — signed-in but not a call-centre user.

Also: **the staff member must have a valid phone on their profile** — it is the
number AT rings. If missing, `crm-place-call` returns:

```json
{ "error": "staff_phone_missing",
  "message": "Add your own phone number in Settings before making calls." }
```

Surface this with a link to the Settings → Me page.

---

## 4. Placing a call — `POST /functions/v1/crm-place-call`

### Request

```typescript
const { data, error } = await supabase.functions.invoke('crm-place-call', {
  body: {
    targetUserId: '<uuid>',        // preferred: the platform user to call
    targetName: 'Nakato Grace',    // display name (for the session record)
    targetRole: 'tenant',          // 'tenant' | 'landlord' | 'agent' | ...
    targetLocation: 'Kampala',     // optional, display only
    // targetPhone: '0700123456',  // fallback ONLY when targetUserId is absent
  },
});
```

Notes:

- `targetUserId` **or** `targetPhone` is required. With `targetUserId`, the phone
  is read from `profiles` server-side — never pass a number you could resolve by id.
- Phone normalisation is Uganda-aware: `0700…`, `700…`, `256700…`, `+256700…` all work.
- "Success" means **your handset is about to ring**, not that the customer answered.

### Success response (200)

```json
{
  "callId": "a0c9…uuid of crm_call_sessions row",
  "status": "initiating"
}
```

### Error responses

| HTTP | `error` code | Meaning / UI action |
|---|---|---|
| 400 | `target_required` | Neither `targetUserId` nor `targetPhone` given. |
| 400 | `invalid_target_phone` | Customer number unusable — show "no valid phone number". |
| 400 | `staff_phone_missing` | Caller must add their own number in Settings. |
| 400 | `invalid_staff_phone` | Caller's number not ringable by AT. |
| 401 | `unauthenticated` | Session expired — re-auth. |
| 402 | `voice_insufficient_credit` | Voice account out of credit — alert ops; do not retry-loop. |
| 403 | `not_authorized` | Not a call-centre user — hide calling UI for them. |
| 429 | `provider_throttled` | AT throttling — wait, then retry once. |
| 500 | `could_not_record_call` | DB insert failed — report; the call did NOT start. |
| 503 | `voice_not_configured` | Provider env secrets missing — environment problem. |

**Always read the real body** of a failed invoke (Supabase hides it behind a
generic message):

```typescript
import { FunctionsHttpError } from '@supabase/supabase-js';

if (error) {
  const details = error instanceof FunctionsHttpError
    ? await error.context.text()
    : error.message;
  console.error('place-call failed:', details); // details contains the error code above
}
```

---

## 5. Tracking the call — `crm_call_sessions`

`crm-place-call` inserts a row **before** contacting the provider, so every attempt
(including failures) is auditable. Key columns:

| Column | Meaning |
|---|---|
| `id` | The `callId` you got back. |
| `staff_id` / `staff_phone` | Who placed the call. |
| `target_user_id`, `target_name`, `target_role`, `target_phone`, `target_location` | Who was called. |
| `direction` | `'Outbound'` (inbound is rejected). |
| `status` | See lifecycle below. |
| `at_session_id` | Africa's Talking session id (once known). |
| `answered_at`, `ended_at` | Timestamps. |
| `duration_seconds`, `cost` | Terminal facts (from callback). |
| `recording_url` | Call recording, when enabled. |
| `failure_reason` | e.g. `invalid_target_phone`. |
| `is_active` | True while the leg is live. |
| `cancel_requested_at` | Set by hangup; callback honours it. |

### Status lifecycle

```text
initiating → ringing → bridged → completed
                │         │
                ├→ cancelled (crm-hangup-call)
                ├→ failed / bridge_failed / no_answer … (provider outcomes)
```

Treat any status in the callback's terminal set as final; keep UI state machines
simple — derive display from the row, never trust client-side assumptions.

### Recommended: realtime subscription

```typescript
const channel = supabase
  .channel(`crm-call-${callId}`)
  .on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'crm_call_sessions',
    filter: `id=eq.${callId}`,
  }, (payload) => {
    const s = payload.new.status;
    // update UI: ringing → bridged → completed …
  })
  .subscribe();
```

---

## 6. Hanging up — `POST /functions/v1/crm-hangup-call`

```typescript
await supabase.functions.invoke('crm-hangup-call', {
  body: { callId },   // the crm_call_sessions id
});
```

Response:

```json
{ "cancelled": true, "providerDropped": true, "attempts": [ … ] }
```

Important semantics:

- Cancellation is **two-layered**. Layer 1 flags the session row authoritatively
  (via the `crm_cancel_call` RPC, which is also the ownership check — a user can
  only cancel their own call). Layer 2 asks AT to drop the leg immediately, which
  **only works while AT still queues the leg** — `providerDropped: false` is normal
  and not an error; the flag still guarantees the call ends when the next provider
  event arrives.
- Do not disable the UI waiting for a "provider confirmed" state. Optimistically
  mark the call as cancelling and let the realtime row update confirm it.

---

## 7. Browser (WebRTC) calling

For in-browser calling you need a capability token — the AT API key never ships
to the browser.

### 7.1 Mint a token

```typescript
const { data } = await supabase.functions.invoke('crm-voice-capability-token', { body: {} });
// → { token: string, clientName: string, expiresIn: 3600 }
```

The `clientName` is stable per user (`welile_crm_<userid>`), which is how the
voice callback correlates WebRTC legs back to session rows.

### 7.2 Use the shared singleton client

**Do not** construct the AT SDK yourself. Use `src/lib/atVoiceClient.ts`:

- The SDK opens a WebSocket + WebRTC peer connection at construction time, so the
  client is a **module-level singleton** created once per capability token.
- Events: `ready`, `notready`, `calling`, `callaccepted`, `hangup`, `offline`,
  `closed`, `incomingcall` (inbound will never fire — inbound is disabled).
- `hangup` payloads carry `{ code?, reason? }` (e.g. `NORMAL_CLEARING`,
  `USER_BUSY`, `NO_ANSWER`).

### 7.3 Use the ready-made hook

`src/hooks/useCrmVoiceCall.ts` (`useCrmVoiceCall()`) wraps the whole flow:
token mint → singleton init → place → hangup, exposing a `CallState` union with
`isTerminalCallState(s)` helper and a `VoiceCallTarget` input type. **Start here
before writing your own plumbing** — the Calling Hub (`CallingHub.tsx`,
`MobileCallBar.tsx`) is the reference implementation.

---

## 8. Environment / secrets

Server-side only (set via Lovable Cloud secrets, read with `Deno.env.get`):

| Secret | Purpose |
|---|---|
| `AFRICASTALKING_USERNAME` | AT app username (`sandbox` switches all calls to the sandbox endpoints). |
| `AFRICASTALKING_API_KEY` | AT API key. |
| `AFRICASTALKING_VOICE_NUMBER` | The E.164 number calls originate `from`. |

If any are missing, functions return `503 voice_not_configured`.

The **`crm-voice-callback` URL must be registered** in the Africa's Talking
dashboard as the voice callback for the app:

```text
https://<project-ref>.supabase.co/functions/v1/crm-voice-callback
```

It is a public endpoint by design; it trusts only its own `clientRequestId` /
`sessionId`, never provider-supplied identity fields.

---

## 9. Provider payload quirks (learned the hard way)

- **Token request shapes vary by AT account.** `crm-voice-capability-token` tries
  several known-good payload shapes (string vs boolean `incoming`/`outgoing`
  flags, `expire` vs `lifeTimeSec`, with/without `phoneNumber`) and keeps the
  first that yields a token. If you change it, preserve the fallback loop.
- **`errorMessage: "None"`** from AT is a real response value, not JSON null —
  the error mapper skips it.
- **Call acceptance statuses** are `Queued`, `Success`, or `Ringing` — anything
  else is a rejection, mapped in `crm-place-call`.
- **Never issue a second `<Dial/>`** for an already-handled leg in the callback;
  that produces an endless redial loop. Terminal events return an empty
  `<Response/>`.

---

## 10. Building a new calling surface — checklist

1. **Gate the UI** on the same authorization the backend enforces
   (call-centre roles) and hide calling controls otherwise.
2. **Require the caller's profile phone** before showing "Call" buttons.
3. Call `crm-place-call` with `targetUserId` (never raw numbers you could resolve).
4. Store the returned `callId`; subscribe to its `crm_call_sessions` row for
   status/duration/recording.
5. Wire hangup through `crm-hangup-call` with optimistic UI.
6. Map the error codes in §4 to human-readable toasts.
7. **Record outcomes** in the surrounding workflow (e.g. `cc_call_attempts` in
   the call centre) — telephony rows are the transport record, not your domain record.
8. Test against the **sandbox** first by pointing `AFRICASTALKING_USERNAME=sandbox`
   in a non-production environment.

Reference implementations to copy:
- Handset-first flow: `src/components/CallingHub.tsx`, `src/components/MobileCallBar.tsx`
- WebRTC flow: `src/hooks/useCrmVoiceCall.ts`, `src/lib/atVoiceClient.ts`
- Domain recording: `cc_call_attempts` + `cc_reveal_*` / `cc_record_*` RPCs
