# Sportly M4: Tournament Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create tournaments (round robin / knockout), fill them via friend invites and a join link, generate fixtures server-side, resolve fixtures through real logged or live-scored matches, and crown a champion.

**Architecture:** Migration 0007: three tables (zero client writes) + seven SECURITY DEFINER RPCs owning the whole lifecycle, including circle-method RR generation, KO bracket generation with byes, advancement, and completion/winner logic. `lib/tournaments/` mirrors standings/bracket math for display (Vitest). New tournaments tab + tournament detail + join deep-link screens; log-match and the live screen gain an optional `fixture` param that routes results back through `record_fixture_result`.

**Tech Stack:** existing only — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-12-tournaments-design.md` (governs on conflict).

## Global Constraints

- Formats exactly `'round_robin'`/`'knockout'`; statuses exactly `'draft'`/`'active'`/`'completed'`/`'cancelled'`; player statuses `'invited'`/`'accepted'`/`'declined'`; fixture statuses `'pending'`/`'done'`.
- Fixtures are 1v1, official matches in the tournament's sport. RR: draws allowed (1pt each). KO: draws rejected.
- RR points 3/1/0; winner tiebreak ladder: points → head-to-head (two-way ties only) → total score diff → earliest join. The SQL and the TS mirror MUST implement the identical ordering.
- KO: bracket = next power of 2, random seeding, byes auto-resolved `done` at generation; winner of `(round r, position p)` feeds `(r+1, ceil(p/2))` as `player_a` when p is odd, `player_b` when p is even.
- All lifecycle via RPCs; SECURITY DEFINER with `search_path = public, pg_temp` (helpers `search_path = ''`); granted to `authenticated` only.
- One real match links to at most one fixture (partial unique index).
- Migrations file-only for implementers; controller applies + runs E2E. Verification per task: `npx tsc --noEmit` clean (new routes may need one dev-server start for typed routes), `npm test` green; screen tasks add a simulator boot check.
- Deferrals (do NOT build): doubles/team tournaments, groups/pickup, multi-stage formats, rating-based seeding, fixture scheduling/dates, push, https universal links, design polish.
- `.superpowers/` never committed. Branch: `m4-tournaments` (controller creates).

---

## File Structure

```
supabase/migrations/0007_tournaments.sql
lib/tournaments/standings.ts + standings.test.ts
lib/tournaments/bracket.ts + bracket.test.ts
lib/hooks/useTournaments.ts
lib/hooks/useMatches.ts          # useLogMatch returns the new match id
app/(app)/tournaments.tsx        # new 4th tab
app/(app)/tournament/[id].tsx    # detail (hidden)
app/(app)/join/[token].tsx       # deep-link join (hidden)
app/(app)/_layout.tsx            # tab + hidden routes
app/(app)/log-match.tsx          # fixture prefill mode
app/(app)/live/[id].tsx          # fixture param on finish
```

---

### Task 1: Migration 0007 — tournaments schema, RLS, seven RPCs

**Files:**
- Create: `supabase/migrations/0007_tournaments.sql`

**Interfaces:**
- Consumes: `profiles`, `sports`, `friendships`, `matches`, `match_participants` (0001–0006).
- Produces: tables `tournaments`, `tournament_players`, `fixtures`; RPCs `create_tournament(p_name,p_sport_id,p_format) returns uuid`, `invite_to_tournament(p_tournament_id,p_profile_id)`, `respond_to_invite(p_tournament_id,p_accept)`, `preview_tournament_by_token(p_token) returns jsonb`, `join_by_token(p_token) returns uuid`, `start_tournament(p_tournament_id)`, `record_fixture_result(p_fixture_id,p_match_id)`, `cancel_tournament(p_tournament_id)`.

- [ ] **Step 1: Write the migration** (file only — controller applies)

Create `supabase/migrations/0007_tournaments.sql`:

```sql
create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  sport_id text not null references public.sports(id),
  format text not null check (format in ('round_robin', 'knockout')),
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'cancelled')),
  created_by uuid not null references public.profiles(id),
  join_token text not null unique default replace(replace(encode(gen_random_bytes(9), 'base64'), '/', '_'), '+', '-'),
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
```

(Note: `advance_knockout` and `round_robin_winner` are internal — revoked from everyone, callable only from within the other definer functions.)

- [ ] **Step 2: Sanity checks**

Run: `grep -c "security definer" supabase/migrations/0007_tournaments.sql` → Expected: `11` (1 helper + 10 functions... count them: is_tournament_member, create, invite, respond, preview, join, advance, start, round_robin_winner, record, cancel = 11).
Run: `grep -c "for update" supabase/migrations/0007_tournaments.sql` → Expected: `6`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0007_tournaments.sql
git commit -m "feat: tournament schema with server-side fixture generation and lifecycle RPCs"
```

---

### Task 2: Pure logic — standings + bracket (TDD)

**Files:**
- Create: `lib/tournaments/standings.ts`, `lib/tournaments/standings.test.ts`, `lib/tournaments/bracket.ts`, `lib/tournaments/bracket.test.ts`

