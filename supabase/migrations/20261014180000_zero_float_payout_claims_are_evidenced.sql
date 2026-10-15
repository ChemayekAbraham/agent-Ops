-- Zero-float payout claims count as evidenced (doc 228).
--
-- v_merchant_oop_evidence marked a claim evidenced only when finance attested
-- it or the desk's float at the payout's timestamp was strictly NEGATIVE.
-- A desk with no float is at exactly 0, and a payout debits nothing from a
-- desk with no float, so its position never goes negative: every payout made
-- with zero float stayed "under review" forever, contradicting the rule that a
-- payout made before float arrives is the agent's own money (Josh, 2026-10-05).
--
-- Change: position <= 0 now counts as evidenced, and at exactly 0 the whole
-- shortfall is the evidenced amount (the old cap, -position, would give 0).
-- Negative positions keep the existing cap. Positive positions are untouched,
-- so claims float actually covered stay under review. Telecom-kind claims
-- without a provider reference are still `is_estimate` and still excluded from
-- payable; that rule is not changed here.
--
-- Blast radius: the view feeds get_merchant_out_of_pocket_summary and
-- settle_merchant_out_of_pocket, and is shared by every desk. Measured before
-- writing: Immaculate (BAITA) +8,889,000 principal; across all desks 21 rows,
-- UGX 20,385,681 on 3 desks move from under review to payable.
--
-- Same columns, same order (CREATE OR REPLACE VIEW). Only the two marked
-- expressions differ from the live definition (read 2026-10-14).

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
    o.kind = 'telecom'::text AND COALESCE(o.evidence ->> 'telecom_charge_ref'::text, ''::text) = ''::text AND COALESCE(o.evidence ->> 'finance_attested'::text, ''::text) <> 'true'::text AS is_estimate,
    -- doc 228: was `< 0::numeric`
    COALESCE(o.evidence ->> 'finance_attested'::text, ''::text) = 'true'::text OR merchant_float_position_at(o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) <= 0::numeric AS is_evidenced,
        CASE
            WHEN COALESCE(o.evidence ->> 'finance_attested'::text, ''::text) = 'true'::text THEN o.shortfall_amount
            -- doc 228: zero float at payout => the whole shortfall is her own money
            WHEN merchant_float_position_at(o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) = 0::numeric THEN o.shortfall_amount
            ELSE LEAST(o.shortfall_amount, GREATEST(0::numeric, - merchant_float_position_at(o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at))))
        END AS evidenced_amount
   FROM merchant_out_of_pocket_advances o
     LEFT JOIN withdrawal_requests w ON w.id = o.withdrawal_id
     LEFT JOIN profiles p ON p.id = w.user_id;
