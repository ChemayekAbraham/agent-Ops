CREATE OR REPLACE FUNCTION public.auto_verify_matching_payout_destinations(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_id_name text;
  v_has_photos boolean;
  v_double boolean := false;
  v_count integer := 0;
  v_old_name text;
begin
  if p_user_id is null then
    return 0;
  end if;

  select nullif(btrim(coalesce(p.national_id_name, '')), ''),
         nullif(btrim(coalesce(p.national_id_photo_path, '')), '') is not null
           and nullif(btrim(coalesce(p.selfie_photo_path, '')), '') is not null,
         p.full_name
    into v_id_name, v_has_photos, v_old_name
    from public.profiles p
   where p.id = p_user_id;

  if v_id_name is null or length(v_id_name) < 5 or coalesce(v_has_photos, false) = false then
    return 0;
  end if;

  begin
    select coalesce((public.identity_double_submission(p_user_id)->>'is_double')::boolean, false)
      into v_double;
  exception when others then
    v_double := false;
  end;

  if v_double then
    return 0;
  end if;

  with matched as (
    update public.payout_destination_verifications d
       set status = 'verified',
           decided_at = now(),
           decided_by = null,
           decision_reason = 'Auto-verified: the name on the National ID matches the name on this payout account.',
           national_id_name = v_id_name,
           name_match_score = (public.payout_name_match_report(v_id_name, d.account_name)->>'score')::numeric,
           updated_at = now()
     where d.user_id = p_user_id
       and d.status <> 'verified'
       and coalesce((public.payout_name_match_report(v_id_name, d.account_name)->>'score')::numeric, 0) >= 0.9
    returning d.id
  )
  select count(*) into v_count from matched;

  if v_count > 0 then
    if coalesce(v_old_name, '') is distinct from v_id_name then
      update public.profiles set full_name = v_id_name, updated_at = now() where id = p_user_id;

      insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
      values (p_user_id, 'payout_holder_name_from_national_id', 'profiles', p_user_id::text,
              'Auto-verification registered the account in the exact name printed on the National ID.',
              jsonb_build_object('full_name', v_old_name),
              jsonb_build_object('full_name', v_id_name, 'source', 'auto_verify_name_match'));
    end if;

    insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    values (p_user_id, 'payout_destination_auto_verified', 'payout_destination_verifications', p_user_id::text,
            'Name on the National ID matched the payout account name, so the destination was verified automatically.',
            jsonb_build_object('national_id_name', v_id_name, 'destinations_verified', v_count));
  end if;

  return v_count;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.auto_verify_matching_payout_destinations(uuid) TO authenticated;