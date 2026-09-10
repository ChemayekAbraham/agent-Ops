create or replace view public.v_cc_call_queue as
 WITH t AS (
         SELECT DISTINCT ON (b.tenant_id) b.tenant_id,
            b.tenant_name,
            b.district,
            b.region,
            b.agent_id,
            b.arrears_amount,
            b.outstanding,
            b.schedule_delta_days,
            b.daily_repayment,
            b.days_since_funded,
            b.last_payment_at,
            b.next_due_date
           FROM v_tenant_ops_tenant_base b
          ORDER BY b.tenant_id, b.funded_at DESC NULLS LAST, b.rent_request_id
        ), adv AS (
         SELECT agent_advances.agent_id,
            sum(agent_advances.outstanding_balance) AS advance_outstanding,
            sum(agent_advances.arrears_balance) AS advance_arrears
           FROM agent_advances
          WHERE COALESCE(agent_advances.status, ''::text) <> 'cancelled'::text AND agent_advances.reversed_at IS NULL
          GROUP BY agent_advances.agent_id
        ), mf AS (
         SELECT v_merchant_float_position.agent_id,
            sum(v_merchant_float_position.own_cash_outstanding) AS own_cash_outstanding
           FROM v_merchant_float_position
          GROUP BY v_merchant_float_position.agent_id
        )
 SELECT r.cycle_id,
    r.id AS cycle_row_id,
    r.subject_type,
    r.subject_id,
    r.state,
    r.attempts_made,
    r.last_attempt_at,
    r.next_retry_at,
    r.callback_due_at,
    r.park_reason,
    r.priority_value,
    COALESCE(t.tenant_name, l.name, a.full_name, tpr.full_name) AS name,
    COALESCE(t.district, l.district, a.district, NULLIF(tpr.district, ''::text)) AS district,
    COALESCE(t.region, l.region, a.region, NULLIF(tpr.region, ''::text)) AS region,
    COALESCE(tap.full_name, lap.full_name) AS linked_agent_name,
    fb.feedback_category,
    fb.severity,
    fb.routed_to_name,
    fb.ticket_ref,
    fb.task_status,
    pk.fix_ticket_ref,
    cb.booked_by_name,
    t.arrears_amount,
    t.outstanding,
    t.schedule_delta_days,
    t.daily_repayment,
    t.days_since_funded,
    t.last_payment_at,
    l.monthly_rent,
    l.houses,
    l.empty_houses,
    l.plans,
    l.plan_rent_total,
    l.houses_monthly_rent,
    l.last_paid_at,
    adv.advance_outstanding,
    adv.advance_arrears,
    el.active_count AS active_tenants,
    mf.own_cash_outstanding,
    a.last_active_at,
    a.agent_tier,
    a.active_capability_count,
    tpr.preferred_language,
    t.next_due_date,
        CASE
            WHEN r.subject_type = 'tenant'::cc_subject_type THEN GREATEST(0, - t.schedule_delta_days)
            ELSE NULL::integer
        END AS days_behind
   FROM cc_cycle_rows r
     LEFT JOIN t ON r.subject_type = 'tenant'::cc_subject_type AND t.tenant_id = r.subject_id
     LEFT JOIN v_landlord_calling_base l ON r.subject_type = 'landlord'::cc_subject_type AND l.landlord_id = r.subject_id
     LEFT JOIN vw_agent_ops_directory a ON r.subject_type = 'agent'::cc_subject_type AND a.agent_id = r.subject_id
     LEFT JOIN profiles tap ON tap.id = t.agent_id
     LEFT JOIN profiles lap ON lap.id = l.managed_by_agent_id
     LEFT JOIN profiles tpr ON r.subject_type = 'tenant'::cc_subject_type AND tpr.id = r.subject_id
     LEFT JOIN adv ON r.subject_type = 'agent'::cc_subject_type AND adv.agent_id = r.subject_id
     LEFT JOIN mf ON r.subject_type = 'agent'::cc_subject_type AND mf.agent_id = r.subject_id
     LEFT JOIN v_agent_daily_eligibility el ON r.subject_type = 'agent'::cc_subject_type AND el.agent_id = r.subject_id
     LEFT JOIN LATERAL ( SELECT cat.label AS feedback_category,
            f.severity,
            sp.full_name AS routed_to_name,
            tk.ref AS ticket_ref,
            tsk.status::text AS task_status
           FROM cc_call_attempts at2
             JOIN cc_feedback f ON f.attempt_id = at2.id
             LEFT JOIN cc_feedback_categories cat ON cat.id = f.category_id
             LEFT JOIN hr_staff st ON st.id = COALESCE(f.routed_to_actual, f.routed_to_expected)
             LEFT JOIN profiles sp ON sp.id = st.user_id
             LEFT JOIN hr_tickets tk ON tk.id = f.ticket_id
             LEFT JOIN hr_tasks tsk ON tsk.id = tk.task_id
          WHERE at2.cycle_row_id = r.id
          ORDER BY f.created_at DESC
         LIMIT 1) fb ON true
     LEFT JOIN LATERAL ( SELECT tk2.ref AS fix_ticket_ref
           FROM hr_tickets tk2
             JOIN cc_call_attempts at3 ON at3.id = tk2.call_attempt_id
          WHERE at3.cycle_row_id = r.id AND tk2.severity_basis = 'Call centre parked row'::text
          ORDER BY tk2.raised_at DESC
         LIMIT 1) pk ON true
     LEFT JOIN LATERAL ( SELECT p.full_name AS booked_by_name
           FROM cc_call_attempts at4
             LEFT JOIN profiles p ON p.id = at4.caller_id
          WHERE at4.cycle_row_id = r.id AND at4.outcome = 'callback_booked'::cc_attempt_outcome
          ORDER BY at4.recorded_at DESC NULLS LAST
         LIMIT 1) cb ON true;