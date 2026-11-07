-- =====================================================================
-- Final submission as a chat
-- Each final (a row in runs with kind = 'final') now has one or more chat
-- turns. Turn 1 is the original final input; every follow-up message adds a
-- turn. runs.output_html always holds the latest finished output.
-- Inputs  = turns that didn't fail
-- Outputs = turns that finished
-- Safe to run more than once.
-- =====================================================================

create table if not exists public.chat_turns (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.runs (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  n              int  not null,                        -- 1, 2, 3 … within the chat
  prompt         text not null,
  attachments    jsonb not null default '[]'::jsonb,
  output_html    text,
  status         text not null default 'generating'
                   check (status in ('generating', 'done', 'error')),
  error          text,
  model          text,
  input_tokens   int,
  output_tokens  int,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz,
  unique (run_id, n)
);

create index if not exists chat_turns_user_status on public.chat_turns (user_id, status);

alter table public.chat_turns enable row level security;

-- Finals are public, so their chats are too. Rows are written only by the
-- edge function (service role).
drop policy if exists "chats of finals are public" on public.chat_turns;
create policy "chats of finals are public"
  on public.chat_turns for select
  using (exists (select 1 from public.runs r where r.id = run_id and r.kind = 'final'));

-- Max messages in a final chat, including the first (0 = unlimited)
alter table public.settings add column if not exists chat_limit int not null default 20;

-- Existing finals become a one-turn chat
insert into public.chat_turns
  (run_id, user_id, n, prompt, attachments, output_html, status, error, model,
   input_tokens, output_tokens, created_at, finished_at)
select r.id, r.user_id, 1, r.prompt, r.attachments, r.output_html, r.status, r.error, r.model,
       r.input_tokens, r.output_tokens, r.created_at, r.finished_at
from public.runs r
where r.kind = 'final'
  and not exists (select 1 from public.chat_turns t where t.run_id = r.id);
