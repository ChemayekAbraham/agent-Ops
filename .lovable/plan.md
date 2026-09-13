# Verified payout destinations before any withdrawal

Nobody withdraws to a phone number or bank account that Financial Ops has not personally verified, and every wallet holder with money to withdraw must have a National ID whose name matches that destination.

## 1. A verification record for every payout destination

A new record per destination (mobile money number or bank account) holding: the owner, the number/account, the name on it, the National ID number and the name on the ID, the state (waiting, verified, rejected), who verified it, when, the call outcome, and a written basis of at least 10 characters. Destinations already used in past withdrawals are loaded in as "waiting" so the queue starts from real data — no past withdrawal is undone.

A destination is verified only by a Financial Ops action. Nothing auto-verifies. Rejecting requires a reason. Changing the number or the name on a verified destination puts it straight back to waiting.

## 2. The withdrawal gate

The withdrawal request is refused unless the exact destination being paid is verified for that user. This is enforced in three places that must agree, matching how the existing balance gate is built:

- the withdrawal request function the app calls
- the trigger that guards new withdrawal rows
- the approval path used by Financial Ops

The refusal message is plain: "This number is not yet verified. Financial Ops will call you to confirm it belongs to you." The withdraw screen shows the same message with the destination's state next to each saved destination, so people see it before they try.

## 3. National ID capture, prompted

Wallet holders are asked for their National ID number and the name exactly as it appears on the ID. Everyone with a withdrawable balance sees a prompt they cannot dismiss permanently until it is submitted; it appears on the wallet card and inside the withdraw flow.

The system compares the ID name against the mobile money name / bank account name and shows Financial Ops a match score plus the differing words. A mismatch never blocks by itself and never auto-passes — Financial Ops decides.

## 4. The Financial Ops pane

A new top item in the Financial Ops dashboard, placed above everything else with a live count of destinations waiting, called "Verify Payout Numbers".

Built for a phone in the field:

- one card per waiting destination: person's name, the number or account, the name on the number, the National ID number and name, the match indicator, and their withdrawable balance
- a large tap-to-call button on the person's number, plus a second call button for the number being verified when it differs
- Verify / Reject buttons with a required written basis, and a note field for what the call established
- search by name, number, or National ID; oldest-waiting first, with an option to sort by largest balance so the biggest exposure is cleared first
- filter chips: waiting, verified, rejected, name mismatch, no National ID
- twenty per page with clear paging, large touch rows, and the same font-size control used on the landlord pages

A second read-only tab shows everything already decided, with who decided it and when.

## 5. What people see on their side

Each saved destination on the withdraw screen carries its state: Waiting for verification / Verified / Rejected with the reason. A verified destination shows a small tick. The wallet card shows one line when a withdrawal is currently blocked and why.

## Technical notes

- New table `payout_destination_verifications` with GRANTs, RLS (owner reads own; Financial Ops, CFO, super_admin read and act) and a unique key per user per normalised destination. Phone matching uses the last 9 digits, consistent with the rest of the platform.
- Verification and rejection go through SECURITY DEFINER functions that re-check the role, log to `audit_logs` with the mandatory reason, and emit a `system_events` row plus a trust-score signal, per the platform rules.
- National ID capture writes through a function, not a direct table write; the ID number keeps the existing unique 10–14 character rule.
- Name matching runs in the database as a helper returning a score and the differing tokens, so the app and the gate agree.
- No changes to balance definitions, ledger rules, or existing payroll tables. No withdrawal already approved is affected.
