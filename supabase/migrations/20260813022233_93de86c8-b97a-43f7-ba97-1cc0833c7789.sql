CREATE OR REPLACE FUNCTION public.get_all_advances_report()
 RETURNS TABLE(advance_id uuid, reference text, advance_type text, recipient_id uuid, recipient_name text, recipient_phone text, amount_requested numeric, amount_approved numeric, amount_paid numeric, outstanding_balance numeric, requested_at timestamp with time zone, approved_at timestamp with time zone, rejected_at timestamp with time zone, paid_at timestamp with time zone, status text, transaction_reference text, notes text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH guard AS (
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.enabled = true
      AND ur.role IN ('cfo','ceo','coo','manager','super_admin','financial_ops')
  ) AS ok
),
aar_ledger AS (
  SELECT gl.source_id,
         max(gl.amount) AS credited_amount,
         min(gl.transaction_date) AS credited_at,
         min(gl.transaction_group_id::text) AS txn_ref
  FROM public.general_ledger gl
  WHERE gl.source_table = 'agent_advance_requests'
    AND gl.category = 'agent_advance_credit'
  GROUP BY gl.source_id
),
cad_ledger AS (
  SELECT gl.source_id,
         max(gl.amount) AS credited_amount,
         min(gl.transaction_date) AS credited_at,
         min(gl.transaction_group_id::text) AS txn_ref
  FROM public.general_ledger gl
  WHERE gl.source_table = 'credit_access_draws'
    AND gl.category = 'wallet_deposit'
  GROUP BY gl.source_id
)
-- 1. Agent advance requests (full approval chain)
SELECT r.id,
       'AAR-' || upper(left(r.id::text, 8)),
       'Agent Advance',
       r.agent_id,
       p.full_name,
       p.phone,
       r.principal,
       CASE
         WHEN r.status IN ('cfo_approved','cfo_paid') OR r.cfo_paid_at IS NOT NULL OR l.credited_at IS NOT NULL
           THEN r.principal
         ELSE NULL
       END,
       CASE
         WHEN r.cfo_paid_at IS NOT NULL OR l.credited_at IS NOT NULL
           THEN COALESCE(l.credited_amount, r.principal)
         ELSE NULL
       END,
       a.outstanding_balance,
       r.created_at,
       CASE
         WHEN r.status IN ('rejected','cfo_rejected')
              AND r.cfo_paid_at IS NULL AND l.credited_at IS NULL THEN NULL
         ELSE COALESCE(r.cfo_approved_at, r.coo_approved_at)
       END,
       CASE WHEN r.status IN ('rejected','cfo_rejected','voided') THEN r.updated_at ELSE NULL END,
       COALESCE(r.cfo_paid_at, l.credited_at),
       r.status,
       l.txn_ref,
       COALESCE(r.rejection_reason, r.cfo_notes, r.coo_notes, r.reason)
FROM public.agent_advance_requests r
LEFT JOIN public.profiles p ON p.id = r.agent_id
LEFT JOIN public.agent_advances a ON a.request_id = r.id
LEFT JOIN aar_ledger l ON l.source_id = r.id
WHERE (SELECT ok FROM guard)

UNION ALL
-- 2. Agent advances issued directly (no request record)
SELECT a.id,
       'AAD-' || upper(left(a.id::text, 8)),
       'Agent Advance (Direct Issue)',
       a.agent_id,
       p.full_name,
       p.phone,
       a.principal,
       a.principal,
       a.principal,
       a.outstanding_balance,
       a.created_at,
       COALESCE(a.issued_at, a.created_at),
       a.cancelled_at,
       COALESCE(a.issued_at, a.created_at),
       a.status,
       NULL,
       a.cancellation_reason
FROM public.agent_advances a
LEFT JOIN public.profiles p ON p.id = a.agent_id
WHERE a.request_id IS NULL AND (SELECT ok FROM guard)

UNION ALL
-- 3. Business advances
SELECT b.id,
       'BUS-' || upper(left(b.id::text, 8)),
       'Business Advance',
       b.tenant_id,
       p.full_name,
       p.phone,
       b.principal,
       CASE
         WHEN b.coo_approved_at IS NOT NULL OR b.cfo_disbursed_at IS NOT NULL OR b.disbursed_at IS NOT NULL
           THEN b.principal
         ELSE NULL
       END,
       CASE WHEN b.disbursed_at IS NOT NULL OR b.cfo_disbursed_at IS NOT NULL THEN b.principal ELSE NULL END,
       b.outstanding_balance,
       b.created_at,
       CASE
         WHEN b.status::text = 'rejected' AND b.coo_approved_at IS NULL THEN NULL
         ELSE COALESCE(b.coo_approved_at, b.cfo_disbursed_at, b.disbursed_at)
       END,
       CASE WHEN b.status::text = 'rejected' THEN b.updated_at ELSE NULL END,
       COALESCE(b.disbursed_at, b.cfo_disbursed_at),
       b.status::text,
       NULL,
       COALESCE(b.rejection_reason, b.cfo_notes, b.coo_notes, b.reason)
