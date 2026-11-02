create or replace function public.otp_reserve_send(
  p_phone text, p_user_id uuid, p_ip text, p_new_code text, p_ttl_seconds int,
  p_cooldown_seconds int, p_max_phone_hour int, p_max_user_hour int, p_max_user_day int,
  p_max_ip_hour int, p_max_ip_day int
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.otp_verifications%rowtype;
  v_n int; v_n2 int; v_remaining int; v_window timestamptz; v_count int;
  v_reuse boolean; v_code text; v_exp timestamptz;
begin
  -- Fixed lock order (phone, user, ip) so concurrent sends serialize without deadlocks.
  perform pg_advisory_xact_lock(hashtext('otp_phone:' || p_phone));
  if p_user_id is not null then perform pg_advisory_xact_lock(hashtext('otp_user:' || p_user_id::text)); end if;
  if p_ip is not null then perform pg_advisory_xact_lock(hashtext('otp_ip:' || p_ip)); end if;

  if p_user_id is not null then
    select count(*) filter (where created_at >= v_now - interval '1 hour'), count(*) into v_n, v_n2
      from public.otp_send_events where user_id = p_user_id and created_at >= v_now - interval '1 day';
    if v_n >= p_max_user_hour then
      return jsonb_build_object('ok', false, 'error', 'Too many code requests. Please try again in about an hour.', 'retry_after', 3600);
    end if;
    if v_n2 >= p_max_user_day then
      return jsonb_build_object('ok', false, 'error', 'Daily verification-code limit reached. Please try again tomorrow.', 'retry_after', 21600);
    end if;
  end if;
  if p_ip is not null then
    select count(*) filter (where created_at >= v_now - interval '1 hour'), count(*) into v_n, v_n2
      from public.otp_send_events where ip = p_ip and created_at >= v_now - interval '1 day';
    if v_n >= p_max_ip_hour or v_n2 >= p_max_ip_day then
      return jsonb_build_object('ok', false, 'error', 'Too many verification requests from your network. Please try again later.', 'retry_after', 3600);
    end if;
  end if;

  select * into v_row from public.otp_verifications where phone = p_phone for update;

  if found and v_row.last_sent_at is not null then
    v_remaining := ceil(p_cooldown_seconds - extract(epoch from (v_now - v_row.last_sent_at)))::int;
    if v_remaining > 0 then
      return jsonb_build_object('ok', false, 'error', format('Please wait %ss before requesting another code.', v_remaining), 'retry_after', v_remaining);
    end if;
  end if;

  v_window := v_row.send_window_start; v_count := coalesce(v_row.send_count, 0);
  if v_window is null or v_now - v_window > interval '1 hour' then v_window := v_now; v_count := 0; end if;
  if v_count >= p_max_phone_hour then
    v_remaining := ceil(3600 - extract(epoch from (v_now - v_window)))::int;
    return jsonb_build_object('ok', false, 'retry_after', v_remaining,
      'error', format('Too many code requests. Please try again in about %s minute(s).', ceil(v_remaining / 60.0)::int));
  end if;

  v_reuse := v_row.otp_code is not null and v_row.verified = false and v_row.expires_at > v_now;
  v_code := case when v_reuse then v_row.otp_code else p_new_code end;
  v_exp := case when v_reuse then v_row.expires_at else v_now + make_interval(secs => p_ttl_seconds) end;

  insert into public.otp_verifications as o (phone, otp_code, expires_at, attempts, verified, last_sent_at,
                                             send_count, send_window_start, send_status, send_status_reason, send_status_at)
  values (p_phone, v_code, v_exp, 0, false, v_now, v_count + 1, v_window, 'pending', null, v_now)
  on conflict (phone) do update set
    otp_code = excluded.otp_code, expires_at = excluded.expires_at,
    attempts = case when v_reuse then o.attempts else 0 end,
    verified = false, last_sent_at = excluded.last_sent_at, send_count = excluded.send_count,
    send_window_start = excluded.send_window_start, send_status = 'pending',
    send_status_reason = null, send_status_at = excluded.send_status_at, updated_at = now();

  insert into public.otp_send_events (user_id, phone, ip, outcome)
  values (p_user_id, p_phone, p_ip, case when v_reuse then 'resent' else 'sent' end);

  return jsonb_build_object('ok', true, 'otp', v_code, 'expires_at', v_exp, 'reused', v_reuse);
end;
$$;

create or replace function public.otp_check_code(p_phone text, p_code text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_row public.otp_verifications%rowtype;
begin
  select * into v_row from public.otp_verifications where phone = p_phone for update;
  if not found then return jsonb_build_object('result', 'missing'); end if;
  if v_row.verified then return jsonb_build_object('result', 'already_verified'); end if;
  if v_row.expires_at < clock_timestamp() then return jsonb_build_object('result', 'expired'); end if;
  if v_row.attempts >= 5 then return jsonb_build_object('result', 'locked'); end if;
  if p_code is distinct from v_row.otp_code then
    update public.otp_verifications set attempts = attempts + 1, updated_at = now()
     where phone = p_phone returning attempts into v_row.attempts;
    return jsonb_build_object('result', 'wrong', 'remaining', greatest(0, 5 - v_row.attempts));
  end if;
  update public.otp_verifications set verified = true, verified_at = now(), updated_at = now() where phone = p_phone;
  return jsonb_build_object('result', 'verified');
end;
$$;

revoke all on function public.otp_reserve_send(text, uuid, text, text, int, int, int, int, int, int, int) from public, anon, authenticated;
revoke all on function public.otp_check_code(text, text) from public, anon, authenticated;
grant execute on function public.otp_reserve_send(text, uuid, text, text, int, int, int, int, int, int, int) to service_role;
grant execute on function public.otp_check_code(text, text) to service_role;