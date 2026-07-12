create table public.live_matches (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id),
  match_type text not null check (match_type in ('official', 'friendly')),
  format text not null check (format in ('1v1', 'teams')),
  status text not null default 'live' check (status in ('live', 'completed', 'abandoned')),
  created_by uuid not null references public.profiles(id),
  finished_match_id uuid references public.matches(id),
  created_at timestamptz not null default now()
);

create table public.live_participants (
  live_match_id uuid not null references public.live_matches(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  side text not null check (side in ('a', 'b')),
  primary key (live_match_id, profile_id)
);

create table public.live_events (
  id bigint generated always as identity primary key,
  live_match_id uuid not null references public.live_matches(id) on delete cascade,
  event_type text not null check (event_type in ('point', 'undo')),
  side text check (side in ('a', 'b')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check ((event_type = 'point') = (side is not null))
);

alter table public.live_matches enable row level security;
alter table public.live_participants enable row level security;
alter table public.live_events enable row level security;

create function public.is_live_participant(m uuid)
returns boolean
language sql security definer set search_path = ''
stable
as $$
  select exists (
    select 1 from public.live_participants
    where live_match_id = m and profile_id = (select auth.uid())
  );
$$;

create function public.is_friend_of_live_participant(m uuid)
returns boolean
language sql security definer set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.live_participants lp
    join public.friendships f
      on f.status = 'accepted'
     and ((f.requester_id = (select auth.uid()) and f.addressee_id = lp.profile_id)
       or (f.addressee_id = (select auth.uid()) and f.requester_id = lp.profile_id))
    where lp.live_match_id = m
  );
$$;

create policy "participants and friends can read live matches"
  on public.live_matches for select to authenticated
  using (public.is_live_participant(id) or public.is_friend_of_live_participant(id));

create policy "participants and friends can read live participants"
  on public.live_participants for select to authenticated
  using (public.is_live_participant(live_match_id) or public.is_friend_of_live_participant(live_match_id));

create policy "participants and friends can read live events"
  on public.live_events for select to authenticated
  using (public.is_live_participant(live_match_id) or public.is_friend_of_live_participant(live_match_id));

create policy "participants can score while live"
  on public.live_events for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.is_live_participant(live_match_id)
    and exists (select 1 from public.live_matches where id = live_match_id and status = 'live')
  );

create function public.start_live_match(
  p_sport_id text,
  p_match_type text,
  p_format text,
  p_participants jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_count integer;
  v_count_a integer;
  v_count_b integer;
  p jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_sport_id not in ('tennis', 'padel', 'badminton', 'pickleball', 'table_tennis') then
    raise exception 'live scoring is racquet sports only';
  end if;
  if p_match_type not in ('official', 'friendly') then
    raise exception 'invalid match type';
  end if;
  if p_format not in ('1v1', 'teams') then
    raise exception 'invalid format';
  end if;
  if jsonb_typeof(p_participants) <> 'array' then
    raise exception 'participants must be an array';
  end if;

  select count(*) into v_count from jsonb_array_elements(p_participants);
  if (select count(distinct e->>'profile_id') from jsonb_array_elements(p_participants) e) <> v_count then
    raise exception 'duplicate participants';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(p_participants) e
    where (e->>'profile_id')::uuid = v_uid
  ) then
    raise exception 'creator must be a participant';
  end if;
  select count(*) filter (where e->>'side' = 'a'),
         count(*) filter (where e->>'side' = 'b')
    into v_count_a, v_count_b
    from jsonb_array_elements(p_participants) e;
  if v_count_a + v_count_b <> v_count then
    raise exception 'every participant needs a side';
  end if;
  if v_count_a < 1 or v_count_b < 1 then
    raise exception 'both sides need at least one player';
  end if;
  if p_format = '1v1' and (v_count <> 2 or v_count_a <> 1) then
    raise exception '1v1 needs exactly one player per side';
  end if;

  insert into public.live_matches (sport_id, match_type, format, created_by)
  values (p_sport_id, p_match_type, p_format, v_uid)
  returning id into v_id;

  for p in select * from jsonb_array_elements(p_participants) loop
    insert into public.live_participants (live_match_id, profile_id, side)
    values (v_id, (p->>'profile_id')::uuid, p->>'side');
  end loop;

  return v_id;
end;
$$;

create function public.finish_live_match(
  p_live_match_id uuid,
  p_score_a integer,
  p_score_b integer
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_live public.live_matches;
  v_match_id uuid;
  v_outcome text;
  r record;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  select * into v_live from public.live_matches where id = p_live_match_id for update;
  if not found then
    raise exception 'live match not found';
  end if;
  if v_live.status <> 'live' then
    raise exception 'match is not live';
  end if;
  if not exists (
    select 1 from public.live_participants
    where live_match_id = p_live_match_id and profile_id = v_uid
  ) then
    raise exception 'only participants can finish';
  end if;
  if p_score_a is null or p_score_b is null or p_score_a < 0 or p_score_b < 0 then
    raise exception 'invalid scores';
  end if;
  if p_score_a = p_score_b then
    raise exception 'racquet matches cannot draw';
  end if;

  insert into public.matches (sport_id, match_type, format, score_a, score_b, created_by)
  values (v_live.sport_id, v_live.match_type, v_live.format, p_score_a, p_score_b, v_live.created_by)
  returning id into v_match_id;

  for r in select profile_id, side from public.live_participants where live_match_id = p_live_match_id loop
    if (r.side = 'a') = (p_score_a > p_score_b) then
      v_outcome := 'win';
    else
      v_outcome := 'loss';
    end if;
    insert into public.match_participants (match_id, profile_id, side, rank, score, stats, outcome)
    values (v_match_id, r.profile_id, r.side, null, null, null, v_outcome);
  end loop;

  update public.live_matches
  set status = 'completed', finished_match_id = v_match_id
  where id = p_live_match_id;

  return v_match_id;
end;
$$;

create function public.abandon_live_match(p_live_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  select status into v_status from public.live_matches where id = p_live_match_id for update;
  if not found then
    raise exception 'live match not found';
  end if;
  if v_status <> 'live' then
    raise exception 'match is not live';
  end if;
  if not exists (
    select 1 from public.live_participants
    where live_match_id = p_live_match_id and profile_id = v_uid
  ) then
    raise exception 'only participants can abandon';
  end if;
  update public.live_matches set status = 'abandoned' where id = p_live_match_id;
end;
$$;

revoke execute on function public.start_live_match from public, anon;
grant execute on function public.start_live_match to authenticated;
revoke execute on function public.finish_live_match from public, anon;
grant execute on function public.finish_live_match to authenticated;
revoke execute on function public.abandon_live_match from public, anon;
grant execute on function public.abandon_live_match to authenticated;

alter publication supabase_realtime add table public.live_events, public.live_matches;
