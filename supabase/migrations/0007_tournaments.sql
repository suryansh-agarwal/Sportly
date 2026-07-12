create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  sport_id text not null references public.sports(id),
  format text not null check (format in ('round_robin', 'knockout')),
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'cancelled')),
  created_by uuid not null references public.profiles(id),
  join_token text not null unique default substr(md5(random()::text || clock_timestamp()::text), 1, 16),
  winner_id uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.tournament_players (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  primary key (tournament_id, profile_id)
);

create table public.fixtures (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  round integer not null check (round >= 1),
  position integer not null check (position >= 1),
  player_a uuid references public.profiles(id),
  player_b uuid references public.profiles(id),
  status text not null default 'pending' check (status in ('pending', 'done')),
  match_id uuid references public.matches(id),
  winner_id uuid references public.profiles(id),
  score_a integer,   -- denormalized from the linked match so ALL tournament members can see results
  score_b integer,   -- (matches RLS is participant-only; fixtures RLS is member-wide)
  created_at timestamptz not null default now(),
  unique (tournament_id, round, position)
);

create unique index fixtures_match_link on public.fixtures (match_id) where match_id is not null;

alter table public.tournaments enable row level security;
alter table public.tournament_players enable row level security;
alter table public.fixtures enable row level security;

create function public.is_tournament_member(t uuid)
returns boolean
language sql security definer set search_path = ''
stable
as $$
  select exists (
    select 1 from public.tournament_players
    where tournament_id = t and profile_id = (select auth.uid())
  );
$$;

create policy "members can read tournaments"
  on public.tournaments for select to authenticated
  using (public.is_tournament_member(id));

create policy "members can read tournament players"
  on public.tournament_players for select to authenticated
  using (public.is_tournament_member(tournament_id));

create policy "members can read fixtures"
  on public.fixtures for select to authenticated
  using (public.is_tournament_member(tournament_id));

