-- Agent assistant: help-centre knowledge for how-to questions.
--
-- help.welileapp.com is synced into a table by the help-center-sync edge function (service role,
-- fixed host). The assistant never browses the site while someone is chatting: it searches this
-- table through assistant_agent_help_search(), which needs no identity because the content is the
-- same for everyone. Only signed-in people with assistant access can search it.
--
-- The article text is public documentation, but it is still treated as untrusted data by the
-- assistant (it is fenced like every tool result). Regulatory terminology is enforced here too:
-- the excerpt that reaches the model has loan / lender / ROI / interest replaced, so a quoted
-- sentence cannot trip the terminology guard or put banned words in front of a user.

create table if not exists public.help_center_articles (
  url          text primary key,
  path         text not null,
  title        text not null,
  body         text not null,
  content_hash text not null,
  fetched_at   timestamptz not null default now(),
  changed_at   timestamptz not null default now(),
  tsv          tsvector generated always as (
                 setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                 setweight(to_tsvector('english', coalesce(body, '')), 'B')) stored
);

create index if not exists help_center_articles_tsv_idx on public.help_center_articles using gin (tsv);

alter table public.help_center_articles enable row level security;

-- No policy for authenticated or anon: nobody reads the table directly. Writes come from the sync
-- function (service role bypasses RLS); reads come from the definer function below.
revoke all on public.help_center_articles from public, anon, authenticated;
grant select, insert, update, delete on public.help_center_articles to service_role;

create policy mfa_required_for_staff on public.help_center_articles
  as restrictive for all to authenticated
  using ((select public.staff_mfa_ok()))
  with check ((select public.staff_mfa_ok()));

-- Words the platform must never show a user, mapped to the approved ones.
create or replace function public.assistant_clean_terms(p_text text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(coalesce(p_text, ''), '\m(loans?)\M', 'Rent Plan', 'gi'),
               '\m(lenders?)\M', 'Supporter', 'gi'),
             '\mROI\M', 'Returns', 'gi'),
           '\minterest\M', 'charges', 'gi');
$$;

revoke execute on function public.assistant_clean_terms(text) from public, anon, authenticated;
grant  execute on function public.assistant_clean_terms(text) to service_role;

create or replace function public.assistant_agent_help_search(
  p_query text,
  p_limit integer default 4
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q      text := nullif(btrim(left(coalesce(p_query, ''), 120)), '');
  v_limit  integer := least(greatest(coalesce(p_limit, 4), 1), 5);
  v_tsq    tsquery;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.assistant_has_access() then
    raise exception 'assistant_not_enabled' using errcode = '42501';
  end if;
  if v_q is null or length(v_q) < 3 then
    raise exception 'search_required' using errcode = '22023';
  end if;

  -- Any-word match (OR), ranked by how many words hit: people phrase questions loosely, and an
  -- AND query returns nothing as soon as one word (say 'client' vs 'tenant') is missing.
  v_tsq := nullif(replace(websearch_to_tsquery('english', v_q)::text, ' & ', ' | '), '')::tsquery;
  if v_tsq is null then
    return jsonb_build_object('query', v_q, 'results', '[]'::jsonb);
  end if;

  select jsonb_build_object(
    'query', v_q,
    'articles_searched', (select count(*) from public.help_center_articles),
    'results', coalesce((
      select jsonb_agg(jsonb_build_object(
               'title',   public.assistant_clean_terms(left(r.title, 140)),
               'url',     r.url,
               'updated', r.changed_at::date,
               'excerpt', left(public.assistant_clean_terms(regexp_replace(r.excerpt, '<<|>>', '', 'g')), 900)) order by r.rank desc)
        from (
          select a.title, a.url, a.changed_at,
                 ts_rank_cd(a.tsv, v_tsq) as rank,
                 ts_headline('english', a.body, v_tsq,
                   'MaxWords=90, MinWords=40, MaxFragments=2, FragmentDelimiter=" ... ", StartSel=<<, StopSel=>>') as excerpt
            from public.help_center_articles a
           where a.tsv @@ v_tsq
           order by ts_rank_cd(a.tsv, v_tsq) desc
           limit v_limit) r), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_agent_help_search(text, integer) from public, anon;
grant  execute on function public.assistant_agent_help_search(text, integer) to authenticated, service_role;