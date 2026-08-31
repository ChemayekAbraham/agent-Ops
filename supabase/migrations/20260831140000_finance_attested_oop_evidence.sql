-- Allow Finance to attest an obligation the books cannot corroborate.
--
-- WHY. `v_merchant_oop_evidence.is_evidenced` is derived purely from
-- `merchant_float_position_at` at the payout's own timestamp: the desk must
-- reconstruct negative for the claim to count as payable. That is the right
-- default -- a merchant's own cash never touches the wallet ledger, so a
-- shortfall in the books is the only independent corroboration available.
--
-- It cannot express the case Finance closed out on 2026-08-31, however: money
-- moved to an agent entirely outside the system, leaving no ledger trace at
-- all, with the agent holding the physical receipts. The books will never
-- evidence such a transaction, so `is_evidenced` is permanently false and the
-- obligation can never reach the payable bucket, no matter how well attested it
-- is by Finance and by paper.
--
-- WHAT CHANGES. An advance carrying `evidence->>'finance_attested' = 'true'`
-- counts as evidenced for its full `shortfall_amount`. The source document is
-- named in `evidence` alongside the flag, so the basis of every attested
-- obligation stays on the row and is visible in the settlement dialog.
--
-- This does NOT weaken the ledger gate for ordinary claims. A claim derived
-- from a payout still has to reconstruct a negative desk position; only a row
-- Finance has explicitly attested bypasses it, and only a finance role can
-- write `evidence` (the table is not writable from the client -- see
-- scripts/guard-frontend-ledger-writes.mjs).
--
-- The flag is compared as text rather than cast to boolean so a malformed
-- value can never raise inside the view.

CREATE OR REPLACE VIEW public.v_merchant_oop_evidence AS
 SELECT o.id AS advance_id,
    o.agent_id,
    o.withdrawal_id,
    o.kind,
    o.status,
    o.shortfall_amount,
    o.payout_amount,
    o.telecom_charge,
    o.float_used,
    o.note,
    o.evidence,
    o.created_at,
    o.attested_at,
    o.reviewed_at,
    o.reimbursed_at,
    COALESCE(w.processed_at, w.updated_at, o.created_at) AS payout_at,
    w.transaction_id AS payout_tid,
    COALESCE(w.mobile_money_name, w.bank_account_name, p.full_name) AS recipient_name,
    COALESCE(w.mobile_money_number, w.bank_account_number, p.phone) AS recipient_phone,
    w.mobile_money_provider AS provider,
    w.amount AS withdrawal_amount,
    merchant_float_position_at(o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) AS float_position_at_payout,
    -- A finance-attested obligation is never an "estimated" telecom charge.
    o.kind = 'telecom'::text
      AND COALESCE(o.evidence ->> 'telecom_charge_ref'::text, ''::text) = ''::text
      AND COALESCE(o.evidence ->> 'finance_attested'::text, ''::text) <> 'true'::text AS is_estimate,
    -- Evidenced either by the books, or by an explicit Finance attestation.
    COALESCE(o.evidence ->> 'finance_attested'::text, ''::text) = 'true'::text
      OR merchant_float_position_at(o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) < 0::numeric AS is_evidenced,
    CASE
      WHEN COALESCE(o.evidence ->> 'finance_attested'::text, ''::text) = 'true'::text
        THEN o.shortfall_amount
      ELSE LEAST(o.shortfall_amount, GREATEST(0::numeric, - merchant_float_position_at(o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at))))
    END AS evidenced_amount
   FROM merchant_out_of_pocket_advances o
     LEFT JOIN withdrawal_requests w ON w.id = o.withdrawal_id
     LEFT JOIN profiles p ON p.id = w.user_id;