FROM public.business_advances b
LEFT JOIN public.profiles p ON p.id = b.tenant_id
WHERE (SELECT ok FROM guard)

UNION ALL
-- 4. Credit access draws
SELECT d.id,
       'CAD-' || upper(left(d.id::text, 8)),
       'Credit Access Draw',
       d.user_id,
       p.full_name,
       p.phone,
       COALESCE(d.requested_amount, d.amount),
       CASE
         WHEN d.cfo_approved_at IS NOT NULL
              OR cl.credited_at IS NOT NULL
              OR d.status NOT IN ('pending_cfo','rejected','cfo_rejected','cancelled')
           THEN d.amount
         ELSE NULL
       END,
       CASE
         WHEN cl.credited_at IS NOT NULL
              OR (d.started_at IS NOT NULL AND d.status NOT IN ('pending_cfo','rejected','cfo_rejected','cancelled'))
           THEN COALESCE(cl.credited_amount, d.amount)
         ELSE NULL
       END,
       d.outstanding_balance,
       COALESCE(d.submitted_at, d.created_at),
       CASE
         WHEN d.cfo_approved_at IS NULL
              AND cl.credited_at IS NULL
              AND d.status IN ('pending_cfo','rejected','cfo_rejected','cancelled') THEN NULL
         ELSE COALESCE(d.cfo_approved_at, d.started_at, cl.credited_at)
       END,
       CASE WHEN d.status IN ('rejected','cfo_rejected') THEN d.updated_at ELSE NULL END,
       CASE
         WHEN cl.credited_at IS NOT NULL THEN COALESCE(d.started_at, cl.credited_at)
         WHEN d.status NOT IN ('pending_cfo','rejected','cfo_rejected','cancelled') THEN d.started_at
         ELSE NULL
       END,
       d.status,
       cl.txn_ref,
       COALESCE(d.rejection_reason, d.cfo_notes)
FROM public.credit_access_draws d
LEFT JOIN public.profiles p ON p.id = d.user_id
LEFT JOIN cad_ledger cl ON cl.source_id = d.id
WHERE (SELECT ok FROM guard)

UNION ALL
-- 5. Staff salary advances
SELECT h.id,
       'SAL-' || upper(left(h.id::text, 8)),
       'Staff Salary Advance',
       s.user_id,
       p.full_name,
       p.phone,
       h.principal,
       CASE WHEN h.status = 'approved' THEN h.principal ELSE NULL END,
       CASE WHEN h.status = 'approved' THEN h.principal ELSE NULL END,
       NULL,
       h.requested_at,
       CASE WHEN h.status = 'approved' THEN h.approved_at ELSE NULL END,
       CASE WHEN h.status = 'rejected' THEN h.approved_at ELSE NULL END,
       CASE WHEN h.status = 'approved' THEN h.approved_at ELSE NULL END,
       h.status,
       NULL,
       h.decision_note
FROM public.hr_pay_advances h
LEFT JOIN public.hr_staff s ON s.id = h.staff_id
LEFT JOIN public.profiles p ON p.id = s.user_id
WHERE (SELECT ok FROM guard)

UNION ALL
-- 6. Merchant out-of-pocket advances (company owes the merchant agent)
SELECT m.id,
       'MOP-' || upper(left(m.id::text, 8)),
       'Merchant Out-of-Pocket Advance',
       m.agent_id,
       p.full_name,
       p.phone,
       m.shortfall_amount,
       m.shortfall_amount,
       CASE WHEN m.reimbursed_at IS NOT NULL THEN m.shortfall_amount ELSE NULL END,
       CASE WHEN m.reimbursed_at IS NULL THEN m.shortfall_amount ELSE 0 END,
       m.created_at,
       NULL,
       NULL,
       m.reimbursed_at,
       m.status,
       m.withdrawal_id::text,
       m.note
FROM public.merchant_out_of_pocket_advances m
LEFT JOIN public.profiles p ON p.id = m.agent_id
WHERE (SELECT ok FROM guard)
$function$;