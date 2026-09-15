# Grandfather the payouts already waiting, without weakening the rules

## What I found (verified in the live system)

The message

> "This payout destination is not verified. Open Financial Ops → Verify Payout Numbers, call the holder to confirm the number and the National ID name, then approve this payout."

is produced in exactly **one** place: the payout approval function, at the check that runs just before the money is released. Confirm Paid calls that function, gets this refusal back, and stops. Nothing in the app itself blocks the button — the refusal is entirely server-side, which is why it cannot be worked around from the screen.

That check asks a database helper whether the phone number or bank account has a verified record. **It does not look at the existing exemption table at all.** That exemption table is only consulted by the separate identity gate that governs whether a merchant can *see and claim* a payout — which is why Lillian Kabahuma's proxy requests became claimable but still refuse at payment time.

Current live counts for status `pending`: 103 requests, of which **90** have an unverified payout destination (82 of the pending ones are proxy requests). Oldest pending: 12 Sep 2026; newest: today.

Separately, the identity gate that controls claiming lives in two row-security rules on the requests table plus two backend routines. The 6 requests that fail that gate need a second, narrower touch (Step 2) — otherwise they stay invisible/unclaimable even after Step 1.

## The approach

An explicit **per-withdrawal** grandfather list, filled once at implementation time from the requests that are already pending at that exact moment. Nothing user-wide, nothing destination-wide, and **no payout destination is ever marked verified** — the verification records are not touched, so every request created after the cutoff still goes through the full phone/bank + National ID checks.

The list is frozen by construction: rows are only ever inserted by the one-off snapshot, referencing specific request IDs that already existed. A payout created a minute after the cutoff cannot appear in it.

Each row stores its own audit: which request, the cutoff moment, who authorised it, the written reason, plus a snapshot of the destination and amount as they stood — so an auditor can later prove exactly which payouts were released under the amnesty and what they looked like at the time.

## Steps

1. **Add the grandfather list and its snapshot** (additive, one migration).
2. **Make the payment check honour it** — the destination gate accepts a payout whose request ID is on the list, and records in the payout's audit trail that it was released under the grandfather amnesty rather than under verification.
3. **Optional, only for the 6 blocked by the identity gate** — extend the claim/visibility gate to also accept a request on the grandfather list, so those payouts can be claimed and paid at all.
4. **Report** the exact count released and leave the list read-only afterwards.

## Technical detail

**Files / objects to change**

- New migration: table `public.withdrawal_verification_grandfather`
  - `withdrawal_id uuid PRIMARY KEY REFERENCES withdrawal_requests(id)`
  - `cutoff_at timestamptz NOT NULL` (identical on every row — the amnesty moment)
  - `created_by uuid`, `created_at timestamptz default now()`, `reason text NOT NULL` (10+ chars, per audit convention)
  - snapshot columns: `snapshot_status text`, `snapshot_payout_method text`, `snapshot_destination_key text`, `snapshot_amount numeric`, `snapshot_user_id uuid`
  - `GRANT SELECT TO authenticated`, `GRANT ALL TO service_role`; RLS enabled; SELECT policy for withdrawal staff only; **no INSERT/UPDATE/DELETE policy** — the list is unwritable from the client, and immutable after the snapshot.
  - Backfill in the same migration: `INSERT INTO ... SELECT id, <cutoff>, ... FROM withdrawal_requests WHERE status = 'pending' AND created_at <= <cutoff>` with an explicit literal cutoff timestamp, plus an `audit_logs` entry recording the amnesty.
- New helper `public.withdrawal_is_verification_grandfathered(p_withdrawal_id uuid)` — `STABLE SECURITY DEFINER`, `SET search_path = public`, returns true only for an exact request-ID match.
- `supabase/functions/approve-withdrawal/index.ts`, the destination gate at ~line 641: call the helper first; when true, skip the refusal and stamp the release reason (`grandfathered_pre_cutoff`) into the audit metadata the function already writes. This is the only edit in that file.
- Step 2 only: `public.withdrawal_merchant_id_gate(...)` gains one additional `OR` on the helper. Because both row-security rules and the two claim routines call that single wrapper, that one change covers all four call sites — no policy is rewritten.

**Untouched:** `payout_destination_verifications`, `payout_destination_is_verified`, `enforce_withdrawal_destination_verified` (insert-time gate on new requests), `withdrawal_id_gate_exemptions`, and every wallet/ledger path.

**Risks**

- The 90 payouts are released to numbers nobody called to confirm. That is the explicit intent of the amnesty; the grandfather list is the record of it. Worth deciding whether the amnesty should exclude unusually large amounts.
- A pending request whose destination is *edited* after the cutoff would still be grandfathered by ID. Mitigation: the destination-key snapshot lets the gate compare the stored key to the current one and refuse if it changed. Recommended, cheap, and keeps the amnesty honest.
- Two of the pending rows are neither destination-unverified nor identity-blocked; they are stuck for another reason and will not be fixed by this.
- Grandfathering must be run once. A second run with a later cutoff would silently extend the amnesty; the primary key and the immutable table make repeat inserts a no-op for existing rows, but a fresh cutoff should require a deliberate, separately approved migration.