**Interfaces:**
- Consumes: nothing (pure; defines its own row inputs matching the hook's select shapes).
- Produces (Task 4 relies on):
  - `FixtureRow = { id: string; round: number; position: number; player_a: string | null; player_b: string | null; status: 'pending' | 'done'; match_id: string | null; winner_id: string | null; score_a: number | null; score_b: number | null }`
  - `computeStandings(fixtures: FixtureRow[], scoreDiffs: Record<string, number>, players: { profileId: string; joinedAt: string }[]): StandingsRow[]` where `StandingsRow = { profileId: string; played: number; wins: number; draws: number; losses: number; points: number; scoreDiff: number }` — sorted by the canonical ladder (points desc → two-way-tie head-to-head swap → scoreDiff desc → joinedAt asc → profileId asc).
  - `bracketRounds(fixtures: FixtureRow[]): FixtureRow[][]` — grouped by round ascending, each round ordered by position.

- [ ] **Step 1: `lib/tournaments/standings.test.ts` (failing first)**

```ts
import { describe, expect, it } from 'vitest';
import type { FixtureRow } from './standings';
import { computeStandings } from './standings';

const F = (
  id: string, a: string, b: string, winner: string | null, status: 'pending' | 'done' = 'done'
): FixtureRow => ({
  id, round: 1, position: 1, player_a: a, player_b: b, status,
  match_id: status === 'done' ? `m-${id}` : null, winner_id: winner,
  score_a: null, score_b: null,
});

const players = (...ids: string[]) =>
  ids.map((profileId, i) => ({ profileId, joinedAt: `2026-07-12T00:0${i}:00Z` }));

describe('computeStandings', () => {
  it('awards 3/1/0 and counts W/D/L', () => {
    const rows = computeStandings(
      [F('1', 'x', 'y', 'x'), F('2', 'x', 'z', null), F('3', 'y', 'z', 'z')],
      {},
      players('x', 'y', 'z')
    );
    const x = rows.find((r) => r.profileId === 'x')!;
    expect(x).toMatchObject({ played: 2, wins: 1, draws: 1, losses: 0, points: 4 });
    expect(rows[0].profileId).toBe('x');
  });

  it('ignores pending fixtures', () => {
    const rows = computeStandings([F('1', 'x', 'y', null, 'pending')], {}, players('x', 'y'));
    expect(rows.every((r) => r.played === 0)).toBe(true);
  });

  it('two-way points tie resolves by head-to-head', () => {
    // x and y both beat z, x lost to y head-to-head -> y first despite identical points
    const rows = computeStandings(
      [F('1', 'x', 'z', 'x'), F('2', 'y', 'z', 'y'), F('3', 'x', 'y', 'y'), F('4', 'z', 'x', 'x'), F('5', 'z', 'y', 'y')],
      {},
      players('x', 'y', 'z')
    );
    expect(rows[0].profileId).toBe('y');
    expect(rows[1].profileId).toBe('x');
  });

  it('falls back to score diff when not a two-way tie or no h2h result', () => {
    const rows = computeStandings(
      [F('1', 'x', 'y', null)],
      { x: 5, y: -5 },
      players('y', 'x') // y joined first
    );
    expect(rows[0].profileId).toBe('x'); // higher diff beats earlier join
  });

  it('earliest join breaks full ties', () => {
    const rows = computeStandings([F('1', 'x', 'y', null)], {}, players('y', 'x'));
    expect(rows[0].profileId).toBe('y');
  });
});
```

Run: `npm test -- tournaments/standings` → Expected: FAIL (module missing).

- [ ] **Step 2: Implement `lib/tournaments/standings.ts`, verify green**

```ts
export type FixtureRow = {
  id: string;
  round: number;
  position: number;
  player_a: string | null;
  player_b: string | null;
  status: 'pending' | 'done';
  match_id: string | null;
  winner_id: string | null;
  score_a: number | null;
  score_b: number | null;
};

export type StandingsRow = {
  profileId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  scoreDiff: number;
};

export function computeStandings(
  fixtures: FixtureRow[],
  scoreDiffs: Record<string, number>,
  players: { profileId: string; joinedAt: string }[]
): StandingsRow[] {
  const rows = new Map<string, StandingsRow>();
  for (const p of players) {
    rows.set(p.profileId, {
      profileId: p.profileId, played: 0, wins: 0, draws: 0, losses: 0,
      points: 0, scoreDiff: scoreDiffs[p.profileId] ?? 0,
    });
  }
  for (const f of fixtures) {
    if (f.status !== 'done' || !f.player_a || !f.player_b) continue;
    for (const pid of [f.player_a, f.player_b]) {
      const row = rows.get(pid);
      if (!row) continue;
      row.played += 1;
      if (f.winner_id === null) { row.draws += 1; row.points += 1; }
      else if (f.winner_id === pid) { row.wins += 1; row.points += 3; }
      else { row.losses += 1; }
    }
  }
  const joinOrder = new Map(players.map((p, i) => [p.profileId, i]));
  const sorted = [...rows.values()].sort((a, b) =>
    b.points - a.points ||
    b.scoreDiff - a.scoreDiff ||
    (joinOrder.get(a.profileId)! - joinOrder.get(b.profileId)!) ||
    a.profileId.localeCompare(b.profileId)
  );
  // two-way head-to-head swap at the top (mirrors round_robin_winner)
  if (sorted.length >= 2 && sorted[0].points === sorted[1].points) {
    const h2h = fixtures.find(
      (f) =>
        f.status === 'done' &&
        ((f.player_a === sorted[0].profileId && f.player_b === sorted[1].profileId) ||
          (f.player_a === sorted[1].profileId && f.player_b === sorted[0].profileId))
    );
    if (h2h?.winner_id === sorted[1].profileId) {
      [sorted[0], sorted[1]] = [sorted[1], sorted[0]];
    }
  }
  return sorted;
}
```

Note the players array must be passed in join order (the hook orders by `created_at`). Run: `npm test -- tournaments/standings` → Expected: 5 passing.

- [ ] **Step 3: `lib/tournaments/bracket.test.ts` (failing first)**

```ts
import { describe, expect, it } from 'vitest';
import type { FixtureRow } from './standings';
import { bracketRounds } from './bracket';

const F = (round: number, position: number): FixtureRow => ({
  id: `${round}-${position}`, round, position,
  player_a: null, player_b: null, status: 'pending', match_id: null, winner_id: null,
  score_a: null, score_b: null,
});

describe('bracketRounds', () => {
  it('groups by round ascending, positions ordered', () => {
    const rounds = bracketRounds([F(2, 1), F(1, 2), F(1, 1)]);
    expect(rounds.map((r) => r.map((f) => f.id))).toEqual([['1-1', '1-2'], ['2-1']]);
  });
  it('empty input gives empty rounds', () => {
    expect(bracketRounds([])).toEqual([]);
  });
});
```

Run: `npm test -- tournaments/bracket` → Expected: FAIL.

- [ ] **Step 4: Implement `lib/tournaments/bracket.ts`, verify green**

```ts
import type { FixtureRow } from './standings';

export function bracketRounds(fixtures: FixtureRow[]): FixtureRow[][] {
  const byRound = new Map<number, FixtureRow[]>();
  for (const f of fixtures) {
    const list = byRound.get(f.round) ?? [];
    list.push(f);
    byRound.set(f.round, list);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((a, b) => a.position - b.position));
}
```

Run: `npm test` → Expected: 54 passing (47 + 5 standings + 2 bracket).

- [ ] **Step 5: Commit**

```bash
git add lib/tournaments/
git commit -m "feat: tournament standings and bracket display logic"
```

---

### Task 3: Hooks — `lib/hooks/useTournaments.ts` + `useLogMatch` returns match id

**Files:**
- Create: `lib/hooks/useTournaments.ts`
- Modify: `lib/hooks/useMatches.ts` (useLogMatch's mutationFn returns the new match id)

**Interfaces:**
- Consumes: RPCs (Task 1), `FixtureRow` (Task 2), `supabase`, `useAuth`, `Profile`.
- Produces (Task 4 relies on):
  - `TournamentRow = { id: string; name: string; sport_id: string; format: 'round_robin' | 'knockout'; status: 'draft' | 'active' | 'completed' | 'cancelled'; created_by: string; join_token: string; winner_id: string | null; created_at: string }`
  - `TournamentPlayer = { profile_id: string; status: 'invited' | 'accepted' | 'declined'; created_at: string; profile: { username: string } }`
  - `TournamentDetail = TournamentRow & { players: TournamentPlayer[]; fixtures: TournamentFixture[] }` (`TournamentFixture = FixtureRow` — fixture scores are denormalized columns, no match embed)
  - `useTournaments()` → `{ mine: TournamentRow[]; invites: TournamentRow[] }`, key `['tournaments']`
  - `useTournament(id)` key `['tournament', id]` → `TournamentDetail`
  - Mutations: `useCreateTournament` (returns id), `useInvite`, `useRespondToInvite`, `usePreviewByToken(token)` (query, key `['tournament-preview', token]`), `useJoinByToken` (returns tournament id), `useStartTournament`, `useRecordFixtureResult` (`{ fixtureId, matchId }`), `useCancelTournament`.
  - `useLogMatch` (modified): mutationFn resolves to the new match id (`string`).

- [ ] **Step 1: In `lib/hooks/useMatches.ts`,** change `useLogMatch`'s mutationFn to return the RPC's uuid:

```ts
    mutationFn: async (input: LogMatchInput): Promise<string> => {
      const { data, error } = await supabase.rpc('log_match', {
        p_sport_id: input.sportId,
        p_match_type: input.matchType,
        p_format: input.format,
        p_score_a: input.scoreA,
        p_score_b: input.scoreB,
        p_participants: input.participants,
      });
      if (error) throw error;
      return data as string;
    },
```

(Only the signature line and the body's return change; onSuccess stays.)

- [ ] **Step 2: Create `lib/hooks/useTournaments.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import type { FixtureRow } from '../tournaments/standings';

export type TournamentRow = {
  id: string;
  name: string;
  sport_id: string;
  format: 'round_robin' | 'knockout';
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  created_by: string;
  join_token: string;
  winner_id: string | null;
  created_at: string;
};

export type TournamentPlayer = {
  profile_id: string;
  status: 'invited' | 'accepted' | 'declined';
  created_at: string;
  profile: { username: string };
};

export type TournamentFixture = FixtureRow;

export type TournamentDetail = TournamentRow & {
  players: TournamentPlayer[];
  fixtures: TournamentFixture[];
};

const PLAYERS_SELECT = 'profile_id, status, created_at, profile:profiles(username)';
const FIXTURES_SELECT =
  'id, round, position, player_a, player_b, status, match_id, winner_id, score_a, score_b';

export function useTournaments() {
  const { session } = useAuth();
  const myId = session!.user.id;
  return useQuery({
    queryKey: ['tournaments'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tournaments')
        .select('*, players:tournament_players(profile_id, status)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = data as unknown as (TournamentRow & { players: { profile_id: string; status: string }[] })[];
      const invites = rows.filter((t) =>
        t.players.some((p) => p.profile_id === myId && p.status === 'invited')
      );
      const mine = rows.filter((t) => !invites.includes(t));
      return { mine, invites };
    },
  });
}

export function useTournament(id: string) {
  return useQuery({
    queryKey: ['tournament', id],
    enabled: !!id,
    queryFn: async (): Promise<TournamentDetail> => {
      const [t, p, f] = await Promise.all([
        supabase.from('tournaments').select('*').eq('id', id).single(),
        supabase.from('tournament_players').select(PLAYERS_SELECT).eq('tournament_id', id).order('created_at'),
        supabase.from('fixtures').select(FIXTURES_SELECT).eq('tournament_id', id).order('round').order('position'),
      ]);
      if (t.error) throw t.error;
      if (p.error) throw p.error;
      if (f.error) throw f.error;
      return {
        ...(t.data as unknown as TournamentRow),
        players: p.data as unknown as TournamentPlayer[],
        fixtures: f.data as unknown as TournamentFixture[],
      };
    },
  });
}

function useTournamentMutation<TInput, TResult = void>(
  fn: (input: TInput) => Promise<TResult>,
  extraKeys: (input: TInput) => string[][] = () => []
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_res, input) => {
      qc.invalidateQueries({ queryKey: ['tournaments'] });
      for (const key of extraKeys(input)) qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function useCreateTournament() {
  return useTournamentMutation(
    async (input: { name: string; sportId: string; format: 'round_robin' | 'knockout' }) => {
      const { data, error } = await supabase.rpc('create_tournament', {
        p_name: input.name, p_sport_id: input.sportId, p_format: input.format,
      });
      if (error) throw error;
      return data as string;
    }
  );
}

export function useInvite() {
  return useTournamentMutation(
    async (input: { tournamentId: string; profileId: string }) => {
      const { error } = await supabase.rpc('invite_to_tournament', {
        p_tournament_id: input.tournamentId, p_profile_id: input.profileId,
      });
      if (error) throw error;
    },
    (input) => [['tournament', input.tournamentId]]
  );
}

export function useRespondToInvite() {
  return useTournamentMutation(
    async (input: { tournamentId: string; accept: boolean }) => {
      const { error } = await supabase.rpc('respond_to_invite', {
        p_tournament_id: input.tournamentId, p_accept: input.accept,
      });
      if (error) throw error;
    },
    (input) => [['tournament', input.tournamentId]]
  );
}

export function usePreviewByToken(token: string) {
  return useQuery({
    queryKey: ['tournament-preview', token],
    enabled: !!token,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('preview_tournament_by_token', { p_token: token });
      if (error) throw error;
      return data as {
        id: string; name: string; sport_id: string; format: string;
        status: string; creator: string; player_count: number;
      };
    },
  });
}

export function useJoinByToken() {
  return useTournamentMutation(async (token: string) => {
    const { data, error } = await supabase.rpc('join_by_token', { p_token: token });
    if (error) throw error;
    return data as string;
  });
}

export function useStartTournament() {
  return useTournamentMutation(
    async (tournamentId: string) => {
      const { error } = await supabase.rpc('start_tournament', { p_tournament_id: tournamentId });
      if (error) throw error;
    },
    (tournamentId) => [['tournament', tournamentId]]
  );
}

export function useRecordFixtureResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { fixtureId: string; matchId: string; tournamentId: string }) => {
      const { error } = await supabase.rpc('record_fixture_result', {
        p_fixture_id: input.fixtureId, p_match_id: input.matchId,
      });
      if (error) throw error;
    },
    onSuccess: (_res, input) => {
      qc.invalidateQueries({ queryKey: ['tournament', input.tournamentId] });
      qc.invalidateQueries({ queryKey: ['tournaments'] });
      qc.invalidateQueries({ queryKey: ['matches'] });
    },
  });
}

export function useCancelTournament() {
  return useTournamentMutation(
    async (tournamentId: string) => {
      const { error } = await supabase.rpc('cancel_tournament', { p_tournament_id: tournamentId });
      if (error) throw error;
    },
    (tournamentId) => [['tournament', tournamentId]]
  );
}
```

- [ ] **Step 3: Verify and commit**

`npx tsc --noEmit` clean; `npm test` 54 passing.

```bash
git add lib/hooks/useTournaments.ts lib/hooks/useMatches.ts
git commit -m "feat: tournament hooks and match-id-returning log mutation"
```

---

### Task 4: Screens — tournaments tab, detail, join link

**Files:**
- Create: `app/(app)/tournaments.tsx`, `app/(app)/tournament/[id].tsx`, `app/(app)/join/[token].tsx`
- Modify: `app/(app)/_layout.tsx`

**Interfaces:**
- Consumes: Tasks 2–3 exports; `getSport`, `SCORING_CONFIGS`, `useFriends`, `useStartLiveMatch`, `useAuth`.
- Produces: routes `/tournaments`, `/tournament/[id]`, `/join/[token]`. The detail screen navigates to log-match with params `{ fixtureId, tournamentId, sportId, opponentId }` and to live matches with `?fixture=<id>&tournament=<id>` — Task 5 consumes these exact param names.

- [ ] **Step 1: `app/(app)/_layout.tsx`** — add a visible tab and two hidden routes inside `<Tabs>`:

```tsx
      <Tabs.Screen name="tournaments" options={{ title: 'Tournaments' }} />
```
(placed after `log-match`), and after the `live/[id]` line:
```tsx
      <Tabs.Screen name="tournament/[id]" options={{ href: null }} />
      <Tabs.Screen name="join/[token]" options={{ href: null }} />
```

- [ ] **Step 2: Create `app/(app)/tournaments.tsx`**

```tsx
import { useState } from 'react';
import { Alert, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Link, router } from 'expo-router';
import { useSports } from '../../lib/hooks/useMatches';
import { useCreateTournament, useRespondToInvite, useTournaments } from '../../lib/hooks/useTournaments';

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      className={`rounded-full border px-3 py-2 ${selected ? 'border-emerald-600 bg-emerald-600' : 'border-gray-300'}`}
      onPress={onPress}
    >
      <Text className={selected ? 'text-white' : 'text-gray-700'}>{label}</Text>
    </Pressable>
  );
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-gray-500', active: 'text-emerald-600', completed: 'text-blue-600', cancelled: 'text-red-400',
};

export default function Tournaments() {
  const { data } = useTournaments();
  const { data: sports } = useSports();
  const create = useCreateTournament();
  const respond = useRespondToInvite();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [sportId, setSportId] = useState('');
  const [format, setFormat] = useState<'round_robin' | 'knockout'>('round_robin');

  function onCreate() {
    if (!name.trim() || !sportId) {
      Alert.alert('Hold on', 'Name and sport are required');
      return;
    }
    create.mutate(
      { name: name.trim(), sportId, format },
      {
        onSuccess: (id) => {
          setCreating(false); setName(''); setSportId('');
          router.push(`/tournament/${id}`);
        },
        onError: (e) => Alert.alert('Could not create', e.message),
      }
    );
  }

  return (
    <View className="flex-1 gap-4 bg-white p-6 pt-16">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl font-bold">Tournaments</Text>
        <Pressable className="rounded-lg bg-emerald-600 px-4 py-2" onPress={() => setCreating(!creating)}>
          <Text className="font-semibold text-white">{creating ? 'Close' : 'Create'}</Text>
        </Pressable>
      </View>

      {creating && (
        <View className="gap-3 rounded-xl border border-gray-200 p-4">
          <TextInput
            className="rounded-lg border border-gray-300 p-3"
            placeholder="Tournament name"
            value={name}
            onChangeText={setName}
          />
          <View className="flex-row flex-wrap gap-2">
            {(sports ?? []).map((s) => (
              <Chip key={s.id} label={s.name} selected={sportId === s.id} onPress={() => setSportId(s.id)} />
            ))}
          </View>
          <View className="flex-row gap-2">
            <Chip label="Round robin" selected={format === 'round_robin'} onPress={() => setFormat('round_robin')} />
            <Chip label="Knockout" selected={format === 'knockout'} onPress={() => setFormat('knockout')} />
          </View>
          <Pressable className="rounded-lg bg-emerald-600 p-3" disabled={create.isPending} onPress={onCreate}>
            <Text className="text-center font-semibold text-white">
              {create.isPending ? 'Creating…' : 'Create tournament'}
            </Text>
          </Pressable>
        </View>
      )}

      {(data?.invites ?? []).length > 0 && (
        <>
          <Text className="font-semibold">Invites</Text>
          {(data?.invites ?? []).map((t) => (
            <View key={t.id} className="flex-row items-center justify-between rounded-lg border border-amber-300 p-3">
              <View>
                <Text className="font-semibold">{t.name}</Text>
                <Text className="text-xs capitalize text-gray-400">
                  {t.sport_id.replace('_', ' ')} · {t.format.replace('_', ' ')}
                </Text>
              </View>
              <View className="flex-row gap-2">
                <Pressable
                  className="rounded bg-emerald-600 px-3 py-1"
                  onPress={() => respond.mutate({ tournamentId: t.id, accept: true })}
                >
                  <Text className="text-white">Join</Text>
                </Pressable>
                <Pressable
                  className="rounded border border-gray-300 px-3 py-1"
                  onPress={() => respond.mutate({ tournamentId: t.id, accept: false })}
                >
                  <Text className="text-gray-500">Decline</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </>
      )}

      <Text className="font-semibold">My tournaments</Text>
      <FlatList
        data={data?.mine ?? []}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => (
          <Link href={`/tournament/${item.id}`} asChild>
            <Pressable className="flex-row items-center justify-between rounded-lg border border-gray-200 p-3">
              <View>
                <Text className="font-semibold">{item.name}</Text>
                <Text className="text-xs capitalize text-gray-400">
                  {item.sport_id.replace('_', ' ')} · {item.format.replace('_', ' ')}
                </Text>
              </View>
              <Text className={`capitalize ${STATUS_COLORS[item.status]}`}>{item.status}</Text>
            </Pressable>
          </Link>
        )}
        ListEmptyComponent={<Text className="text-gray-400">No tournaments yet</Text>}
      />
    </View>
  );
}
```

- [ ] **Step 3: Create `app/(app)/tournament/[id].tsx`**

```tsx
import { Alert, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../lib/auth';
import { useFriends } from '../../../lib/hooks/useFriends';
import { useStartLiveMatch } from '../../../lib/hooks/useLive';
import {
  useCancelTournament, useInvite, useStartTournament, useTournament,
} from '../../../lib/hooks/useTournaments';
import { computeStandings } from '../../../lib/tournaments/standings';
import { bracketRounds } from '../../../lib/tournaments/bracket';
import { SCORING_CONFIGS } from '../../../lib/scoring/configs';
import { getSport } from '../../../lib/sports';

export default function TournamentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const myId = session!.user.id;
  const { data: t, isError } = useTournament(id ?? '');
  const { data: friendData } = useFriends();
  const invite = useInvite();
  const start = useStartTournament();
  const cancel = useCancelTournament();
  const startLive = useStartLiveMatch();

  if (isError) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Text className="text-gray-400">Couldn't load this tournament</Text>
      </View>
    );
  }
  if (!t) return <View className="flex-1 bg-white" />;

  const isCreator = t.created_by === myId;
  const accepted = t.players.filter((p) => p.status === 'accepted');
  const nameOf = (pid: string | null) =>
    pid ? t.players.find((p) => p.profile_id === pid)?.profile.username ?? '?' : 'TBD';
  const minPlayers = t.format === 'round_robin' ? 3 : 2;
  const invitableFriends = (friendData?.friends ?? []).filter(
    (f) => !t.players.some((p) => p.profile_id === f.id)
  );

  const scoreDiffs: Record<string, number> = {};
  for (const f of t.fixtures) {
    if (f.status !== 'done' || !f.player_a || !f.player_b) continue;
    if (f.score_a == null || f.score_b == null) continue;
    scoreDiffs[f.player_a] = (scoreDiffs[f.player_a] ?? 0) + f.score_a - f.score_b;
    scoreDiffs[f.player_b] = (scoreDiffs[f.player_b] ?? 0) + f.score_b - f.score_a;
  }
  const standings = computeStandings(
    t.fixtures, scoreDiffs,
    accepted.map((p) => ({ profileId: p.profile_id, joinedAt: p.created_at }))
  );
  const rounds = bracketRounds(t.fixtures);

  function onShare() {
    Share.share({ message: `Join my Sportly tournament "${t!.name}": sportly://join/${t!.join_token}` });
  }

  function onStart() {
    start.mutate(id!, { onError: (e) => Alert.alert('Could not start', e.message) });
  }

  function onCancel() {
    Alert.alert('Cancel tournament?', 'Fixtures die; recorded matches remain.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Cancel it', style: 'destructive',
        onPress: () => cancel.mutate(id!, { onError: (e) => Alert.alert('Failed', e.message) }) },
    ]);
  }

  function onLogFixture(fixtureId: string, opponentId: string) {
    router.push({
      pathname: '/log-match',
      params: { fixtureId, tournamentId: id!, sportId: t!.sport_id, opponentId },
    });
  }

  function onLiveFixture(fixtureId: string, opponentId: string) {
    startLive.mutate(
      {
        sportId: t!.sport_id, matchType: 'official', format: '1v1',
        participants: [
          { profile_id: myId, side: 'a' }, { profile_id: opponentId, side: 'b' },
        ],
      },
      {
        onSuccess: (liveId) =>
          router.push({ pathname: `/live/${liveId}`, params: { fixture: fixtureId, tournament: id! } }),
        onError: (e) => Alert.alert('Could not start live match', e.message),
      }
    );
  }

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16" contentContainerClassName="gap-4 pb-12">
      <Text className="text-2xl font-bold">{t.name}</Text>
      <Text className="capitalize text-gray-400">
        {getSport(t.sport_id)?.name ?? t.sport_id} · {t.format.replace('_', ' ')} · {t.status}
      </Text>

      {t.status === 'completed' && t.winner_id && (
        <View className="rounded-xl bg-emerald-50 p-4">
          <Text className="text-center text-lg font-bold text-emerald-700">
            🏆 {nameOf(t.winner_id)} wins!
          </Text>
        </View>
      )}

      <Text className="font-semibold">Players ({accepted.length})</Text>
      <View className="flex-row flex-wrap gap-2">
        {t.players.map((p) => (
          <Link key={p.profile_id} href={`/profile/${p.profile_id}`} asChild>
            <Pressable className={`rounded-full border px-3 py-1 ${p.status === 'accepted' ? 'border-emerald-300' : 'border-gray-200'}`}>
              <Text className={p.status === 'accepted' ? 'text-emerald-700' : 'text-gray-400'}>
                {p.profile.username}{p.status === 'invited' ? ' (invited)' : p.status === 'declined' ? ' (declined)' : ''}
              </Text>
            </Pressable>
          </Link>
        ))}
      </View>

      {t.status === 'draft' && (
        <>
          {isCreator && invitableFriends.length > 0 && (
            <>
              <Text className="font-semibold">Invite friends</Text>
              <View className="flex-row flex-wrap gap-2">
                {invitableFriends.map((f) => (
                  <Pressable
                    key={f.id}
                    className="rounded-full border border-gray-300 px-3 py-1"
                    onPress={() =>
                      invite.mutate(
                        { tournamentId: id!, profileId: f.id },
                        { onError: (e) => Alert.alert('Invite failed', e.message) }
                      )
                    }
                  >
                    <Text className="text-gray-700">+ {f.username}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
          <Pressable className="rounded-lg border border-emerald-600 p-3" onPress={onShare}>
            <Text className="text-center font-semibold text-emerald-700">Share join link</Text>
          </Pressable>
          {isCreator && (
            <Pressable
              className={`rounded-lg p-4 ${accepted.length >= minPlayers ? 'bg-emerald-600' : 'bg-gray-300'}`}
              disabled={accepted.length < minPlayers || start.isPending}
              onPress={onStart}
            >
              <Text className="text-center font-semibold text-white">
                {start.isPending ? 'Starting…' : `Start (${accepted.length}/${minPlayers} min)`}
              </Text>
            </Pressable>
          )}
        </>
      )}

      {t.status !== 'draft' && t.format === 'round_robin' && (
        <>
          <Text className="font-semibold">Standings</Text>
          <View className="rounded-xl border border-gray-200">
            <View className="flex-row border-b border-gray-200 p-2">
              <Text className="flex-1 font-semibold text-gray-500">Player</Text>
              {['P', 'W', 'D', 'L', 'Pts'].map((h) => (
                <Text key={h} className="w-10 text-center font-semibold text-gray-500">{h}</Text>
              ))}
            </View>
            {standings.map((row, i) => (
              <View key={row.profileId} className={`flex-row p-2 ${i === 0 && t.status === 'completed' ? 'bg-emerald-50' : ''}`}>
                <Text className="flex-1" numberOfLines={1}>{nameOf(row.profileId)}</Text>
                {[row.played, row.wins, row.draws, row.losses, row.points].map((v, j) => (
                  <Text key={j} className="w-10 text-center">{v}</Text>
                ))}
              </View>
            ))}
          </View>
        </>
      )}

      {t.status !== 'draft' && t.format === 'knockout' && (
        <>
          <Text className="font-semibold">Bracket</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-4">
              {rounds.map((round, ri) => (
                <View key={ri} className="justify-around gap-2">
                  <Text className="text-center text-xs text-gray-400">
                    {ri === rounds.length - 1 && rounds[ri].length === 1 ? 'Final' : `Round ${ri + 1}`}
                  </Text>
                  {round.map((f) => (
                    <View key={f.id} className="w-40 rounded-lg border border-gray-200 p-2">
                      {[f.player_a, f.player_b].map((pid, side) => (
                        <Text
                          key={side}
                          numberOfLines={1}
                          className={f.winner_id && pid === f.winner_id ? 'font-bold text-emerald-700' : pid ? '' : 'text-gray-300'}
                        >
                          {f.player_b === null && f.status === 'done' && side === 1 ? 'bye' : nameOf(pid)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        </>
      )}

      {t.status === 'active' && (
        <>
          <Text className="font-semibold">Fixtures</Text>
          {t.fixtures.filter((f) => f.status === 'pending' && f.player_a && f.player_b).map((f) => {
            const isMine = f.player_a === myId || f.player_b === myId;
            const opponent = f.player_a === myId ? f.player_b : f.player_a;
            return (
              <View
                key={f.id}
                className={`rounded-lg border p-3 ${isMine ? 'border-emerald-300' : 'border-gray-200'}`}
              >
                <Text>
                  {nameOf(f.player_a)} vs {nameOf(f.player_b)}
                  <Text className="text-gray-400">  · round {f.round}</Text>
                </Text>
                {isMine && opponent && (
                  <View className="mt-2 flex-row gap-2">
                    <Pressable
                      className="flex-1 rounded bg-emerald-600 p-2"
                      onPress={() => onLogFixture(f.id, opponent)}
                    >
                      <Text className="text-center text-white">Log result</Text>
                    </Pressable>
                    {SCORING_CONFIGS[t.sport_id] && (
                      <Pressable
                        className="flex-1 rounded border border-red-400 p-2"
                        disabled={startLive.isPending}
                        onPress={() => onLiveFixture(f.id, opponent)}
                      >
                        <Text className="text-center text-red-500">● Score live</Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            );
          })}
          {isCreator && (
            <Pressable className="rounded-lg border border-red-300 p-3" onPress={onCancel}>
              <Text className="text-center text-red-500">Cancel tournament</Text>
            </Pressable>
          )}
        </>
      )}

      {t.fixtures.some((f) => f.status === 'done' && f.match_id) && (
        <>
          <Text className="font-semibold">Played</Text>
          {t.fixtures.filter((f) => f.status === 'done' && f.match_id).map((f) => {
            const row = (
              <Pressable className="flex-row justify-between rounded-lg border border-gray-200 p-3">
                <Text numberOfLines={1}>
                  {nameOf(f.player_a)} vs {nameOf(f.player_b)}
                </Text>
                <Text className="text-gray-500">
                  {f.score_a != null && f.score_b != null ? `${f.score_a}–${f.score_b}` : ''}
                </Text>
              </Pressable>
            );
            // matches RLS is participant-only: only link into the match detail when I played in it
            const mine = f.player_a === myId || f.player_b === myId;
            return mine ? (
              <Link key={f.id} href={`/match/${f.match_id}`} asChild>{row}</Link>
            ) : (
              <View key={f.id}>{row}</View>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}
```

- [ ] **Step 4: Create `app/(app)/join/[token].tsx`**

```tsx
import { Alert, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useJoinByToken, usePreviewByToken } from '../../../lib/hooks/useTournaments';

export default function JoinByToken() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { data: preview, isError, isLoading } = usePreviewByToken(token ?? '');
  const join = useJoinByToken();

  if (isLoading) return <View className="flex-1 bg-white" />;
  if (isError || !preview) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Text className="text-gray-400">This invite link is not valid</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center gap-4 bg-white p-6">
      <Text className="text-2xl font-bold">{preview.name}</Text>
      <Text className="capitalize text-gray-400">
        {preview.sport_id.replace('_', ' ')} · {preview.format.replace('_', ' ')} · hosted by {preview.creator}
      </Text>
      <Text className="text-gray-500">{preview.player_count} players so far</Text>
      {preview.status === 'draft' ? (
        <Pressable
          className="w-full rounded-lg bg-emerald-600 p-4"
          disabled={join.isPending}
          onPress={() =>
            join.mutate(token!, {
              onSuccess: (tid) => router.replace(`/tournament/${tid}`),
              onError: (e) => Alert.alert('Could not join', e.message),
            })
          }
        >
          <Text className="text-center font-semibold text-white">
            {join.isPending ? 'Joining…' : 'Join tournament'}
          </Text>
        </Pressable>
      ) : (
        <Text className="text-gray-400">This tournament has already started</Text>
      )}
    </View>
  );
}
```

- [ ] **Step 5: Verify**

`npx tsc --noEmit` clean (dev-server start for typed routes if needed); `npm test` 54; simulator boot check with screenshot; kill server.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/tournaments.tsx" "app/(app)/tournament" "app/(app)/join" "app/(app)/_layout.tsx"
git commit -m "feat: tournaments tab, detail with standings/bracket, and join link screen"
```

---

### Task 5: Fixture prefill — log-match params + live finish hand-off

**Files:**
- Modify: `app/(app)/log-match.tsx`
- Modify: `app/(app)/live/[id].tsx`

**Interfaces:**
- Consumes: route params from Task 4 (`fixtureId`, `tournamentId`, `sportId`, `opponentId` on log-match; `fixture`, `tournament` on live); `useRecordFixtureResult` (Task 3); `useLogMatch` now returning the match id (Task 3).
- Produces: the finished milestone.

- [ ] **Step 1: log-match fixture mode.** In `app/(app)/log-match.tsx`:

Add imports:

```tsx
import { router, useLocalSearchParams } from 'expo-router';
import { useRecordFixtureResult } from '../../lib/hooks/useTournaments';
```

(replacing the existing `import { router } from 'expo-router';` line)

Inside the component, after `const startLive = useStartLiveMatch();` add:

```tsx
  const params = useLocalSearchParams<{
    fixtureId?: string; tournamentId?: string; sportId?: string; opponentId?: string;
  }>();
  const fixtureMode = !!params.fixtureId;
  const recordResult = useRecordFixtureResult();
```

After the state declarations, add a one-time fixture-mode initializer:

```tsx
  const [fixtureInit, setFixtureInit] = useState(false);
  if (fixtureMode && !fixtureInit && params.sportId && params.opponentId) {
    setFixtureInit(true);
    setSportId(params.sportId);
    setFormat('1v1');
    setSideA([myId]);
    setSideB([params.opponentId]);
    setMatchType('official');
    setStep(3); // straight to scores; sport/format/players are locked by the fixture
  }
```

In `onSubmit`'s `onSuccess` callback, replace the body with:

```tsx
        onSuccess: (matchId) => {
          const done = () => {
            setStep(0); setSportId(''); resetPlayers('1v1'); setStatInputs({}); setStatsFor(null); setFixtureInit(false);
            router.push(fixtureMode && params.tournamentId ? `/tournament/${params.tournamentId}` : '/');
          };
          if (fixtureMode && params.fixtureId && params.tournamentId) {
            recordResult.mutate(
              { fixtureId: params.fixtureId, matchId, tournamentId: params.tournamentId },
              {
                onSuccess: done,
                onError: (e) => Alert.alert('Match logged, but fixture link failed', e.message),
              }
            );
          } else {
            done();
          }
        },
```

In fixture mode, hide the Back button below step 3 and the Score-live button (the tournament screen owns that path): change the Back button's render condition from `{step > 0 && (` to `{step > (fixtureMode ? 3 : 0) && (` and the Score-live block's condition from `{SCORING_CONFIGS[sportId] && (` to `{!fixtureMode && SCORING_CONFIGS[sportId] && (`.

- [ ] **Step 2: live screen fixture hand-off.** In `app/(app)/live/[id].tsx`:

Add import:

```tsx
import { useRecordFixtureResult } from '../../../lib/hooks/useTournaments';
```

Change the params line to:

```tsx
  const { id, fixture, tournament } = useLocalSearchParams<{ id: string; fixture?: string; tournament?: string }>();
```

After `const abandon = useAbandonLiveMatch();` add:

```tsx
  const recordResult = useRecordFixtureResult();
```

Replace `onFinish` with:

```tsx
  function onFinish() {
    finish.mutate(
      { liveMatchId: id!, scoreA: state.setsWon.a, scoreB: state.setsWon.b },
      {
        onSuccess: (matchId) => {
          if (fixture && tournament) {
            recordResult.mutate(
              { fixtureId: fixture, matchId, tournamentId: tournament },
              {
                onSuccess: () => router.replace(`/tournament/${tournament}`),
                onError: (e) => {
                  Alert.alert('Match saved, but fixture link failed', e.message);
                  router.replace(`/match/${matchId}`);
                },
              }
            );
          } else {
            router.replace(`/match/${matchId}`);
          }
        },
        onError: (e) => Alert.alert('Could not finish', e.message),
      }
    );
  }
```

- [ ] **Step 3: Verify**

`npx tsc --noEmit` clean; `npm test` 54; simulator boot check; kill server.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/log-match.tsx" "app/(app)/live/[id].tsx"
git commit -m "feat: fixture prefill in log-match and live finish hand-off to tournaments"
```

---

### Task 6: Close out

- [ ] **Step 1:** Update CLAUDE.md §5: M4 built on `m4-tournaments` (summarize: tournaments with RR/KO, server-side generation in RPCs, join links via `sportly://join/<token>`, fixtures resolve through real matches incl. live scoring, standings/bracket display; migration 0007). Update the roadmap line (next: ratings spec, groups/pickup M5). Keep everything else.
- [ ] **Step 2:** `npx tsc --noEmit && npm test` → clean, 54.
- [ ] **Step 3:** `git add CLAUDE.md && git commit -m "docs: record milestone 4 completion"`

---

## Controller-only steps

After Task 1: apply migration 0007; spot-check `round_robin_winner` and `advance_knockout` grants (should NOT be executable by authenticated directly). After Task 5: full E2E — RR lifecycle (create → invite → accept → token-join → start → n(n-1)/2 fixtures → record via real matches → completion + winner incl. tiebreak sanity) and KO lifecycle (5-player bracket: 3 byes resolved at generation, advancement, draw rejection on a 1v1 football fixture, final → champion); negatives (non-creator start, non-player record, wrong-players match, double link, stranger read, join after start). Then Suryansh's walkthrough, final whole-branch review (most capable model), merge on sign-off.
