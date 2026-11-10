-- Deleting an account must also free its Google/Apple sign-in.
--
-- delete-user tombstones auth.users.email (deleted+<id>@deleted.invalid) and bans
-- the login, but auth.identities kept the Google/Apple row with the person's real
-- email and provider_id. Supabase checks identities at sign-up, so the email
-- showed as "already registered", and "Continue with Google" landed on the banned
-- account. Email identities are fine: Auth keeps them in step with auth.users.
--
-- release: snapshots the SSO identities into deleted_accounts.metadata
--          (sso_identities_before), then deletes them. Only runs on a tombstoned login.
-- restore: puts them back for restore_auth, skipping any provider account that has
--          since been linked to another login.
-- Both are service_role only (called from the delete-user edge function).

create or replace function public.admin_release_sso_identities(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_released jsonb;
  v_register uuid;
begin
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null or v_email not like 'deleted+%@deleted.invalid' then
    return jsonb_build_object('ok', false, 'reason', 'login_not_tombstoned');
  end if;

  with gone as (
    delete from auth.identities i
     where i.user_id = p_user_id
       and i.provider not in ('email', 'phone')
    returning i.provider, i.provider_id, i.identity_data, i.last_sign_in_at, i.created_at
  )
  select coalesce(jsonb_agg(to_jsonb(gone)), '[]'::jsonb) into v_released from gone;

  if jsonb_array_length(v_released) > 0 then
    select id into v_register
      from public.deleted_accounts
     where user_id = p_user_id
     order by deleted_at desc
     limit 1;

    if v_register is not null then
      update public.deleted_accounts
         set metadata = coalesce(metadata, '{}'::jsonb)
                        || jsonb_build_object(
                             'sso_identities_before',
                             coalesce(metadata->'sso_identities_before', '[]'::jsonb) || v_released,
                             'sso_released_at', now())
       where id = v_register;
    end if;

    insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    values (null, 'release_sso_identities', 'auth.identities', p_user_id,
            'Deleted account: Google/Apple sign-in freed for reuse',
            jsonb_build_object('identities', v_released, 'register_id', v_register));
  end if;

  return jsonb_build_object('ok', true, 'released', jsonb_array_length(v_released));
end;
$$;

create or replace function public.admin_restore_sso_identities(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_register uuid;
  v_saved jsonb;
  v_item jsonb;
  v_restored int := 0;
  v_skipped jsonb := '[]'::jsonb;
begin
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null or v_email like 'deleted+%@deleted.invalid' then
    return jsonb_build_object('ok', false, 'reason', 'login_still_tombstoned');
  end if;

  select id, metadata->'sso_identities_before' into v_register, v_saved
    from public.deleted_accounts
   where user_id = p_user_id
   order by deleted_at desc
   limit 1;

  if v_saved is null or jsonb_typeof(v_saved) <> 'array' or jsonb_array_length(v_saved) = 0 then
    return jsonb_build_object('ok', true, 'restored', 0, 'skipped', v_skipped);
  end if;

  for v_item in select * from jsonb_array_elements(v_saved) loop
    if exists (select 1 from auth.identities
                where provider = v_item->>'provider'
                  and provider_id = v_item->>'provider_id') then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'provider', v_item->>'provider',
        'email', v_item->'identity_data'->>'email',
        'reason', 'linked_to_another_login'));
    else
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (v_item->>'provider_id', p_user_id, v_item->'identity_data', v_item->>'provider',
              (v_item->>'last_sign_in_at')::timestamptz,
              coalesce((v_item->>'created_at')::timestamptz, now()), now());
      v_restored := v_restored + 1;
    end if;
  end loop;

  update public.deleted_accounts
     set metadata = (metadata - 'sso_identities_before')
                    || jsonb_build_object('sso_identities_restored', v_saved,
                                          'sso_restored_at', now(),
                                          'sso_restore_skipped', v_skipped)
   where id = v_register;

  return jsonb_build_object('ok', true, 'restored', v_restored, 'skipped', v_skipped);
end;
$$;

revoke execute on function public.admin_release_sso_identities(uuid) from public, anon, authenticated;
grant  execute on function public.admin_release_sso_identities(uuid) to service_role;
revoke execute on function public.admin_restore_sso_identities(uuid) from public, anon, authenticated;
grant  execute on function public.admin_restore_sso_identities(uuid) to service_role;

-- Backfill: free the Google/Apple sign-ins still held by already-deleted accounts.
do $$
declare r record;
begin
  for r in
    select distinct i.user_id
      from auth.identities i
      join auth.users u on u.id = i.user_id
     where u.email like 'deleted+%@deleted.invalid'
       and i.provider not in ('email', 'phone')
  loop
    perform public.admin_release_sso_identities(r.user_id);
  end loop;
end;
$$;