create function public.create_tournament(
  p_name text, p_sport_id text, p_format text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_format not in ('round_robin', 'knockout') then raise exception 'invalid format'; end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 60 then
    raise exception 'name must be 1-60 characters';
  end if;
  insert into public.tournaments (name, sport_id, format, created_by)
  values (trim(p_name), p_sport_id, p_format, v_uid)
  returning id into v_id;
  insert into public.tournament_players (tournament_id, profile_id, status)
  values (v_id, v_uid, 'accepted');
  return v_id;
end;
$$;

create function public.invite_to_tournament(p_tournament_id uuid, p_profile_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_t public.tournaments;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if not found then raise exception 'tournament not found'; end if;
  if v_t.created_by <> v_uid then raise exception 'only the creator can invite'; end if;
  if v_t.status <> 'draft' then raise exception 'tournament already started'; end if;
  if not exists (
    select 1 from public.friendships
    where status = 'accepted'
      and ((requester_id = v_uid and addressee_id = p_profile_id)
        or (addressee_id = v_uid and requester_id = p_profile_id))
  ) then
    raise exception 'can only invite friends';
  end if;
  insert into public.tournament_players (tournament_id, profile_id)
  values (p_tournament_id, p_profile_id)
  on conflict (tournament_id, profile_id) do nothing;
end;
$$;

create function public.respond_to_invite(p_tournament_id uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select status into v_status from public.tournaments where id = p_tournament_id;
  if not found then raise exception 'tournament not found'; end if;
  if v_status <> 'draft' then raise exception 'tournament already started'; end if;
  update public.tournament_players
  set status = case when p_accept then 'accepted' else 'declined' end
  where tournament_id = p_tournament_id and profile_id = v_uid and status = 'invited';
  if not found then raise exception 'no pending invite'; end if;
end;
$$;

create function public.preview_tournament_by_token(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
stable
as $$
declare
  v jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select jsonb_build_object(
    'id', t.id,
    'name', t.name,
    'sport_id', t.sport_id,
    'format', t.format,
    'status', t.status,
    'creator', p.username,
    'player_count', (select count(*) from public.tournament_players tp
                     where tp.tournament_id = t.id and tp.status = 'accepted')
  ) into v
  from public.tournaments t
  join public.profiles p on p.id = t.created_by
  where t.join_token = p_token;
  if v is null then raise exception 'invalid token'; end if;
  return v;
end;
$$;

create function public.join_by_token(p_token text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_t public.tournaments;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_t from public.tournaments where join_token = p_token for update;
  if not found then raise exception 'invalid token'; end if;
  if v_t.status <> 'draft' then raise exception 'tournament already started'; end if;
  insert into public.tournament_players (tournament_id, profile_id, status)
  values (v_t.id, v_uid, 'accepted')
  on conflict (tournament_id, profile_id) do update set status = 'accepted'
    where public.tournament_players.status = 'invited';
  return v_t.id;
end;
$$;

-- internal: advance a done knockout fixture's winner into the next round
create function public.advance_knockout(p_fixture public.fixtures)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_total_rounds integer;
  v_next_round integer := p_fixture.round + 1;
  v_next_pos integer := (p_fixture.position + 1) / 2;   -- ceil(p/2) for ints
  v_slot_a boolean := (p_fixture.position % 2) = 1;
begin
  select max(round) into v_total_rounds
  from public.fixtures where tournament_id = p_fixture.tournament_id;
  -- total rounds for the bracket is fixed at generation: round 1 .. log2(bracket).
  -- The final is the round whose fixture count is 1; if this fixture IS the final, complete the tournament.
  if not exists (
    select 1 from public.fixtures
    where tournament_id = p_fixture.tournament_id
      and round = p_fixture.round and position <> p_fixture.position
  ) and p_fixture.round >= v_total_rounds then
    update public.tournaments
    set status = 'completed', winner_id = p_fixture.winner_id
    where id = p_fixture.tournament_id;
    return;
  end if;

  insert into public.fixtures (tournament_id, round, position, player_a, player_b)
  values (
    p_fixture.tournament_id, v_next_round, v_next_pos,
    case when v_slot_a then p_fixture.winner_id else null end,
    case when v_slot_a then null else p_fixture.winner_id end
  )
  on conflict (tournament_id, round, position) do update
  set player_a = coalesce(public.fixtures.player_a, excluded.player_a),
      player_b = coalesce(public.fixtures.player_b, excluded.player_b);
end;
$$;

create function public.start_tournament(p_tournament_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_t public.tournaments;
  v_players uuid[];
  v_n integer;
  v_m integer;
  v_pos integer;
  v_a uuid;
  v_b uuid;
  v_bracket integer;
  v_byes integer;
  v_slots integer;
  r integer;
  k integer;
  j integer;
  v_fix public.fixtures;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if not found then raise exception 'tournament not found'; end if;
  if v_t.created_by <> v_uid then raise exception 'only the creator can start'; end if;
  if v_t.status <> 'draft' then raise exception 'tournament already started'; end if;

  select array_agg(profile_id order by created_at, profile_id) into v_players
  from public.tournament_players
  where tournament_id = p_tournament_id and status = 'accepted';
  v_n := coalesce(array_length(v_players, 1), 0);

  if v_t.format = 'round_robin' then
    if v_n < 3 then raise exception 'round robin needs at least 3 players'; end if;
    if v_n % 2 = 1 then
      v_players := v_players || null::uuid;
      v_n := v_n + 1;
    end if;
    v_m := v_n - 1;   -- rounds; others count
    for r in 1..v_m loop
      v_pos := 1;
      -- pair 1: fixed player vs rot(m)
      v_a := v_players[1];
      v_b := v_players[((v_m - 1 + (r - 1)) % v_m) + 2];
      if v_a is not null and v_b is not null then
        insert into public.fixtures (tournament_id, round, position, player_a, player_b)
        values (p_tournament_id, r, v_pos, v_a, v_b);
        v_pos := v_pos + 1;
      end if;
      -- pairs (rot(k), rot(m-k)) for k = 1 .. n/2 - 1
      for k in 1..(v_n / 2 - 1) loop
        v_a := v_players[((k - 1 + (r - 1)) % v_m) + 2];
        v_b := v_players[((v_m - k - 1 + (r - 1)) % v_m) + 2];
        if v_a is not null and v_b is not null then
          insert into public.fixtures (tournament_id, round, position, player_a, player_b)
          values (p_tournament_id, r, v_pos, v_a, v_b);
          v_pos := v_pos + 1;
        end if;
      end loop;
    end loop;
  else -- knockout
    if v_n < 2 then raise exception 'knockout needs at least 2 players'; end if;
    -- shuffle
    select array_agg(pid order by random()) into v_players
    from unnest(v_players) as pid;
    v_bracket := 1;
    while v_bracket < v_n loop v_bracket := v_bracket * 2; end loop;
    v_byes := v_bracket - v_n;
    v_slots := v_bracket / 2;
    -- bye slots first: single player, resolved immediately
    for j in 1..v_byes loop
      insert into public.fixtures (tournament_id, round, position, player_a, player_b, status, winner_id)
      values (p_tournament_id, 1, j, v_players[j], null, 'done', v_players[j]);
    end loop;
    -- real round-1 pairings
    for j in (v_byes + 1)..v_slots loop
      v_a := v_players[v_byes + 2 * (j - v_byes) - 1];
      v_b := v_players[v_byes + 2 * (j - v_byes)];
      insert into public.fixtures (tournament_id, round, position, player_a, player_b)
      values (p_tournament_id, 1, j, v_a, v_b);
    end loop;
    -- propagate byes into round 2 (only when the bracket has a round 2)
    if v_bracket > 2 then
      for v_fix in
        select * from public.fixtures
        where tournament_id = p_tournament_id and round = 1 and status = 'done'
      loop
        perform public.advance_knockout(v_fix);
      end loop;
    else
      -- 2-player bracket: the single fixture IS the final; nothing to propagate
      null;
    end if;
  end if;

  update public.tournaments set status = 'active' where id = p_tournament_id;
end;
$$;

-- round robin standings winner (mirrors lib/tournaments/standings.ts ordering)
create function public.round_robin_winner(p_tournament_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
stable
as $$
declare
  v_ids uuid[];
  v_pts integer[];
  v_first uuid;
  v_second uuid;
  v_h2h uuid;
begin
  -- one statement (CTEs are scoped to a single query in plpgsql): top two rows into arrays
  with results as (
    select f.player_a as pid,
           case when f.winner_id = f.player_a then 3 when f.winner_id is null then 1 else 0 end as pts,
           coalesce(f.score_a, 0) - coalesce(f.score_b, 0) as diff
    from public.fixtures f
    where f.tournament_id = p_tournament_id and f.status = 'done' and f.player_b is not null
    union all
    select f.player_b,
           case when f.winner_id = f.player_b then 3 when f.winner_id is null then 1 else 0 end,
           coalesce(f.score_b, 0) - coalesce(f.score_a, 0)
    from public.fixtures f
    where f.tournament_id = p_tournament_id and f.status = 'done' and f.player_b is not null
  ),
  table_rows as (
    select tp.profile_id,
           coalesce(sum(r.pts), 0) as points,
           coalesce(sum(r.diff), 0) as score_diff,
           tp.created_at
    from public.tournament_players tp
    left join results r on r.pid = tp.profile_id
    where tp.tournament_id = p_tournament_id and tp.status = 'accepted'
    group by tp.profile_id, tp.created_at
  ),
  ranked as (
    select profile_id, points,
           row_number() over (order by points desc, score_diff desc, created_at asc, profile_id asc) as rn
    from table_rows
  )
  select array_agg(profile_id order by rn), array_agg(points order by rn)
  into v_ids, v_pts
  from ranked where rn <= 2;

  v_first := v_ids[1];
  v_second := v_ids[2];

  if v_second is not null and v_pts[1] = v_pts[2] then
    select winner_id into v_h2h from public.fixtures
    where tournament_id = p_tournament_id and status = 'done'
      and ((player_a = v_first and player_b = v_second)
        or (player_a = v_second and player_b = v_first));
    if v_h2h = v_second then return v_second; end if;
  end if;
  return v_first;
end;
$$;

create function public.record_fixture_result(p_fixture_id uuid, p_match_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_f public.fixtures;
  v_t public.tournaments;
  v_m public.matches;
  v_outcome_a text;
  v_winner uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_f from public.fixtures where id = p_fixture_id for update;
  if not found then raise exception 'fixture not found'; end if;
  if v_f.status <> 'pending' then raise exception 'fixture already resolved'; end if;
  if v_uid not in (v_f.player_a, v_f.player_b) then
    raise exception 'only the fixture players can record its result';
  end if;
  select * into v_t from public.tournaments where id = v_f.tournament_id for update;
  if v_t.status <> 'active' then raise exception 'tournament is not active'; end if;

  select * into v_m from public.matches where id = p_match_id;
  if not found then raise exception 'match not found'; end if;
  if v_m.sport_id <> v_t.sport_id then raise exception 'match sport does not fit the tournament'; end if;
  if v_m.format <> '1v1' then raise exception 'fixture matches must be 1v1'; end if;
  if v_m.match_type <> 'official' then raise exception 'fixture matches must be official'; end if;
  if (select count(*) from public.match_participants mp
      where mp.match_id = p_match_id
        and mp.profile_id in (v_f.player_a, v_f.player_b)) <> 2 then
    raise exception 'match players do not fit the fixture';
  end if;

  select mp.outcome into v_outcome_a from public.match_participants mp
  where mp.match_id = p_match_id and mp.profile_id = v_f.player_a;

  if v_outcome_a = 'win' then v_winner := v_f.player_a;
  elsif v_outcome_a = 'loss' then v_winner := v_f.player_b;
  else v_winner := null; -- draw
  end if;

  if v_t.format = 'knockout' and v_winner is null then
    raise exception 'knockout fixtures cannot end in a draw — log a decisive match';
  end if;

  update public.fixtures
  set status = 'done', match_id = p_match_id, winner_id = v_winner,
      -- fixture scores viewed from each fixture player's own match side (denormalized for member-wide display)
      score_a = (select case when mp.side = 'a' then v_m.score_a else v_m.score_b end
                 from public.match_participants mp
                 where mp.match_id = p_match_id and mp.profile_id = v_f.player_a),
      score_b = (select case when mp.side = 'a' then v_m.score_a else v_m.score_b end
                 from public.match_participants mp
                 where mp.match_id = p_match_id and mp.profile_id = v_f.player_b)
  where id = p_fixture_id;
  select * into v_f from public.fixtures where id = p_fixture_id;

  if v_t.format = 'knockout' then
    perform public.advance_knockout(v_f);
  else
    if not exists (
      select 1 from public.fixtures
      where tournament_id = v_t.id and status = 'pending'
    ) then
      update public.tournaments
      set status = 'completed', winner_id = public.round_robin_winner(v_t.id)
      where id = v_t.id;
    end if;
  end if;
end;
$$;

create function public.cancel_tournament(p_tournament_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_t public.tournaments;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if not found then raise exception 'tournament not found'; end if;
  if v_t.created_by <> v_uid then raise exception 'only the creator can cancel'; end if;
  if v_t.status not in ('draft', 'active') then raise exception 'tournament already finished'; end if;
  update public.tournaments set status = 'cancelled' where id = p_tournament_id;
end;
$$;

revoke execute on function public.create_tournament, public.invite_to_tournament,
  public.respond_to_invite, public.preview_tournament_by_token, public.join_by_token,
  public.start_tournament, public.record_fixture_result, public.cancel_tournament,
  public.advance_knockout, public.round_robin_winner
from public, anon;
grant execute on function public.create_tournament, public.invite_to_tournament,
  public.respond_to_invite, public.preview_tournament_by_token, public.join_by_token,
  public.start_tournament, public.record_fixture_result, public.cancel_tournament
to authenticated;
