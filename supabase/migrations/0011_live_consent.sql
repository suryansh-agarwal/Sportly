-- M5 final-review Critical fix: the live-scoring path bypassed the M5 consent
-- guard. log_match (0010) requires every non-creator participant to be an
-- accepted friend or share an accepted tournament spot with the caller, but
-- start_live_match (0006) still accepted arbitrary profile_ids, and
-- finish_live_match (0010) now calls apply_match_rating — so an attacker
-- could start an official live match against a stranger and finish it,
-- moving the stranger's rating without consent. This re-creates
-- start_live_match with the same guard, copied verbatim from log_match.

create or replace function public.start_live_match(
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
