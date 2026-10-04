DROP VIEW IF EXISTS public.v_rent_repaid_reconciliation;

CREATE VIEW public.v_rent_repaid_reconciliation
WITH (security_invoker = on) AS
 WITH ledger AS (
         SELECT x.rent_request_id,
            sum(x.amount) AS ledger_total,
            count(*) AS ledger_rows,
            max(x.created_at) AS last_payment_at
           FROM ( SELECT ac.rent_request_id,
                    ac.amount,
                    ac.created_at
                   FROM agent_collections ac
                  WHERE ac.rent_request_id IS NOT NULL
                UNION ALL
                 SELECT rp.rent_request_id,
                    rp.amount,
                    rp.created_at
                   FROM repayments rp
                  WHERE rp.rent_request_id IS NOT NULL AND NOT (EXISTS ( SELECT 1
                           FROM agent_collections a
                          WHERE a.rent_request_id = rp.rent_request_id AND a.amount = rp.amount AND abs(EXTRACT(epoch FROM a.created_at - rp.created_at)) < 300::numeric))) x
          GROUP BY x.rent_request_id
        ), logged_edits AS (
         SELECT rent_amount_change_log.rent_request_id,
            count(*) AS logged_edit_count,
            sum(COALESCE(rent_amount_change_log.new_amount_repaid, 0::numeric) - COALESCE(rent_amount_change_log.old_amount_repaid, 0::numeric)) AS logged_edit_net
           FROM rent_amount_change_log
          WHERE rent_amount_change_log.rent_request_id IS NOT NULL
          GROUP BY rent_amount_change_log.rent_request_id
        ), balance_log AS (
         SELECT bl.rent_request_id,
            count(*) AS balance_log_count,
            sum(COALESCE(bl.new_amount_repaid, 0::numeric) - COALESCE(bl.old_amount_repaid, 0::numeric)) AS balance_log_net,
            max(bl.changed_at) AS last_balance_change_at
           FROM rent_amount_change_log bl
          WHERE bl.rent_request_id IS NOT NULL AND 'amount_repaid'::text = ANY (bl.changed_fields)
          GROUP BY bl.rent_request_id
        ), audited AS (
         SELECT a.record_id::uuid AS rent_request_id,
            count(*) AS audit_rows
           FROM audit_logs a
          WHERE a.table_name = 'rent_requests'::text AND a.record_id IS NOT NULL AND (a.old_values ->> 'amount_repaid'::text) IS DISTINCT FROM (a.new_values ->> 'amount_repaid'::text)
          GROUP BY (a.record_id::uuid)
        )
 SELECT rr.id AS rent_request_id,
    rr.tenant_id,
    rr.agent_id,
    rr.status,
    COALESCE(rr.total_repayment, 0::numeric) AS total_repayment,
    COALESCE(rr.amount_repaid, 0::numeric) AS amount_repaid,
    COALESCE(l.ledger_total, 0::numeric) AS ledger_total,
    COALESCE(l.ledger_rows, 0::bigint)::integer AS ledger_rows,
    l.last_payment_at,
    COALESCE(e.logged_edit_count, 0::bigint)::integer AS logged_edit_count,
    COALESCE(e.logged_edit_net, 0::numeric) AS logged_edit_net,
    COALESCE(au.audit_rows, 0::bigint)::integer AS audit_rows,
    COALESCE(bl.balance_log_count, 0::bigint)::integer AS balance_log_count,
    COALESCE(bl.balance_log_net, 0::numeric) AS balance_log_net,
    bl.last_balance_change_at,
    COALESCE(rr.amount_repaid, 0::numeric) - COALESCE(l.ledger_total, 0::numeric) AS unbacked_by_ledger,
    COALESCE(rr.amount_repaid, 0::numeric) - COALESCE(l.ledger_total, 0::numeric) - COALESCE(e.logged_edit_net, 0::numeric) AS unexplained,
        CASE
            WHEN abs(COALESCE(rr.amount_repaid, 0::numeric) - COALESCE(l.ledger_total, 0::numeric)) <= 1::numeric THEN 'reconciled'::text
            WHEN abs(COALESCE(rr.amount_repaid, 0::numeric) - COALESCE(l.ledger_total, 0::numeric) - COALESCE(e.logged_edit_net, 0::numeric)) <= 1::numeric THEN 'explained_by_logged_edit'::text
            WHEN COALESCE(bl.balance_log_count, 0::bigint) > 0 THEN 'traced_no_ledger'::text
            WHEN COALESCE(rr.amount_repaid, 0::numeric) > COALESCE(l.ledger_total, 0::numeric) AND COALESCE(bl.balance_log_count, 0::bigint) = 0 AND COALESCE(au.audit_rows, 0::bigint) = 0 THEN 'untraced_credit'::text
            ELSE 'untraced_shortfall'::text
        END AS reconciliation_state
   FROM rent_requests rr
     LEFT JOIN ledger l ON l.rent_request_id = rr.id
     LEFT JOIN logged_edits e ON e.rent_request_id = rr.id
     LEFT JOIN balance_log bl ON bl.rent_request_id = rr.id
     LEFT JOIN audited au ON au.rent_request_id = rr.id;

REVOKE ALL ON public.v_rent_repaid_reconciliation FROM anon;

COMMENT ON VIEW public.v_rent_repaid_reconciliation IS
'Audits rent_requests.amount_repaid against the de-duplicated payment ledger (agent_collections plus repayments not matched to a collection of the same amount within 300 seconds). Five reconciliation states, evaluated in this order: reconciled = the balance matches the payment ledger within UGX 1; explained_by_logged_edit = the difference is fully accounted for by the net of logged amount_repaid changes in rent_amount_change_log; traced_no_ledger = the balance is not ledger-backed but at least one logged amount_repaid change exists, so the movement can be traced to a recorded edit; untraced_credit = amount_repaid exceeds the payment ledger with no logged balance change and no audit_logs row, meaning a balance moved with no payment, no logged edit and no audit row; untraced_shortfall = any remaining case, typically amount_repaid below the payment ledger without a tracing record. untraced_credit rows require documentary evidence before any figure derived from them is relied on for reporting, settlement or agent performance. Balance-change logging begins with the TRACE-02B control, so historical exceptions predating it classify as untraced_credit by construction.';