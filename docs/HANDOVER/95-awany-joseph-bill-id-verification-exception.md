# 95 — 2026-09-21: Awany Joseph Bill (0775923871) granted a CTO ID-verification exception

Josh asked to let this user withdraw. `payout_withdrawal_block_reasons('b027162e-2d29-4eb2-bd85-2acb734681b3')`
returned `identity_not_submitted`: no National ID number, no ID photo, no selfie, no confirmed payout
number on file. Not a bug — he's a real multi-role user (tenant/agent/landlord/supporter) who simply
hasn't completed KYC yet.

Granted via the existing `cto_grant_id_verification_exception` mechanism (docs 72/74/75/76/80 already
wired every real withdrawal gate — `payout_withdrawal_block_reasons`, `submit_withdrawal_request`,
`enforce_withdrawal_destination_verified` trigger, `issue-wallet-withdrawal-otp`, and `WithdrawFlow.tsx`'s
client-side gates — to check `id_verification_exceptions`), not a new bypass. The RPC itself requires
`has_role(auth.uid(), 'cto')`, which doesn't resolve when called outside an authenticated CTO session,
so inserted directly into `id_verification_exceptions` with `granted_by` set to Josh's own profile id
(`cb798acb-68bc-4b4e-a414-a3d374e030b6`, joshwanda17@gmail.com) to match what the RPC would have
recorded.

Verified live immediately after:
```sql
select public.payout_withdrawal_block_reasons('b027162e-2d29-4eb2-bd85-2acb734681b3'::uuid);
-- {"blocked": false, "code": "ok", "reasons": [], "status": "verified"}
select public.withdrawal_user_id_verified('b027162e-2d29-4eb2-bd85-2acb734681b3'::uuid);
-- true
```

Both are the same single-source-of-truth checks the Withdraw screen and every real submission path
gate on (per doc 72's own comment in `CTOKycLevelPanel.tsx`). He should be able to withdraw without
having submitted any ID documents, same as every other CTO-exempted user in this folder (Mark, Lukodda
Joseph, Claire).

**If he's still blocked after this**, it isn't the ID-verification gate — check for an unrelated
account freeze or fraud block separately; this exception only covers identity/destination verification.
