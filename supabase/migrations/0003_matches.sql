create table public.matches (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id),
  match_type text not null default 'official' check (match_type in ('official', 'friendly')),
  played_at date not null default current_date,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.match_participants (
  match_id uuid not null references public.matches(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  score integer not null default 0 check (score >= 0),
  outcome text not null check (outcome in ('win', 'loss', 'draw')),
  primary key (match_id, profile_id)
);

alter table public.matches enable row level security;
alter table public.match_participants enable row level security;

create function public.is_match_participant(m uuid)
returns boolean
language sql security definer set search_path = ''
stable
as $$
  select exists (
    select 1 from public.match_participants
    where match_id = m and profile_id = (select auth.uid())
  );
$$;

create policy "participants can read their matches"
  on public.matches for select to authenticated
  using (public.is_match_participant(id) or created_by = (select auth.uid()));

create policy "creator can insert a match"
  on public.matches for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "participants can read match participants"
  on public.match_participants for select to authenticated
  using (public.is_match_participant(match_id));

create policy "match creator can insert participants"
  on public.match_participants for insert to authenticated
  with check (
    exists (
      select 1 from public.matches
      where id = match_id and created_by = (select auth.uid())
    )
  );
