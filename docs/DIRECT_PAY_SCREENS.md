<!--
Author: SSENKAALI PIUS
Email: ssenkaali.pius@welileapp.com
Date: 2026-11-13
Website: welileapp.com
-->

# Pay the landlord directly (self-support option 2): screens brief

A partner pays a Rent Plan's rent from their own phone to the landlord's verified number and uploads the SMS. Landlord Ops call the landlord, the landlord reads back an OTP, and Landlord Ops approve. Only then is the partner's portfolio created and their Rent Profit Share starts. No rent passes through Welile.

Full plan, with the example and every message: <https://claude.ai/artifact/C3ihdjpASTDLXwGnLrCsYs>

## Rules for these screens

- **Do not apply the migrations** `20261121090000` to `20261121130000`. Claude applies them to production after the owner's yes. Everything is behind the switch `self_support_direct_pay`, which is OFF: until it is on, `direct_pay_claim` answers `not_available`. Build the screens to show that state politely.
- **All logic is in the database.** Screens only display what the hooks return. Never compute amounts, flags or eligibility in the browser.
- **Use only these hooks and helpers:**
  - `src/hooks/useDirectPay.ts`
  - `src/lib/directPay.ts`
- **Every refusal has a code:**
  - for the partner, `directPayMessage(result)` gives the exact sentence to show;
  - for Landlord Ops, use `directPayDecisionMessage(result)`.
- **Words:** say "Rent Plan", "Rent Profit Share" and "Cover fee" (the 2% fee). Never say "loan", "interest", "ROI" or "Agent Care".
- **Support number on screens:** `DIRECT_PAY_SUPPORT_PHONE` (+256 748 747134).

## 1. Partner: choosing option 2

- **Where:** on a Rent Plan the partner can fund, next to the existing wallet option, add **"I'll pay the landlord myself"**. It is for single-partner Rent Plans only; don't show it for co-support or empty houses.
- **Tap:** `useDirectPayClaim().mutate(rentRequestId)`.
  - **Result is a payment view** (`isDirectPayView`): go to the held screen.
  - **Result is a refusal:** show `directPayMessage(result)`. For example, `float_short`: "Add UGX 10,000 to your operational float for the 2% Cover fee."; `taken`: the plan was just taken.
- **After a claim:** the plan disappears from every other partner's list (the hook refreshes the lists).

## 2. Partner: the held plan

Data: `useMyDirectPayments()` returns live payments first. Each one is a `DirectPayView`.

- **Show:**
  - the tenant's first name;
  - **landlord name and number** (`landlord_number`, the verified number: make it easy to copy);
  - the amount to send (`amount_due`);
  - the Cover fee being held (`cover_fee`);
  - a countdown from `holdTimeLeft(hold_expires_at)`.
- **Before they pay, say:** "Only UGX 500,000 counts. Anything extra stays between you and the landlord." (Use the real amount.)
- **Upload SMS:**
  - photo picker (camera or gallery);
  - optional "Transaction ID" field;
  - MTN / Airtel choice;
  - an "Amount" field shown only after a result with code `amount_missing`.
- **Submit:** `useDirectPayUploadProof().mutate({ paymentId, rentRequestId, photo, tidTyped, amountTyped, provider })`. The result has a status and a code:
  - **`status: 'held'`, code `amount_short`:** show `directPayMessage` ("You sent UGX 450,000 … Send UGX 50,000 more … and upload that SMS too.") and keep the upload button.
  - **`status: 'pending'`:** "We got your proof. Our team will call the landlord to confirm."
  - **Any other code:** show `directPayMessage(result)`.
- **Proofs list:** amount and last 4 of the TID for each SMS uploaded (`proofs`).
- **"Let go of this plan"** (only while `status === 'held'` and no proofs): `useDirectPayRelease()`.
- **"I topped up my float"** (after `float_short`): `useDirectPayRefresh().mutate(paymentId)`.
- **Status chips:**
  - held: "Waiting for your SMS";
  - pending: "With Landlord Ops";
  - confirmed: "Active: Rent Profit Share started";
  - rejected: "Not confirmed by the landlord";
  - expired: "Hold ended".

## 3. Landlord Ops view (new route; Landlord Ops act, the COO sees it read-only)

- **Who can open it:** `landlord_ops`, `coo` and `super_admin`. Only `landlord_ops` sees the action buttons: `can_act` on every page says whether this user may act.
- **Data:** `useDirectPayQueue('pending')`, an infinite list (`fetchNextPage`), flagged rows first. A second tab uses `useDirectPayQueue('decided')`.
- **Photos:** collect every `proofs[].photo_path` on the loaded pages and call `useDirectPayProofPhotos(paths)` once. It returns a map from path to signed link. Never request one photo at a time.
- **Each row shows:**
  - partner (name, phone);
  - tenant;
  - agent;
  - landlord: name, **phone on file** (the number to call) and verified number;
  - amount due and received;
  - waiting time, with a red "Over 24 hours" when `over_24h`;
  - flags as red chips, using `DIRECT_PAY_FLAG_LABEL`;
  - each proof: photo, amount read or typed, TID read or typed, number read, date read.
- **Approving, in this order on the card:**
  1. "Call landlord": a `tel:` link to `landlord.phone_on_file`.
  2. **Send OTP:** `useDirectPaySendOtp().mutate(paymentId)`. Show "Code sent to ***456, valid 10 minutes" from `sent_to` and `expires_at`. If `ok` is false, show "The SMS did not go through. Try again."
  3. **Code field:** the 6 digits the landlord reads out.
  4. **Call note:** required.
  5. **Reason:** required only when the row has flags. Label it "Why is it safe to approve?".
  6. **Approve:** `useDirectPayApprove().mutate({ paymentId, otp, callNote, flagReason })`.
     - **`ok`:** show the receipt (`receipt_number`) and "Portfolio active, repayments start tomorrow".
     - **Not `ok`:** show `directPayDecisionMessage(result)`. For example, `otp_wrong`: "That code is wrong. 2 tries left."
- **Reject:** asks for a reason, then `useDirectPayReject().mutate({ paymentId, reason })`.
- **COO:** the same list with no buttons.

## 4. Agent: landlord receipt for a directly paid plan

- **Data:** `useDirectPayAgentItems()`. Show it on the agent's dashboard next to their landlord payouts.
- **Each item shows:**
  - "Paid by partner {partner_first_name}";
  - tenant;
  - landlord;
  - amount;
  - the WLR receipt as a link (`welileReceiptUrl(receipt_code)`).
- **When `needs_landlord_receipt`:** a field for the number on the landlord's signed receipt and an optional photo. Upload the photo to the agent's own folder, then call `useDirectPayRecordLandlordReceipt().mutate({ paymentId, receiptNumber, photoPath })`. For code `receipt_number_invalid`, say: "Enter the receipt number exactly as written (3 to 50 characters)."
- **Never** show the agent a "pay the landlord" button for these plans. The database also refuses any payout for them.

## 5. One wording change

`src/components/partner/AgentCareNote.tsx` still says "Agent Care included" and "Welile Field Care". The owner renamed the 2% to **Cover fee** (13 Nov 2026), so update that copy to say "Cover fee". Keep the rest of the sentence's meaning.

## Messages the partner, agent and tenant receive

These go out automatically by SMS and email (Phase 4). The screens don't send them. Wording is in the plan doc.
