CREATE OR REPLACE FUNCTION public.lookup_transaction_id(p_tid text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_digits text;
  v_uid uuid := auth.uid();
  v_allowed boolean;
  v_emails jsonb;
  v_deposits jsonb;
  v_ledger jsonb;
  v_routing jsonb;
  v_withdrawals jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid
      AND ur.role IN ('financial_ops','cfo','coo','ceo','manager','super_admin')
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_digits := regexp_replace(coalesce(p_tid,''), '\D', '', 'g');
  IF length(v_digits) < 5 THEN
    RETURN jsonb_build_object(
      'query', p_tid,
      'digits', v_digits,
      'found', false,
      'error', 'tid_too_short',
      'emails', '[]'::jsonb,
      'deposits', '[]'::jsonb,
      'ledger', '[]'::jsonb,
      'routing', '[]'::jsonb,
      'withdrawals', '[]'::jsonb
    );
  END IF;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'received_at' DESC), '[]'::jsonb) INTO v_emails
  FROM (
    SELECT jsonb_build_object(
      'id', g.id,
      'transaction_id', g.transaction_id,
      'amount', g.amount,
      'direction', g.direction,
      'channel', g.channel,
      'from_email', g.from_email,
      'subject', g.subject,
      'snippet', left(coalesce(g.snippet, ''), 300),
      'received_at', coalesce(g.internal_date, g.created_at),
      'parsed', g.parsed,
      'linked_deposit_request_id', g.linked_deposit_request_id,
      'auto_match_method', g.auto_match_method
    ) AS x
    FROM public.gmail_transactions g
    WHERE regexp_replace(coalesce(g.transaction_id,''), '\D', '', 'g') = v_digits
       OR coalesce(g.snippet,'') ILIKE '%' || v_digits || '%'
       OR coalesce(g.subject,'') ILIKE '%' || v_digits || '%'
       OR coalesce(g.raw_body,'') ILIKE '%' || v_digits || '%'
    LIMIT 25
  ) s;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_deposits
  FROM (
    SELECT jsonb_build_object(
      'id', d.id,
      'transaction_id', d.transaction_id,
      'amount', d.amount,
      'status', d.status,
      'purpose', d.deposit_purpose::text,
      'user_id', d.user_id,
      'user_name', p.full_name,
      'user_phone', p.phone,
      'created_at', d.created_at,
      'approved_at', d.approved_at
    ) AS x
    FROM public.deposit_requests d
    LEFT JOIN public.profiles p ON p.id = d.user_id
    WHERE regexp_replace(coalesce(d.transaction_id,''), '\D', '', 'g') = v_digits
       OR coalesce(d.notes,'') ILIKE '%' || v_digits || '%'
    LIMIT 25
  ) s;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_ledger
  FROM (
    SELECT jsonb_build_object(
      'id', l.id,
      'amount', l.amount,
      'direction', l.direction,
      'category', l.category,
      'wallet_bucket', l.wallet_bucket,
      'ledger_scope', l.ledger_scope,
      'classification', l.classification,
      'description', left(coalesce(l.description,''), 300),
      'reference_id', l.reference_id,
      'user_id', l.user_id,
      'user_name', p.full_name,
      'created_at', l.created_at
    ) AS x
    FROM public.general_ledger l
    LEFT JOIN public.profiles p ON p.id = l.user_id
    WHERE coalesce(l.reference_id,'') ILIKE '%' || v_digits || '%'
       OR coalesce(l.description,'') ILIKE '%' || v_digits || '%'
    LIMIT 50
  ) s;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_routing
  FROM (
    SELECT jsonb_build_object(
      'id', r.id,
      'transaction_id', r.transaction_id,
      'amount', r.amount,
      'route', r.route,
      'reason', left(coalesce(r.reason,''), 300),
      'target_user_name', r.target_user_name,
      'target_user_phone', r.target_user_phone,
      'ledger_reference_id', r.ledger_reference_id,
      'created_at', r.created_at
    ) AS x
    FROM public.email_routing_history r
    WHERE regexp_replace(coalesce(r.transaction_id,''), '\D', '', 'g') = v_digits
       OR coalesce(r.reason,'') ILIKE '%' || v_digits || '%'
    LIMIT 25
  ) s;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_withdrawals
  FROM (
    SELECT jsonb_build_object(
      'id', w.id,
      'transaction_id', w.transaction_id,
      'amount', w.amount,
      'status', w.status,
      'user_id', w.user_id,
      'user_name', p.full_name,
      'created_at', w.created_at
    ) AS x
    FROM public.withdrawal_requests w
    LEFT JOIN public.profiles p ON p.id = w.user_id
    WHERE regexp_replace(coalesce(w.transaction_id,''), '\D', '', 'g') = v_digits
    LIMIT 25
  ) s;

  RETURN jsonb_build_object(
    'query', p_tid,
    'digits', v_digits,
    'found', (jsonb_array_length(v_emails) + jsonb_array_length(v_deposits)
              + jsonb_array_length(v_ledger) + jsonb_array_length(v_routing)
              + jsonb_array_length(v_withdrawals)) > 0,
    'emails', v_emails,
    'deposits', v_deposits,
    'ledger', v_ledger,
    'routing', v_routing,
    'withdrawals', v_withdrawals
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_transaction_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_transaction_id(text) TO authenticated;