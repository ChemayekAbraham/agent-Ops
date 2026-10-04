CREATE OR REPLACE FUNCTION public.get_float_entry_detail(
  p_user_id uuid,
  p_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _is_staff boolean := false;
  _entry record;
  _siblings jsonb;
  _linked_name text;
  _linked_uuid uuid;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;

  IF _caller <> p_user_id THEN
    SELECT EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = _caller
        AND ur.role IN ('super_admin','manager','cfo','coo','ceo','cto','operations','employee')
    ) INTO _is_staff;
    IF NOT _is_staff THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;

  SELECT gl.*
    INTO _entry
  FROM general_ledger gl
  WHERE gl.id = p_entry_id
    AND gl.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry not found';
  END IF;

  -- Try to resolve linked_party to a profile name if it looks like a uuid
  BEGIN
    _linked_uuid := _entry.linked_party::uuid;
  EXCEPTION WHEN others THEN
    _linked_uuid := NULL;
  END;

  IF _linked_uuid IS NOT NULL THEN
    SELECT COALESCE(NULLIF(p.full_name, ''), p.phone_number)
      INTO _linked_name
    FROM profiles p
    WHERE p.user_id = _linked_uuid
    LIMIT 1;
  END IF;

  -- Collect sibling legs in the same transaction group
  IF _entry.transaction_group_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'user_id', s.user_id,
      'user_name', COALESCE(NULLIF(p.full_name, ''), p.phone_number),
      'category', s.category,
      'direction', s.direction,
      'amount', s.amount,
      'ledger_scope', s.ledger_scope,
      'wallet_bucket', s.wallet_bucket,
      'recipient_type', s.recipient_type,
      'account', s.account,
      'description', s.description,
      'reference_id', s.reference_id,
      'linked_party', s.linked_party,
      'created_at', s.created_at,
      'is_self', s.id = _entry.id
    ) ORDER BY s.ledger_scope, s.direction, s.id), '[]'::jsonb)
      INTO _siblings
    FROM general_ledger s
    LEFT JOIN profiles p ON p.user_id = s.user_id
    WHERE s.transaction_group_id = _entry.transaction_group_id;
  ELSE
    _siblings := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'entry', jsonb_build_object(
      'id', _entry.id,
      'created_at', _entry.created_at,
      'transaction_date', _entry.transaction_date,
      'category', _entry.category,
      'direction', _entry.direction,
      'amount', _entry.amount,
      'description', _entry.description,
      'reference_id', _entry.reference_id,
      'linked_party', _entry.linked_party,
      'linked_party_name', _linked_name,
      'source_table', _entry.source_table,
      'source_id', _entry.source_id,
      'transaction_group_id', _entry.transaction_group_id,
      'wallet_bucket', _entry.wallet_bucket,
      'recipient_type', _entry.recipient_type,
      'account', _entry.account,
      'currency', _entry.currency,
      'idempotency_key', _entry.idempotency_key
    ),
    'siblings', _siblings
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_float_entry_detail(uuid, uuid) TO authenticated;