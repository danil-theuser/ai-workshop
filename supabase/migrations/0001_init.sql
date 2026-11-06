-- =====================================================================
-- AI Workshop — One-Shot Build Challenge
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Only USF emails can create an account
--    (edit the list here AND in site/ai-workshop/config.js AND in the
--     edge function if you ever change the allowed domains)
-- ---------------------------------------------------------------------
create or replace function public.enforce_usf_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(split_part(coalesce(new.email, ''), '@', 2))
       not in ('usfca.edu', 'dons.usfca.edu', 'cs.usfca.edu') then
    raise exception 'Only usfca.edu, dons.usfca.edu and cs.usfca.edu email addresses can sign up.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_usf_domain on auth.users;
create trigger enforce_usf_domain
  before insert or update of email on auth.users
  for each row execute function public.enforce_usf_domain();

-- ---------------------------------------------------------------------
-- 2. Profiles (public username; email is NOT stored here so it stays private)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text not null unique check (username ~ '^[a-z0-9_-]{3,24}$'),
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are readable by everyone" on public.profiles;
create policy "profiles are readable by everyone"
  on public.profiles for select using (true);

drop policy if exists "users create their own profile" on public.profiles;
create policy "users create their own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

drop policy if exists "users update their own profile" on public.profiles;
create policy "users update their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------
-- 3. Settings (one row — edit it in Table Editor during the event)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  final_open  boolean not null default true,          -- set false to close final submissions
  test_limit  int     not null default 25,             -- practice runs per person (0 = unlimited)
  model       text    not null default 'claude-sonnet-5-5',
  max_tokens  int     not null default 16000           -- max length of each generated product
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

alter table public.settings enable row level security;
drop policy if exists "settings are readable by everyone" on public.settings;
create policy "settings are readable by everyone"
  on public.settings for select using (true);
-- (no insert/update policy: only you, via the dashboard, can change settings)

-- ---------------------------------------------------------------------
-- 4. Runs — every practice test and every final submission
--    Rows are only written by the edge function (service role).
-- ---------------------------------------------------------------------
create table if not exists public.runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  kind           text not null check (kind in ('test', 'final')),
  prompt         text not null,
  attachments    jsonb not null default '[]'::jsonb,   -- [{name, path, url, mime}]
  output_html    text,
  status         text not null default 'generating'
                   check (status in ('generating', 'done', 'error')),
  error          text,
  model          text,
  input_tokens   int,
  output_tokens  int,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);

-- One final per person (a final that failed with an error doesn't count)
create unique index if not exists runs_one_final_per_user
  on public.runs (user_id) where kind = 'final' and status <> 'error';

create index if not exists runs_user_created on public.runs (user_id, created_at desc);
create index if not exists runs_finals on public.runs (created_at desc) where kind = 'final';

alter table public.runs enable row level security;

-- Finals are public; practice tests are visible only to their owner
drop policy if exists "finals public, tests private" on public.runs;
create policy "finals public, tests private"
  on public.runs for select
  using (kind = 'final' or user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 5. Storage bucket for reference files people attach
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'references', 'references', true, 10485760,  -- 10 MB per file
  array['image/png','image/jpeg','image/gif','image/webp',
        'application/pdf','text/plain','text/markdown','text/csv','application/json']
)
on conflict (id) do nothing;

drop policy if exists "users upload into their own folder" on storage.objects;
create policy "users upload into their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'references'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
