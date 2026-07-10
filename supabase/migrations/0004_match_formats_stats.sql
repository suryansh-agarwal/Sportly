-- 1) New columns
alter table public.matches
  add column format text not null default '1v1' check (format in ('1v1', 'teams', 'ffa')),
  add column score_a integer check (score_a >= 0),
  add column score_b integer check (score_b >= 0);

alter table public.match_participants
  add column side text check (side in ('a', 'b')),
  add column rank integer check (rank >= 1),
  add column stats jsonb check (stats is null or jsonb_typeof(stats) = 'object');

alter table public.match_participants alter column score drop not null;
alter table public.match_participants alter column score drop default;

-- 2) Backfill existing 1v1 rows: creator is side 'a'
update public.match_participants mp
set side = case when mp.profile_id = m.created_by then 'a' else 'b' end
from public.matches m
where mp.match_id = m.id;

update public.matches m
set score_a = (select score from public.match_participants
               where match_id = m.id and side = 'a'),
    score_b = (select score from public.match_participants
               where match_id = m.id and side = 'b');

-- 3) The single write path for matches
create function public.log_match(
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

  return v_match_id;
end;
$$;

revoke execute on function public.log_match from public, anon;
grant execute on function public.log_match to authenticated;

-- 4) RPC replaces direct client writes
drop policy "creator can insert a match" on public.matches;
drop policy "match creator can insert participants" on public.match_participants;
