CREATE OR REPLACE FUNCTION public.promissory_fuzzy_arrival_suggestions(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_from timestamptz := coalesce(p_from, '1970-01-01'::timestamptz);
  v_to timestamptz := coalesce(p_to, now() + interval '1 day');
  v_rate_creation numeric := public.promissory_commission_rate('portfolio_creation');
  v_result jsonb;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not (
    public.is_ops_role(v_uid)
    or public.has_role(v_uid, 'ceo') or public.has_role(v_uid, 'coo')
    or public.has_role(v_uid, 'cfo') or public.has_role(v_uid, 'manager')
    or public.has_role(v_uid, 'super_admin') or public.has_role(v_uid, 'partner_ops')
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  with pf as materialized (
    select p.id, p.full_name, p.phone, p.created_at,
           lower(regexp_replace(btrim(p.full_name), '\s+', ' ', 'g')) as nmk,
           nullif(right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9), '') as pk,
           nullif(lower(btrim(coalesce(p.email,''))), '') as em
    from public.profiles p
    where p.full_name is not null and length(btrim(p.full_name)) >= 5
  ),
  notes as materialized (
    select n.id, n.partner_name, n.created_at,
           nullif(right(regexp_replace(coalesce(n.whatsapp_number,''), '\D', '', 'g'), 9), '') as k1,
           nullif(right(regexp_replace(coalesce(n.phone_number,''), '\D', '', 'g'), 9), '') as k2,
           nullif(lower(btrim(coalesce(n.email,''))), '') as em,
           lower(regexp_replace(btrim(coalesce(n.partner_name,'')), '\s+', ' ', 'g')) as nmk
    from public.promissory_notes n
    where n.created_at >= v_from and n.created_at < v_to
      and (
        n.partner_user_id is null
        or not exists (select 1 from public.profiles pr where pr.id = n.partner_user_id)
      )
      and length(btrim(coalesce(n.partner_name,''))) >= 5
  ),
  resolved as materialized (
    select distinct nt.id from notes nt join pf p on p.pk = nt.k1 where nt.k1 is not null
    union
    select distinct nt.id from notes nt join pf p on p.pk = nt.k2 where nt.k2 is not null
    union
    select distinct nt.id from notes nt join pf p on p.em = nt.em where nt.em is not null
    union
    select distinct nt.id from notes nt join pf p on p.nmk = nt.nmk
  ),
  unresolved as materialized (
    select nt.* from notes nt
    where not exists (select 1 from resolved r where r.id = nt.id)
  ),
  ntok as materialized (
    select u.id as note_id, t from unresolved u, lateral unnest(string_to_array(u.nmk, ' ')) t
    where length(t) >= 3
  ),
  ptok as materialized (
    select p.id, t from pf p, lateral unnest(string_to_array(p.nmk, ' ')) t
    where length(t) >= 3
  ),
  pairs as materialized (
    select nt.note_id, pt.id as cand, count(distinct nt.t) as shared
    from ntok nt join ptok pt on pt.t = nt.t
    group by 1, 2
    having count(distinct nt.t) >= 2
  ),
  scored as materialized (
    select pr.note_id, pr.shared,
           u.partner_name, u.nmk as note_nmk, u.created_at as note_created_at,
           p.id as candidate_user_id, p.full_name as candidate_name,
           p.phone as candidate_phone, p.em as candidate_email, p.created_at as candidate_created_at,
           similarity(p.nmk, u.nmk) as score
    from pairs pr
    join unresolved u on u.id = pr.note_id
    join pf p on p.id = pr.cand
  ),
  prin as materialized (
    select ip.investor_id,
           count(*)::int as portfolio_count,
           coalesce(sum(ip.investment_amount), 0) as portfolio_amount,
           coalesce(sum(ip.investment_amount) filter (where ip.status = 'active'), 0) as active_amount
    from public.investor_portfolios ip
    where ip.investor_id in (select distinct candidate_user_id from scored)
    group by ip.investor_id
  ),
  ranked as (
    select s.*,
           coalesce(pn.portfolio_count, 0) as portfolio_count,
           coalesce(pn.portfolio_amount, 0) as portfolio_amount,
           coalesce(pn.active_amount, 0) as portfolio_active_amount,
           row_number() over (partition by s.note_id order by s.shared desc, s.score desc, s.candidate_created_at asc) as rn,
           count(*) over (partition by s.note_id) as candidate_count
    from scored s
    left join prin pn on pn.investor_id = s.candidate_user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'note_id', r.note_id,
           'partner_name', r.partner_name,
           'note_created_at', r.note_created_at,
           'candidate_user_id', r.candidate_user_id,
           'candidate_name', r.candidate_name,
           'candidate_phone', r.candidate_phone,
           'candidate_email', r.candidate_email,
           'candidate_created_at', r.candidate_created_at,
           'shared_words', r.shared,
           'similarity', round(r.score::numeric, 3),
           'candidate_count', r.candidate_count,
           'rank', r.rn,
           'candidate_portfolio_count', r.portfolio_count,
           'candidate_principal', r.portfolio_amount,
           'candidate_principal_active', r.portfolio_active_amount,
           'commission_rate', v_rate_creation,
           'commission_due', round(r.portfolio_amount * v_rate_creation),
           'confidence', case
                           when r.shared >= 3 or r.score >= 0.8 then 'high'
                           when r.score >= 0.6 then 'medium'
                           else 'low'
                         end
         ) order by r.shared desc, r.score desc), '[]'::jsonb)
    into v_result
  from ranked r
  where r.rn <= 3;

  return jsonb_build_object('suggestions', v_result, 'rate_creation', v_rate_creation, 'generated_at', now());
end;
$function$;