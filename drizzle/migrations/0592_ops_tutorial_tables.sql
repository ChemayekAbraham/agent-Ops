create sequence if not exists public.ops_tutorial_topic_seq;
create sequence if not exists public.ops_tutorial_video_seq;
create sequence if not exists public.ops_tutorial_claim_seq;

create table if not exists public.ops_tutorial_members (
  user_id uuid not null,
  member_role text not null check (member_role in ('creator','reviewer')),
  enabled boolean not null default true,
  note text,
  added_by uuid,
  added_at timestamptz not null default now(),
  primary key (user_id, member_role)
);

create table if not exists public.ops_tutorial_rates (
  tier text primary key check (tier in ('basic','standard','advanced','revision')),
  amount_ugx numeric(14,2) not null default 0 check (amount_ugx >= 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_tutorial_topics (
  id uuid primary key default gen_random_uuid(),
  topic_code text not null unique default ('TT-' || lpad(nextval('public.ops_tutorial_topic_seq')::text, 4, '0')),
  title text not null check (length(btrim(title)) >= 5),
  description text,
  tier text not null check (tier in ('basic','standard','advanced')),
  status text not null default 'proposed' check (status in ('proposed','open','closed')),
  proposed_by uuid not null,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.ops_tutorial_videos (
  id uuid primary key default gen_random_uuid(),
  video_code text not null unique default ('TV-' || lpad(nextval('public.ops_tutorial_video_seq')::text, 6, '0')),
  topic_id uuid not null references public.ops_tutorial_topics(id),
  kind text not null check (kind in ('original','revision')),
  supersedes_video_id uuid references public.ops_tutorial_videos(id),
  revision_reason text,
  title text not null check (length(btrim(title)) >= 5),
  uploaded_by uuid not null,
  storage_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  duration_seconds numeric(8,1) not null check (duration_seconds > 0),
  mime_type text not null check (mime_type = 'video/mp4'),
  video_codec text not null check (video_codec like 'avc1%'),
  recorded_on date,
  status text not null default 'uploading'
    check (status in ('uploading','draft','submitted','accepted','rejected','withdrawn')),
  uploaded_at timestamptz,
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  no_personal_data_confirmed boolean,
  rate_tier text,
  rate_amount numeric(14,2),
  published_at timestamptz,
  published_by uuid,
  created_at timestamptz not null default now(),
  constraint ops_tutorial_videos_kind_chk check (
    (kind = 'original' and supersedes_video_id is null)
    or (kind = 'revision' and supersedes_video_id is not null
        and length(btrim(coalesce(revision_reason,''))) >= 10)),
  constraint ops_tutorial_videos_accept_chk check (
    status <> 'accepted'
    or (reviewed_by is not null and no_personal_data_confirmed is true and rate_amount > 0)),
  constraint ops_tutorial_videos_publish_chk check (published_at is null or status = 'accepted')
);
create unique index if not exists ops_tutorial_videos_sha_live_uq
  on public.ops_tutorial_videos (sha256) where status <> 'withdrawn';
create unique index if not exists ops_tutorial_videos_one_original_uq
  on public.ops_tutorial_videos (topic_id)
  where kind = 'original' and status in ('uploading','draft','submitted','accepted');
create index if not exists ops_tutorial_videos_uploader_idx
  on public.ops_tutorial_videos (uploaded_by, created_at desc);

create table if not exists public.ops_tutorial_view_events (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.ops_tutorial_videos(id),
  viewer_id uuid not null,
  context text not null check (context in ('review','approval','library','own')),
  requisition_id uuid references public.staff_requisitions(id),
  max_position_seconds numeric(8,1) not null default 0 check (max_position_seconds >= 0),
  duration_seconds numeric(8,1) not null,
  first_played_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create unique index if not exists ops_tutorial_view_events_uq
  on public.ops_tutorial_view_events
  (video_id, viewer_id, context, coalesce(requisition_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.ops_tutorial_claims (
  id uuid primary key default gen_random_uuid(),
  claim_code text not null unique default ('TVC-' || lpad(nextval('public.ops_tutorial_claim_seq')::text, 6, '0')),
  creator_id uuid not null,
  total_amount numeric(14,2) not null check (total_amount > 0),
  status text not null default 'draft' check (status in ('draft','submitted','cancelled','released')),
  requisition_id uuid unique references public.staff_requisitions(id),
  created_at timestamptz not null default now(),
  linked_at timestamptz,
  closed_at timestamptz,
  constraint ops_tutorial_claims_link_chk
    check ((status in ('submitted','released')) = (requisition_id is not null))
);
create unique index if not exists ops_tutorial_claims_one_draft_uq
  on public.ops_tutorial_claims (creator_id) where status = 'draft';

create table if not exists public.ops_tutorial_claim_lines (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.ops_tutorial_claims(id),
  video_id uuid not null references public.ops_tutorial_videos(id),
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  unique (claim_id, video_id)
);
-- The double-billing control: a video can sit on only one live claim line.
create unique index if not exists ops_tutorial_claim_lines_one_live_uq
  on public.ops_tutorial_claim_lines (video_id) where released_at is null;

alter table public.ops_tutorial_members     enable row level security;
alter table public.ops_tutorial_rates       enable row level security;
alter table public.ops_tutorial_topics      enable row level security;
alter table public.ops_tutorial_videos      enable row level security;
alter table public.ops_tutorial_view_events enable row level security;
alter table public.ops_tutorial_claims      enable row level security;
alter table public.ops_tutorial_claim_lines enable row level security;

-- Explicit grants. All writes go through SECURITY DEFINER functions added later.
revoke all on public.ops_tutorial_members, public.ops_tutorial_rates, public.ops_tutorial_topics,
  public.ops_tutorial_videos, public.ops_tutorial_view_events, public.ops_tutorial_claims,
  public.ops_tutorial_claim_lines from anon, authenticated;
grant select on public.ops_tutorial_members, public.ops_tutorial_rates, public.ops_tutorial_topics,
  public.ops_tutorial_videos, public.ops_tutorial_view_events, public.ops_tutorial_claims,
  public.ops_tutorial_claim_lines to authenticated;
grant select, insert, update on public.ops_tutorial_members, public.ops_tutorial_rates, public.ops_tutorial_topics,
  public.ops_tutorial_videos, public.ops_tutorial_view_events, public.ops_tutorial_claims,
  public.ops_tutorial_claim_lines to service_role;
revoke all on sequence public.ops_tutorial_topic_seq, public.ops_tutorial_video_seq,
  public.ops_tutorial_claim_seq from anon, authenticated;
grant usage, select on sequence public.ops_tutorial_topic_seq, public.ops_tutorial_video_seq,
  public.ops_tutorial_claim_seq to service_role;