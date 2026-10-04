CREATE INDEX IF NOT EXISTS idx_general_ledger_idempotency_key
  ON public.general_ledger (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- Generic, read-only Ledger Delivery Verification service.
-- Verifies whether an earning record was actually delivered to
-- a wallet, using AUTHORITATIVE ledger relationships only:
--   1. transaction_group_id (ledger group of the posting)
--   2. idempotency_key (canonical payout reference)
--   3. source_table + source_id (source record reference)
-- Amount/timestamp are NEVER used to establish a match; the
-- timestamp is only a deterministic tie-break when a single
-- source legitimately produced multiple credits.
-- ============================================================
CREATE OR REPLACE FUNCTION public.verify_ledger_delivery(p_items jsonb)
RETURNS TABLE (
  item_key text,
  verification_status text,
  match_method text,
  wallet_transaction_id uuid,
  ledger_transaction_group_id uuid,
  wallet_bucket text,
  ledger_scope text,
  category text,
  credited_amount numeric,
  credited_at timestamptz,
  wallet_user_id uuid,
  ledger_idempotency_key text,
  failure_reason text,
  processing_state text,
  retry_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_privileged boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_caller
      AND ur.role IN ('manager','super_admin','ceo','cfo','coo','cto',
                      'financial_ops','agent_ops','operations','tenant_ops','landlord_ops')
  ) INTO v_privileged;

  RETURN QUERY
  WITH items AS (
    SELECT
      e->>'key'                                    AS k,
      nullif(e->>'user_id','')::uuid               AS uid,
      nullif(e->>'source_table','')                AS src_table,
      nullif(e->>'source_id','')                   AS src_id,
      nullif(e->>'ledger_group_id','')::uuid       AS grp,
      nullif(e->>'idempotency_key','')             AS idk,
      lower(nullif(e->>'state',''))                AS state,
      nullif(e->>'error_message','')               AS err,
      nullif(e->>'occurred_at','')::timestamptz    AS occurred_at,
      CASE WHEN e ? 'expected_categories' THEN (
        SELECT array_agg(x) FROM jsonb_array_elements_text(e->'expected_categories') x
      ) END                                        AS cats
    FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
  ),
  allowed AS (
    SELECT * FROM items
    WHERE k IS NOT NULL
      AND uid IS NOT NULL
      AND (v_privileged OR uid = v_caller)
  ),
  matched AS (
    SELECT
      a.k, a.uid, a.state, a.err,
      l.gl_id, l.tg, l.bucket, l.scope, l.cat, l.amt, l.tx_date, l.gl_user, l.gl_idk, l.method
    FROM allowed a
    LEFT JOIN LATERAL (
      SELECT
        g.id                    AS gl_id,
        g.transaction_group_id  AS tg,
        coalesce(g.wallet_bucket,
                 CASE WHEN g.recipient_type = 'user' THEN 'withdrawable'
                      WHEN g.recipient_type = 'operational_wallet' THEN 'float' END) AS bucket,
        g.ledger_scope          AS scope,
        g.category              AS cat,
        g.amount                AS amt,
        g.transaction_date      AS tx_date,
        g.user_id               AS gl_user,
        g.idempotency_key       AS gl_idk,
        CASE
          WHEN a.grp IS NOT NULL AND g.transaction_group_id = a.grp THEN 'transaction_group_id'
          WHEN a.idk IS NOT NULL AND g.idempotency_key = a.idk THEN 'idempotency_key'
          ELSE 'source_reference'
        END AS method,
        CASE
          WHEN a.grp IS NOT NULL AND g.transaction_group_id = a.grp THEN 1
          WHEN a.idk IS NOT NULL AND g.idempotency_key = a.idk THEN 2
          ELSE 3
        END AS rank
      FROM public.general_ledger g
      WHERE g.user_id = a.uid
        AND g.ledger_scope = 'wallet'
        AND g.direction IN ('cash_in','credit')
        AND coalesce(g.classification,'') <> 'admin_correction'
        AND coalesce(g.category,'') <> 'system_balance_correction'
        AND (a.cats IS NULL OR g.category = ANY (a.cats))
        AND (
             (a.grp IS NOT NULL AND g.transaction_group_id = a.grp)
          OR (a.idk IS NOT NULL AND g.idempotency_key = a.idk)
          OR (a.src_table IS NOT NULL AND a.src_id IS NOT NULL
              AND g.source_table = a.src_table
              AND g.source_id::text = a.src_id)
        )
      ORDER BY rank,
               CASE WHEN a.occurred_at IS NULL THEN 0
                    ELSE abs(extract(epoch FROM (g.transaction_date - a.occurred_at))) END
      LIMIT 1
    ) l ON true
  )
  SELECT
    m.k,
    CASE
      WHEN m.gl_id IS NOT NULL THEN 'credited'
      WHEN m.state IN ('failed','error','rejected','reversed') THEN 'failed'
      WHEN m.state IN ('pending','queued','processing','submitted','accrued','approved') THEN 'pending'
      ELSE 'not_found'
    END,
    m.method,
    m.gl_id,
    m.tg,
    m.bucket,
    m.scope,
    m.cat,
    m.amt,
    m.tx_date,
    m.gl_user,
    m.gl_idk,
    CASE
      WHEN m.gl_id IS NOT NULL THEN NULL
      WHEN m.err IS NOT NULL THEN m.err
      WHEN m.state IN ('pending','queued','processing','submitted','accrued','approved')
        THEN 'Wallet posting not completed yet'
      ELSE 'No wallet credit linked by transaction group, idempotency key, or source reference'
    END,
    CASE WHEN m.gl_id IS NOT NULL THEN 'settled' ELSE coalesce(m.state,'unknown') END,
    CASE
      WHEN m.gl_id IS NOT NULL THEN NULL
      WHEN m.state IN ('pending','queued','processing','submitted','accrued','approved') THEN 'awaiting_retry'
      ELSE 'manual_review_required'
    END
  FROM matched m;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_ledger_delivery(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_ledger_delivery(jsonb) TO authenticated, service_role;

-- ============================================================
-- Server-side Payout Audit feed (read-only). Collects the agent's
-- earning records and returns the verified delivery status for
-- each, so the client performs no matching at all.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_payout_delivery_audit(
  p_user_id uuid DEFAULT NULL,
  p_limit int DEFAULT 200
)
RETURNS TABLE (
  item_key text,
  kind text,
  label text,
  counterparty_name text,
  earned_amount numeric,
  occurred_at timestamptz,
  verification_status text,
  match_method text,
  wallet_transaction_id uuid,
  ledger_transaction_group_id uuid,
  wallet_bucket text,
  ledger_scope text,
  category text,
  credited_amount numeric,
  credited_at timestamptz,
  failure_reason text,
  processing_state text,
  retry_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_target uuid := coalesce(p_user_id, auth.uid());
  v_privileged boolean := false;
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_items jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_caller
      AND ur.role IN ('manager','super_admin','ceo','cfo','coo','cto',
                      'financial_ops','agent_ops','operations','tenant_ops','landlord_ops')
  ) INTO v_privileged;

  IF v_target IS NULL OR (v_target <> v_caller AND NOT v_privileged) THEN
    RAISE EXCEPTION 'Not authorized to audit payouts for this user';
  END IF;

  RETURN QUERY
  WITH legs AS (
    SELECT
      'roe-' || r.id::text            AS k,
      'Recruiter override'            AS kind,
      coalesce(r.label, replace(coalesce(r.event_type,'Recruiter override'), '_', ' ')) AS label,
      r.sub_agent_id                  AS party_id,
      r.amount::numeric               AS amount,
      r.occurred_at                   AS occurred_at,
      r.source_table                  AS src_table,
      r.source_id                     AS src_id,
      r.ledger_group_id               AS grp,
      NULL::text                      AS idk,
      r.status                        AS state,
      r.error_message                 AS err
    FROM public.recruiter_override_events r
    WHERE r.recruiter_id = v_target
    ORDER BY r.occurred_at DESC
    LIMIT v_limit
  ),
  earn AS (
    SELECT
      'ae-' || e.id::text             AS k,
      'Sub-agent earning'             AS kind,
      coalesce(e.description, replace(e.earning_type, '_', ' ')) AS label,
      e.source_user_id                AS party_id,
      e.amount::numeric               AS amount,
      e.created_at                    AS occurred_at,
      'agent_earnings'::text          AS src_table,
      e.id::text                      AS src_id,
      NULL::uuid                      AS grp,
      NULL::text                      AS idk,
      NULL::text                      AS state,
      NULL::text                      AS err
    FROM public.agent_earnings e
    WHERE e.agent_id = v_target
      AND e.earning_type IN ('subagent_commission','subagent_override','subagent_registration')
    ORDER BY e.created_at DESC
    LIMIT v_limit
  ),
  rentov AS (
    SELECT
      'cal-' || c.id::text            AS k,
      'Rent override (2%)'            AS kind,
      coalesce(c.description, 'Rent commission (2%)') AS label,
      rr.agent_id                     AS party_id,
      c.amount::numeric               AS amount,
      c.earned_at                     AS occurred_at,
      'commission_accrual_ledger'::text AS src_table,
      c.id::text                      AS src_id,
      NULL::uuid                      AS grp,
      NULL::text                      AS idk,
      c.status                        AS state,
      c.rejection_reason              AS err
    FROM public.commission_accrual_ledger c
    LEFT JOIN LATERAL (
      SELECT r2.agent_id FROM public.rent_requests r2
      WHERE r2.tenant_id = c.tenant_id
      ORDER BY r2.created_at DESC LIMIT 1
    ) rr ON true
    WHERE c.agent_id = v_target
      AND c.commission_role = 'recruiter'
    ORDER BY c.earned_at DESC
    LIMIT v_limit
  ),
  all_legs AS (
    SELECT * FROM legs
    UNION ALL SELECT * FROM earn
    UNION ALL SELECT * FROM rentov
  ),
  items AS (
    SELECT jsonb_agg(jsonb_build_object(
      'key', a.k,
      'user_id', v_target,
      'source_table', a.src_table,
      'source_id', a.src_id,
      'ledger_group_id', a.grp,
      'idempotency_key', a.idk,
      'state', a.state,
      'error_message', a.err,
      'occurred_at', a.occurred_at,
      'expected_categories', jsonb_build_array('agent_commission','agent_commission_earned')
    )) AS payload
    FROM all_legs a
  ),
  verified AS (
    SELECT v.* FROM items, LATERAL public.verify_ledger_delivery(items.payload) v
  )
  SELECT
    a.k,
    a.kind,
    a.label,
    p.full_name,
    a.amount,
    a.occurred_at,
    coalesce(v.verification_status, 'not_found'),
    v.match_method,
    v.wallet_transaction_id,
    v.ledger_transaction_group_id,
    v.wallet_bucket,
    v.ledger_scope,
    v.category,
    v.credited_amount,
    v.credited_at,
    v.failure_reason,
    v.processing_state,
    v.retry_status
  FROM all_legs a
  LEFT JOIN verified v ON v.item_key = a.k
  LEFT JOIN public.profiles p ON p.id = a.party_id
  ORDER BY a.occurred_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_payout_delivery_audit(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payout_delivery_audit(uuid, int) TO authenticated, service_role;