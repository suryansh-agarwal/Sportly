-- Fix 1 (CRITICAL): advance_knockout decided "this was the final" via "no sibling fixture in
-- this round AND round >= max(round) over existing fixtures". Rounds are created lazily, so in
-- brackets with byes (e.g. 6 players -> 8 slots), a bye-propagated round-2 fixture can be recorded
-- before its sibling round-2 fixture exists, making max(round) = 2 prematurely and completing the
-- tournament with a semifinalist as champion. Total rounds is actually fixed by bracket size at
-- generation time: round-1 fixture count (byes included) = bracket_size / 2, so
-- total_rounds = log2(round1_count * 2).

create or replace function public.advance_knockout(p_fixture public.fixtures)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_next_round integer := p_fixture.round + 1;
  v_next_pos integer := (p_fixture.position + 1) / 2;   -- ceil(p/2) for ints
  v_slot_a boolean := (p_fixture.position % 2) = 1;
  v_round1_count integer;
  v_total_rounds integer;
begin
  select count(*) into v_round1_count
  from public.fixtures
  where tournament_id = p_fixture.tournament_id and round = 1;
  v_total_rounds := round(log(2, (v_round1_count * 2)::numeric))::integer;

  if p_fixture.round = v_total_rounds then
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

-- Fix (part of same finding): respond_to_invite read tournament status without a lock, racing
-- against start_tournament (which does `for update`). Take the same row lock here so an invite
-- response can't sneak in between start_tournament's read and its status flip.

create or replace function public.respond_to_invite(p_tournament_id uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select status into v_status from public.tournaments where id = p_tournament_id for update;
  if not found then raise exception 'tournament not found'; end if;
  if v_status <> 'draft' then raise exception 'tournament already started'; end if;
  update public.tournament_players
  set status = case when p_accept then 'accepted' else 'declined' end
  where tournament_id = p_tournament_id and profile_id = v_uid and status = 'invited';
  if not found then raise exception 'no pending invite'; end if;
end;
$$;

-- Fix 3rd part: record_fixture_result gains a freshness guard so a match logged before the
-- tournament existed (e.g. a stale/replayed match_id) cannot be linked to a fixture.

create or replace function public.record_fixture_result(p_fixture_id uuid, p_match_id uuid)
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
  if v_uid is distinct from v_f.player_a and v_uid is distinct from v_f.player_b then
    raise exception 'only the fixture players can record its result';
  end if;
  select * into v_t from public.tournaments where id = v_f.tournament_id for update;
  if v_t.status <> 'active' then raise exception 'tournament is not active'; end if;

  select * into v_m from public.matches where id = p_match_id;
  if not found then raise exception 'match not found'; end if;
  if v_m.sport_id <> v_t.sport_id then raise exception 'match sport does not fit the tournament'; end if;
  if v_m.created_at < v_t.created_at then raise exception 'match predates the tournament'; end if;
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
