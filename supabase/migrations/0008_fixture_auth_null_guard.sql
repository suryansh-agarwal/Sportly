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
