
-- 1. Patch the auto-matcher to insert as pending (no purpose, no silent approval)
CREATE OR REPLACE FUNCTION public.auto_create_deposits_from_gmail(p_window_hours integer DEFAULT 24)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tx record;
  v_phone_match text;
  v_phone_norm  text;
  v_user_id     uuid;
  v_provider    text;
  v_haystack    text;
  v_created     integer := 0;
  v_new_id      uuid;
begin
  for v_tx in
    select g.id, g.amount, g.transaction_id, g.counterparty, g.internal_date,
           g.subject, g.snippet, g.raw_body, g.from_email
      from gmail_transactions g
     where g.linked_deposit_request_id is null
       and g.parsed = true
       and g.direction in ('in','credit')
       and g.amount is not null
       and g.amount > 0
       and g.transaction_id is not null
       and length(trim(g.transaction_id)) > 0
       and (g.internal_date is null
            or g.internal_date >= (now() - (p_window_hours || ' hours')::interval))
     order by g.internal_date desc nulls last
     limit 200
  loop
    if exists (
      select 1 from deposit_requests d
       where d.transaction_id is not null
         and lower(trim(d.transaction_id)) = lower(trim(v_tx.transaction_id))
    ) then
      continue;
    end if;

    v_haystack := concat_ws(' ',
      coalesce(v_tx.snippet, ''),
      coalesce(v_tx.subject, ''),
      coalesce(v_tx.counterparty, ''),
      coalesce(v_tx.raw_body, '')
    );

    v_phone_match := substring(v_haystack from '256[0-9]{9}');
    if v_phone_match is null then
      v_phone_match := substring(v_haystack from '0[7][0-9]{8}');
    end if;
    if v_phone_match is null then continue; end if;

    if v_phone_match like '256%' then
      v_phone_norm := '0' || substring(v_phone_match from 4);
    else
      v_phone_norm := v_phone_match;
    end if;

    select p.id into v_user_id
      from profiles p
     where regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') in (
             regexp_replace(v_phone_match, '[^0-9]', '', 'g'),
             regexp_replace(v_phone_norm,  '[^0-9]', '', 'g'),
             '256' || substring(v_phone_norm from 2)
           )
     limit 1;
    if v_user_id is null then continue; end if;

    if exists (
      select 1 from deposit_requests d
       where d.user_id = v_user_id
         and d.status = 'pending'
         and abs(d.amount - v_tx.amount) < 0.5
         and d.created_at >= (now() - (p_window_hours || ' hours')::interval)
    ) then continue; end if;

    v_provider := case
      when v_haystack ilike '%momo%' or v_haystack ilike '%mtn%' then 'mtn'
      when v_haystack ilike '%airtel%' then 'airtel'
      else 'mtn'
    end;

    -- GUARDRAIL: insert as 'pending' so the user/agent must explicitly confirm
    -- via DepositFlow, which posts the general_ledger entry and routes the
    -- correct wallet bucket (float / withdrawable / etc).
    insert into deposit_requests (
      user_id, amount, transaction_id, status, provider,
      notes, created_at
    ) values (
      v_user_id, v_tx.amount, v_tx.transaction_id, 'pending', v_provider,
      '[auto] Auto-created from Gmail receipt ' || v_tx.id::text || ' — awaiting purpose confirmation', now()
    ) returning id into v_new_id;

    update gmail_transactions
       set linked_deposit_request_id = v_new_id,
           auto_matched_at = now(),
           auto_match_method = 'tid'
     where id = v_tx.id
       and linked_deposit_request_id is null;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$function$;

-- 2. Defense-in-depth guardrail trigger
CREATE OR REPLACE FUNCTION public.enforce_auto_deposit_requires_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_is_auto boolean;
  v_has_ledger boolean;
begin
  -- Only police rows that end up as 'approved'
  if NEW.status is distinct from 'approved' then
    return NEW;
  end if;

  -- Identify auto-created deposits (notes prefix OR linked from a gmail_transactions row)
  v_is_auto := (
    coalesce(NEW.notes, '') like '[auto]%'
    OR exists (
      select 1 from gmail_transactions g
       where g.linked_deposit_request_id = NEW.id
    )
  );

  if not v_is_auto then
    return NEW;
  end if;

  -- Require a posted general_ledger entry for this deposit before approval is allowed
  v_has_ledger := exists (
    select 1 from general_ledger gl
     where gl.source_table = 'deposit_requests'
       and gl.source_id    = NEW.id
  );

  if not v_has_ledger then
    raise exception
      'Guardrail: auto-created deposit % cannot be marked approved without a general_ledger entry. Route through DepositFlow / approve-deposit so the ledger is posted and the correct wallet bucket is credited.',
      NEW.id
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

DROP TRIGGER IF EXISTS trg_enforce_auto_deposit_requires_ledger ON public.deposit_requests;
CREATE TRIGGER trg_enforce_auto_deposit_requires_ledger
BEFORE INSERT OR UPDATE OF status ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_auto_deposit_requires_ledger();
