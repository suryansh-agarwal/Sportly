-- M5: skill ratings + trust hardening
-- Rating math runs ONLY here (server-side). Clients read `ratings` and display.

-- 1) Schema
create table public.ratings (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  sport_id text not null references public.sports(id),
  rating numeric not null default 1000,
  matches_played integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (profile_id, sport_id)
);

alter table public.ratings enable row level security;

create policy "authenticated users can read ratings"
  on public.ratings for select to authenticated using (true);
-- no client writes: no insert/update/delete policies

alter table public.match_participants
  add column rating_after numeric,
  add column rating_delta numeric;

-- 2) The rating engine (internal — no client role may execute)
create function public.apply_match_rating(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match public.matches;
  v_margin numeric := 1;
  v_n integer;
begin
  select * into v_match from public.matches where id = p_match_id;
  if not found then
    raise exception 'match not found';
  end if;
  if v_match.match_type <> 'official' then
    return;
  end if;
  -- idempotence guard: already applied (backfill + double-call safe)
  if exists (
    select 1 from public.match_participants
    where match_id = p_match_id and rating_delta is not null
  ) then
    return;
  end if;

  select count(*) into v_n
  from public.match_participants where match_id = p_match_id;

  insert into public.ratings (profile_id, sport_id)
  select profile_id, v_match.sport_id
  from public.match_participants
  where match_id = p_match_id
  on conflict (profile_id, sport_id) do nothing;

  -- lock participants' rating rows against concurrent application
  perform 1 from public.ratings
  where sport_id = v_match.sport_id
    and profile_id in (select profile_id from public.match_participants
                       where match_id = p_match_id)
  for update;

  if v_match.format in ('1v1', 'teams') then
    if v_match.score_a is not null and v_match.score_b is not null
       and v_match.score_a + v_match.score_b > 0 then
      v_margin := least(
        1 + 0.5 * abs(v_match.score_a - v_match.score_b)::numeric
              / (v_match.score_a + v_match.score_b),
        1.5);
    end if;

    -- deltas from pre-match ratings and opposing side mean, all in one statement
    with parts as (
      select mp.profile_id, mp.side, mp.outcome, rt.rating, rt.matches_played
      from public.match_participants mp
      join public.ratings rt
        on rt.profile_id = mp.profile_id and rt.sport_id = v_match.sport_id
      where mp.match_id = p_match_id
    ),
    means as (
      select side, avg(rating) as mean from parts group by side
    ),
    deltas as (
      select p.profile_id,
             (case when p.matches_played < 10 then 40 else 24 end)::numeric
             * v_margin
             * ((case p.outcome when 'win' then 1.0 when 'draw' then 0.5 else 0.0 end)
                - 1 / (1 + power(10::numeric,
                    ((select mean from means where side <> p.side) - p.rating) / 400))) as delta
      from parts p
    )
    update public.match_participants mp
    set rating_delta = d.delta
    from deltas d
    where mp.match_id = p_match_id and mp.profile_id = d.profile_id;

  else -- ffa: pairwise, margin 1, K scaled by 1/(n-1), summed per participant
    with parts as (
      select mp.profile_id, mp.rank, rt.rating, rt.matches_played
      from public.match_participants mp
      join public.ratings rt
        on rt.profile_id = mp.profile_id and rt.sport_id = v_match.sport_id
      where mp.match_id = p_match_id
    ),
    pair_deltas as (
      select p1.profile_id,
             (case when p1.matches_played < 10 then 40 else 24 end)::numeric / (v_n - 1)
             * ((case when p1.rank < p2.rank then 1.0
                      when p1.rank = p2.rank then 0.5
                      else 0.0 end)
                - 1 / (1 + power(10::numeric, (p2.rating - p1.rating) / 400))) as delta
      from parts p1
      join parts p2 on p2.profile_id <> p1.profile_id
    )
    update public.match_participants mp
    set rating_delta = d.delta
    from (select profile_id, sum(delta) as delta
          from pair_deltas group by profile_id) d
    where mp.match_id = p_match_id and mp.profile_id = d.profile_id;
  end if;

  -- apply: one rating bump + one matches_played per participant per match
  update public.ratings rt
  set rating = rt.rating + mp.rating_delta,
      matches_played = rt.matches_played + 1,
      updated_at = now()
  from public.match_participants mp
  where mp.match_id = p_match_id
    and rt.profile_id = mp.profile_id
    and rt.sport_id = v_match.sport_id;

  update public.match_participants mp
  set rating_after = rt.rating
  from public.ratings rt
  where mp.match_id = p_match_id
    and rt.profile_id = mp.profile_id
    and rt.sport_id = v_match.sport_id;
end;
$$;

revoke execute on function public.apply_match_rating from public, anon, authenticated;

-- 3) log_match re-created: body from 0004 + M5 guards + rating call
create or replace function public.log_match(
  p_sport_id text,
  p_match_type text,
  p_format text,
  p_score_a integer,
  p_score_b integer,
  p_participants jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_match_id uuid;
  v_count integer;
  v_count_a integer;
  v_count_b integer;
  v_outcome text;
  p jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_format not in ('1v1', 'teams', 'ffa') then
    raise exception 'invalid format';
  end if;
  if p_match_type not in ('official', 'friendly') then
    raise exception 'invalid match type';
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

  -- M5 consent guard: every non-creator participant must be an accepted
  -- friend of the caller, or share an accepted spot in some tournament
  if exists (
    select 1 from jsonb_array_elements(p_participants) e
    where (e->>'profile_id')::uuid <> v_uid
      and not exists (
        select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester_id = v_uid and f.addressee_id = (e->>'profile_id')::uuid)
            or (f.addressee_id = v_uid and f.requester_id = (e->>'profile_id')::uuid))
      )
      and not exists (
        select 1
        from public.tournament_players tp1
        join public.tournament_players tp2
          on tp2.tournament_id = tp1.tournament_id
        where tp1.profile_id = v_uid and tp1.status = 'accepted'
          and tp2.profile_id = (e->>'profile_id')::uuid and tp2.status = 'accepted'
      )
  ) then
    raise exception 'participants must be your friends or tournament opponents';
  end if;

  -- M5 stats shape guard: object stats must be small and numbers-only
  if exists (
    select 1 from jsonb_array_elements(p_participants) e
    where jsonb_typeof(e->'stats') = 'object'
      and pg_column_size(e->'stats') > 2048
  ) then
    raise exception 'stats too large';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_participants) e,
         lateral jsonb_each(
           case when jsonb_typeof(e->'stats') = 'object'
                then e->'stats' else '{}'::jsonb end
         ) kv
    where jsonb_typeof(kv.value) <> 'number'
  ) then
    raise exception 'stats must be numeric values';
  end if;

  if p_format in ('1v1', 'teams') then
    if p_score_a is null or p_score_b is null then
      raise exception 'side scores required';
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
    if exists (select 1 from jsonb_array_elements(p_participants) e
               where (e->>'rank') is not null) then
      raise exception 'ranks are ffa-only';
    end if;
  else -- ffa
    if v_count < 2 then
      raise exception 'ffa needs at least 2 participants';
    end if;
    if p_score_a is not null or p_score_b is not null then
      raise exception 'side scores are not for ffa';
    end if;
    if exists (select 1 from jsonb_array_elements(p_participants) e
               where (e->>'rank') is null) then
      raise exception 'every ffa participant needs a rank';
    end if;
    if (select min((e->>'rank')::integer) from jsonb_array_elements(p_participants) e) <> 1 then
      raise exception 'ffa ranks must start at 1';
    end if;
  end if;

  insert into public.matches (sport_id, match_type, format, score_a, score_b, created_by)
  values (p_sport_id, p_match_type, p_format, p_score_a, p_score_b, v_uid)
  returning id into v_match_id;

  for p in select * from jsonb_array_elements(p_participants) loop
    if p_format = 'ffa' then
      v_outcome := case when (p->>'rank')::integer = 1 then 'win' else 'loss' end;
    elsif p_score_a = p_score_b then
      v_outcome := 'draw';
    elsif (p->>'side' = 'a') = (p_score_a > p_score_b) then
      v_outcome := 'win';
    else
      v_outcome := 'loss';
    end if;

    insert into public.match_participants (match_id, profile_id, side, rank, score, stats, outcome)
    values (
      v_match_id,
      (p->>'profile_id')::uuid,
      nullif(p->>'side', ''),
      (p->>'rank')::integer,
      case when p_format = 'ffa' then (p->>'score')::integer else null end,
      case when p ? 'stats' and jsonb_typeof(p->'stats') = 'object' then p->'stats' else null end,
      v_outcome
    );
  end loop;

  -- M5: ratings update (no-op for friendlies)
  perform public.apply_match_rating(v_match_id);

  return v_match_id;
end;
$$;

-- 4) finish_live_match re-created: body from 0006 + rating call
create or replace function public.finish_live_match(
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

  -- M5: ratings update (no-op for friendlies)
  perform public.apply_match_rating(v_match_id);

  return v_match_id;
end;
$$;

-- 5) Backfill: chronological replay of existing official history.
-- apply_match_rating's rating_delta guard makes re-runs harmless no-ops.
do $$
declare r record;
begin
  for r in select id from public.matches
           where match_type = 'official'
           order by created_at, id
  loop
    perform public.apply_match_rating(r.id);
  end loop;
end $$;
