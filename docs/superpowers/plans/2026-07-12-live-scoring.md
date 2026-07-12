# Sportly M3: Live Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point-by-point live scoring for the five racquet sports, scored by any participant from any device, spectated live by friends, and logged into the official record at finish.

**Architecture:** Append-only `live_events` in Postgres (server-ordered → multi-scorer safe) + a pure TS reducer (`lib/scoring/`) folding events into score state. Supabase Realtime (postgres_changes, RLS-gated) streams events to all viewers. Lifecycle (start/finish/abandon) goes through SECURITY DEFINER RPCs; finish inserts the real match with server-derived outcomes and links it.

**Tech Stack:** existing only — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-live-scoring-design.md` (governs on conflict).

## Global Constraints

- Racquet sports exactly: `tennis`, `padel`, `badminton`, `pickleball`, `table_tennis`. Formats `'1v1'`/`'teams'` only (no ffa). Statuses exactly `'live'`, `'completed'`, `'abandoned'`.
- Rules: tennis/padel — 0/15/30/40 with deuce/advantage, 6-game sets win-by-2, tiebreak at 6–6 (first to 7 win-by-2, set 7–6), best of 3 sets. Badminton — rally to 21 win-by-2, hard cap 30, best of 3. Table tennis — rally to 11 win-by-2, best of 5. Pickleball — rally to 11 win-by-2, best of 3.
- Engine is pure TS in `lib/scoring/` (no RN/Supabase imports), deterministic fold; undo cancels the most recent uncancelled point; points after completion are ignored.
- Scorers = participants only (RLS-enforced insert on `live_events`, only while status `'live'`). Readers = participants + accepted friends of participants. Lifecycle only via RPCs (no client insert/update on `live_matches`/`live_participants`).
- SECURITY DEFINER functions set `search_path`; RPCs granted to `authenticated` only, revoked from `public, anon`.
- `finish_live_match` maps `setsWon` → `score_a`/`score_b`, derives outcomes server-side (same rules as `log_match`), participant `score`/`stats` null.
- Migrations are file-only for implementers; the controller applies them and runs the live E2E. Implementers never run supabase CLI/MCP.
- Verification per task: `npx tsc --noEmit` clean (route additions may require one dev-server start to regenerate `.expo/types/router.d.ts`), `npm test` green. Screen tasks add a simulator boot check (screenshot; a persisted-session Profile-tab landing is fine).
- Deferrals (do NOT build): cricket/football/basketball engines, serve tracking, side-out pickleball, post-match stat appending, spectator chat/reactions, push, tournament integration, design polish.
- `.superpowers/` is git-ignored scratch — never commit it. Branch: `m3-live-scoring` (controller creates from `main`).

---

## File Structure

```
supabase/migrations/0006_live_scoring.sql
lib/scoring/types.ts      # Side, ScoreEvent, RacquetConfig, ScoreState
lib/scoring/engine.ts     # foldEvents
lib/scoring/engine.test.ts
lib/scoring/configs.ts    # SCORING_CONFIGS (5 sports) + test
lib/scoring/configs.test.ts
lib/hooks/useLive.ts      # queries, realtime subscription, mutations
app/(app)/live/[id].tsx   # live scoreboard (scorer + spectator)
app/(app)/_layout.tsx     # hide live/[id]
app/(app)/index.tsx       # "In progress" strip
app/(app)/log-match.tsx   # "Score live" branch on players step
```

---

### Task 1: Migration 0006 — live scoring schema, RLS, RPCs, Realtime

**Files:**
- Create: `supabase/migrations/0006_live_scoring.sql`

**Interfaces:**
- Consumes: `matches`, `match_participants`, `profiles`, `sports`, `friendships` (0001–0005).
- Produces: tables `live_matches`, `live_participants`, `live_events`; RPCs `start_live_match(p_sport_id text, p_match_type text, p_format text, p_participants jsonb) returns uuid`, `finish_live_match(p_live_match_id uuid, p_score_a integer, p_score_b integer) returns uuid`, `abandon_live_match(p_live_match_id uuid) returns void`. Participant objects for start: `{ profile_id, side }`.

- [ ] **Step 1: Write the migration** (file only — controller applies)

Create `supabase/migrations/0006_live_scoring.sql`:

```sql
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
```

- [ ] **Step 2: Sanity check**

Run: `grep -c "security definer" supabase/migrations/0006_live_scoring.sql` → Expected: `5` (2 helpers + 3 RPCs).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0006_live_scoring.sql
git commit -m "feat: live scoring schema with event log, RLS, and lifecycle RPCs"
```

---

### Task 2: Scoring engine (TDD — the heaviest logic in the repo)

**Files:**
- Create: `lib/scoring/types.ts`, `lib/scoring/engine.ts`, `lib/scoring/engine.test.ts`, `lib/scoring/configs.ts`, `lib/scoring/configs.test.ts`

**Interfaces:**
- Consumes: nothing (pure TS; `Side` is defined here independently of lib/types to keep scoring dependency-free — it is the same `'a' | 'b'` union).
- Produces (Tasks 3–4 rely on): `foldEvents(config: RacquetConfig, events: ScoreEvent[]): ScoreState` from `lib/scoring/engine.ts`; `SCORING_CONFIGS: Record<string, RacquetConfig>` from `lib/scoring/configs.ts`; types `Side`, `ScoreEvent`, `RacquetConfig`, `ScoreState` from `lib/scoring/types.ts`.

- [ ] **Step 1: `lib/scoring/types.ts`**

```ts
export type Side = 'a' | 'b';

export type ScoreEvent = {
  id: number;               // authoritative order (live_events.id)
  type: 'point' | 'undo';
  side: Side | null;        // null for undo
};

export type RacquetConfig =
  | { variant: 'tennis'; sets: number }                                    // best-of-N sets
  | { variant: 'rally'; pointsPerGame: number; cap: number | null; games: number }; // best-of-N games

export type SideScores = { a: number; b: number };

export type ScoreState = {
  points: { a: string; b: string };   // display: "40", "Ad", tiebreak/rally raw numbers
  units: SideScores[];                // tennis: games per set (current set last); rally: points per game (current game last)
  setsWon: SideScores;                // tennis: sets; rally: games — maps to score_a/score_b at finish
  inTiebreak: boolean;
  isComplete: boolean;
  winner: Side | null;
};
```

- [ ] **Step 2: Write `lib/scoring/engine.test.ts` (failing first)**

```ts
import { describe, expect, it } from 'vitest';
import { foldEvents } from './engine';
import type { RacquetConfig, ScoreEvent, Side } from './types';

const TENNIS: RacquetConfig = { variant: 'tennis', sets: 3 };
const TT: RacquetConfig = { variant: 'rally', pointsPerGame: 11, cap: null, games: 5 };
const BADMINTON: RacquetConfig = { variant: 'rally', pointsPerGame: 21, cap: 30, games: 3 };

let nextId = 1;
const pts = (...sides: Side[]): ScoreEvent[] => sides.map((s) => ({ id: nextId++, type: 'point', side: s }));
const undo = (): ScoreEvent[] => [{ id: nextId++, type: 'undo', side: null }];
const seq = (...groups: ScoreEvent[][]) => groups.flat();
// N points in a row for one side
const run = (side: Side, n: number) => pts(...Array<Side>(n).fill(side));
// win one tennis game for `side` from fresh game (4 straight points)
const game = (side: Side) => run(side, 4);
// win one tennis set 6-0
const set = (side: Side) => seq(...Array.from({ length: 6 }, () => [game(side)]).map((g) => g));

describe('tennis points display', () => {
  it('counts 0/15/30/40', () => {
    expect(foldEvents(TENNIS, pts('a')).points).toEqual({ a: '15', b: '0' });
    expect(foldEvents(TENNIS, pts('a', 'a', 'b')).points).toEqual({ a: '30', b: '15' });
    expect(foldEvents(TENNIS, pts('a', 'a', 'a')).points).toEqual({ a: '40', b: '0' });
  });
  it('deuce shows 40-40, advantage shows Ad', () => {
    const deuce = pts('a', 'a', 'a', 'b', 'b', 'b');
    expect(foldEvents(TENNIS, deuce).points).toEqual({ a: '40', b: '40' });
    expect(foldEvents(TENNIS, seq(deuce, pts('b'))).points).toEqual({ a: '40', b: 'Ad' });
  });
  it('advantage lost returns to deuce', () => {
    const advB = seq(pts('a', 'a', 'a', 'b', 'b', 'b'), pts('b'));
    expect(foldEvents(TENNIS, seq(advB, pts('a'))).points).toEqual({ a: '40', b: '40' });
  });
});

describe('tennis games and sets', () => {
  it('4 straight points win a game', () => {
    const s = foldEvents(TENNIS, game('a'));
    expect(s.units).toEqual([{ a: 1, b: 0 }]);
    expect(s.points).toEqual({ a: '0', b: '0' });
  });
  it('game must be won by 2 (deuce cycle)', () => {
    const s = foldEvents(TENNIS, seq(pts('a', 'a', 'a', 'b', 'b', 'b'), pts('a'), pts('a')));
    expect(s.units).toEqual([{ a: 1, b: 0 }]);
  });
  it('set won 6-0; new set starts', () => {
    const s = foldEvents(TENNIS, set('a'));
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
    expect(s.units).toEqual([{ a: 6, b: 0 }, { a: 0, b: 0 }]);
  });
  it('set requires win by 2 games: 6-5 does not end the set', () => {
    const events = seq(
      ...Array.from({ length: 5 }, () => [game('a')]).map((g) => g),
      ...Array.from({ length: 5 }, () => [game('b')]).map((g) => g),
      [game('a')]
    );
    const s = foldEvents(TENNIS, events);
    expect(s.setsWon).toEqual({ a: 0, b: 0 });
    expect(s.units).toEqual([{ a: 6, b: 5 }]);
    expect(s.inTiebreak).toBe(false);
  });
});

describe('tennis tiebreak', () => {
  const sixAll = seq(
    ...Array.from({ length: 5 }, () => [game('a')]).map((g) => g),
    ...Array.from({ length: 5 }, () => [game('b')]).map((g) => g),
    [game('a')],
    [game('b')]
  );
  it('enters tiebreak at 6-6 and displays raw points', () => {
    const s = foldEvents(TENNIS, sixAll);
    expect(s.inTiebreak).toBe(true);
    expect(foldEvents(TENNIS, seq(sixAll, pts('a'))).points).toEqual({ a: '1', b: '0' });
  });
  it('tiebreak to 7 win-by-2 gives the set 7-6', () => {
    const s = foldEvents(TENNIS, seq(sixAll, run('a', 7)));
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
    expect(s.units[0]).toEqual({ a: 7, b: 6 });
    expect(s.inTiebreak).toBe(false);
  });
  it('tiebreak 7-6 continues until 2 clear', () => {
    const s = foldEvents(TENNIS, seq(sixAll, run('a', 6), run('b', 6), pts('a')));
    expect(s.setsWon).toEqual({ a: 0, b: 0 });
    expect(s.inTiebreak).toBe(true);
  });
});

describe('tennis match completion', () => {
  it('two sets win the match; further points ignored', () => {
    const s = foldEvents(TENNIS, seq(set('a'), set('a')));
    expect(s.isComplete).toBe(true);
    expect(s.winner).toBe('a');
    expect(s.setsWon).toEqual({ a: 2, b: 0 });
    const after = foldEvents(TENNIS, seq(set('a'), set('a'), pts('b')));
    expect(after.setsWon).toEqual({ a: 2, b: 0 });
    expect(after.isComplete).toBe(true);
  });
});

describe('rally scoring', () => {
  it('11 straight points win a table tennis game', () => {
    const s = foldEvents(TT, run('a', 11));
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
    expect(s.units).toEqual([{ a: 11, b: 0 }, { a: 0, b: 0 }]);
  });
  it('10-10 requires win by 2', () => {
    const s = foldEvents(TT, seq(run('a', 10), run('b', 10), pts('a')));
    expect(s.setsWon).toEqual({ a: 0, b: 0 });
    expect(s.points).toEqual({ a: '11', b: '10' });
  });
  it('badminton caps at 30: 30-29 wins the game', () => {
    const s = foldEvents(BADMINTON, seq(run('a', 20), run('b', 20), run('a', 9), run('b', 9), pts('a')));
    expect(s.points).toEqual({ a: '30', b: '29' });
    // 29-29 -> a scores -> 30-29 -> game over via cap
    const capped = foldEvents(BADMINTON, seq(run('a', 20), run('b', 20), run('a', 9), run('b', 9), pts('a')));
    expect(capped.setsWon).toEqual({ a: 1, b: 0 });
  });
  it('best of 5: three games complete a table tennis match', () => {
    const s = foldEvents(TT, seq(run('a', 11), run('a', 11), run('a', 11)));
    expect(s.isComplete).toBe(true);
    expect(s.winner).toBe('a');
    expect(s.setsWon).toEqual({ a: 3, b: 0 });
  });
});

describe('undo', () => {
  it('undo cancels the last point', () => {
    const s = foldEvents(TENNIS, seq(pts('a', 'a'), undo()));
    expect(s.points).toEqual({ a: '15', b: '0' });
  });
  it('undo across a game boundary restores the game', () => {
    const s = foldEvents(TENNIS, seq(game('a'), undo()));
    expect(s.units).toEqual([{ a: 0, b: 0 }]);
    expect(s.points).toEqual({ a: '40', b: '0' });
  });
  it('undo across match completion reopens the match', () => {
    const s = foldEvents(TENNIS, seq(set('a'), set('a'), undo()));
    expect(s.isComplete).toBe(false);
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
  });
  it('undo with nothing to cancel is a no-op', () => {
    const s = foldEvents(TENNIS, undo());
    expect(s.points).toEqual({ a: '0', b: '0' });
    expect(s.isComplete).toBe(false);
  });
});

describe('determinism', () => {
  it('fold is order-insensitive to input array order (sorts by id)', () => {
    const events = seq(run('a', 11));
    const shuffled = [...events].reverse();
    expect(foldEvents(TT, shuffled)).toEqual(foldEvents(TT, events));
  });
});
```

Run: `npm test -- scoring/engine` → Expected: FAIL (module missing).

- [ ] **Step 3: Implement `lib/scoring/engine.ts`, verify green**

```ts
import type { RacquetConfig, ScoreEvent, ScoreState, Side, SideScores } from './types';

type Internal = {
  points: SideScores;
  units: SideScores[];
  setsWon: SideScores;
  inTiebreak: boolean;
  complete: boolean;
  winner: Side | null;
};

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

function initial(): Internal {
  return {
    points: { a: 0, b: 0 },
    units: [{ a: 0, b: 0 }],
    setsWon: { a: 0, b: 0 },
    inTiebreak: false,
    complete: false,
    winner: null,
  };
}

function applyPoint(config: RacquetConfig, s: Internal, side: Side): Internal {
  if (s.complete) return s;
  const n: Internal = {
    points: { ...s.points },
    units: s.units.map((u) => ({ ...u })),
    setsWon: { ...s.setsWon },
    inTiebreak: s.inTiebreak,
    complete: false,
    winner: null,
  };
  n.points[side] += 1;
  const p = n.points[side];
  const o = n.points[other(side)];

  if (config.variant === 'rally') {
    n.units[n.units.length - 1] = { ...n.points };
    const won =
      (p >= config.pointsPerGame && p - o >= 2) ||
      (config.cap != null && p >= config.cap);
    if (won) {
      n.setsWon[side] += 1;
      if (n.setsWon[side] > config.games / 2) {
        n.complete = true;
        n.winner = side;
      } else {
        n.points = { a: 0, b: 0 };
        n.units.push({ a: 0, b: 0 });
      }
    }
    return n;
  }

  // tennis variant
  const gameWon = n.inTiebreak ? p >= 7 && p - o >= 2 : p >= 4 && p - o >= 2;
  if (!gameWon) return n;

  const cur = n.units[n.units.length - 1];
  cur[side] += 1;
  n.points = { a: 0, b: 0 };
  const g = cur[side];
  const og = cur[other(side)];
  const setWon = n.inTiebreak || (g >= 6 && g - og >= 2);
  if (!setWon) {
    if (g === 6 && og === 6) n.inTiebreak = true;
    return n;
  }
  n.inTiebreak = false;
  n.setsWon[side] += 1;
  if (n.setsWon[side] > config.sets / 2) {
    n.complete = true;
    n.winner = side;
  } else {
    n.units.push({ a: 0, b: 0 });
  }
  return n;
}

const TENNIS_DISPLAY = ['0', '15', '30', '40'];

function display(config: RacquetConfig, s: Internal): { a: string; b: string } {
  if (config.variant === 'rally' || s.inTiebreak) {
    return { a: String(s.points.a), b: String(s.points.b) };
  }
  const { a, b } = s.points;
  if (a >= 3 && b >= 3) {
    if (a === b) return { a: '40', b: '40' };
    return a > b ? { a: 'Ad', b: '40' } : { a: '40', b: 'Ad' };
  }
  return { a: TENNIS_DISPLAY[Math.min(a, 3)], b: TENNIS_DISPLAY[Math.min(b, 3)] };
}

export function foldEvents(config: RacquetConfig, events: ScoreEvent[]): ScoreState {
  const stack: Side[] = [];
  for (const e of [...events].sort((x, y) => x.id - y.id)) {
    if (e.type === 'point' && e.side) stack.push(e.side);
    else if (e.type === 'undo') stack.pop();
  }
  let s = initial();
  for (const side of stack) s = applyPoint(config, s, side);
  return {
    points: display(config, s),
    units: s.units,
    setsWon: s.setsWon,
    inTiebreak: s.inTiebreak,
    isComplete: s.complete,
    winner: s.winner,
  };
}
```

Run: `npm test -- scoring/engine` → Expected: all engine tests pass (20 tests).

Note on rally `units`: the last entry mirrors the running current-game points, and after a game win a fresh `{a:0,b:0}` entry is pushed (matching the spec's "current game's running points for the last entry"). Tennis `units` holds games per set with the current set last.

- [ ] **Step 4: `lib/scoring/configs.test.ts` (failing first)**

```ts
import { describe, expect, it } from 'vitest';
import { SCORING_CONFIGS } from './configs';
import { SPORTS } from '../sports';

describe('SCORING_CONFIGS', () => {
  it('covers exactly the five racquet sports, all present in the sports registry', () => {
    expect(Object.keys(SCORING_CONFIGS).sort()).toEqual(
      ['badminton', 'padel', 'pickleball', 'table_tennis', 'tennis']
    );
    for (const id of Object.keys(SCORING_CONFIGS)) {
      expect(SPORTS[id], `${id} missing from SPORTS registry`).toBeDefined();
    }
  });
  it('rule parameters match the spec', () => {
    expect(SCORING_CONFIGS.tennis).toEqual({ variant: 'tennis', sets: 3 });
    expect(SCORING_CONFIGS.padel).toEqual({ variant: 'tennis', sets: 3 });
    expect(SCORING_CONFIGS.badminton).toEqual({ variant: 'rally', pointsPerGame: 21, cap: 30, games: 3 });
    expect(SCORING_CONFIGS.table_tennis).toEqual({ variant: 'rally', pointsPerGame: 11, cap: null, games: 5 });
    expect(SCORING_CONFIGS.pickleball).toEqual({ variant: 'rally', pointsPerGame: 11, cap: null, games: 3 });
  });
});
```

Run: `npm test -- scoring/configs` → Expected: FAIL (module missing).

- [ ] **Step 5: `lib/scoring/configs.ts`, verify green**

```ts
import type { RacquetConfig } from './types';

export const SCORING_CONFIGS: Record<string, RacquetConfig> = {
  tennis: { variant: 'tennis', sets: 3 },
  padel: { variant: 'tennis', sets: 3 },
  badminton: { variant: 'rally', pointsPerGame: 21, cap: 30, games: 3 },
  table_tennis: { variant: 'rally', pointsPerGame: 11, cap: null, games: 5 },
  pickleball: { variant: 'rally', pointsPerGame: 11, cap: null, games: 3 },
};
```

Run: `npm test` → Expected: 47 passing (25 existing + 20 engine + 2 configs).

- [ ] **Step 6: Commit**

```bash
git add lib/scoring/
git commit -m "feat: racquet scoring engine with tennis and rally variants"
```

---

### Task 3: Live hooks — `lib/hooks/useLive.ts`

**Files:**
- Create: `lib/hooks/useLive.ts`

**Interfaces:**
- Consumes: `supabase`, `useAuth`; `ScoreEvent`, `Side` (Task 2); RPCs (Task 1).
- Produces (Task 4 relies on): `LiveParticipant`, `LiveMatchRow`, `LiveMatchData = { match: LiveMatchRow; events: ScoreEvent[] }`; `useLiveMatch(id)` (key `['live', id]`), `useLiveMatches()` (key `['live-list']`), `useStartLiveMatch()` (input `{ sportId, matchType, format, participants: { profile_id: string; side: Side }[] }`, returns the new live match id), `useAwardPoint(liveMatchId)`, `useUndoPoint(liveMatchId)`, `useFinishLiveMatch()` (input `{ liveMatchId, scoreA, scoreB }`, returns new match id), `useAbandonLiveMatch()` (input liveMatchId).

- [ ] **Step 1: Create `lib/hooks/useLive.ts`**

```ts
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import type { ScoreEvent, Side } from '../scoring/types';
import type { MatchType } from '../types';

export type LiveParticipant = { profile_id: string; side: Side; profile: { username: string } };

export type LiveMatchRow = {
  id: string;
  sport_id: string;
  match_type: MatchType;
  format: '1v1' | 'teams';
  status: 'live' | 'completed' | 'abandoned';
  created_by: string;
  finished_match_id: string | null;
  participants: LiveParticipant[];
};

export type LiveMatchData = { match: LiveMatchRow; events: ScoreEvent[] };

const LIVE_SELECT =
  'id, sport_id, match_type, format, status, created_by, finished_match_id, ' +
  'participants:live_participants(profile_id, side, profile:profiles(username))';

type EventRow = { id: number | string; event_type: 'point' | 'undo'; side: Side | null };
const toScoreEvent = (row: EventRow): ScoreEvent => ({
  id: Number(row.id),
  type: row.event_type,
  side: row.side,
});

export function useLiveMatch(id: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['live', id],
    enabled: !!id,
    queryFn: async (): Promise<LiveMatchData> => {
      const [m, e] = await Promise.all([
        supabase.from('live_matches').select(LIVE_SELECT).eq('id', id).single(),
        supabase.from('live_events').select('id, event_type, side').eq('live_match_id', id).order('id'),
      ]);
      if (m.error) throw m.error;
      if (e.error) throw e.error;
      return {
        match: m.data as unknown as LiveMatchRow,
        events: (e.data as EventRow[]).map(toScoreEvent),
      };
    },
  });

  useEffect(() => {
    if (!id) return;
    const channel = supabase
      .channel(`live-${id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'live_events', filter: `live_match_id=eq.${id}` },
        (payload) => {
          const ev = toScoreEvent(payload.new as EventRow);
          qc.setQueryData<LiveMatchData>(['live', id], (old) => {
            if (!old) return old;
            if (old.events.some((x) => x.id === ev.id)) return old;
            return { ...old, events: [...old.events, ev].sort((a, b) => a.id - b.id) };
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'live_matches', filter: `id=eq.${id}` },
        () => {
          qc.invalidateQueries({ queryKey: ['live', id] });
          qc.invalidateQueries({ queryKey: ['live-list'] });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, qc]);

  return query;
}

export function useLiveMatches() {
  return useQuery({
    queryKey: ['live-list'],
    queryFn: async (): Promise<LiveMatchRow[]> => {
      const { data, error } = await supabase
        .from('live_matches')
        .select(LIVE_SELECT)
        .eq('status', 'live')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as unknown as LiveMatchRow[];
    },
  });
}

export type StartLiveInput = {
  sportId: string;
  matchType: MatchType;
  format: '1v1' | 'teams';
  participants: { profile_id: string; side: Side }[];
};

export function useStartLiveMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: StartLiveInput): Promise<string> => {
      const { data, error } = await supabase.rpc('start_live_match', {
        p_sport_id: input.sportId,
        p_match_type: input.matchType,
        p_format: input.format,
        p_participants: input.participants,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-list'] }),
  });
}

let tempId = Number.MAX_SAFE_INTEGER - 1_000_000;

function useInsertEvent(liveMatchId: string, eventType: 'point' | 'undo') {
  const { session } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (side: Side | null) => {
      const { data, error } = await supabase
        .from('live_events')
        .insert({
          live_match_id: liveMatchId,
          event_type: eventType,
          side,
          created_by: session!.user.id,
        })
        .select('id, event_type, side')
        .single();
      if (error) throw error;
      return toScoreEvent(data as EventRow);
    },
    onMutate: async (side) => {
      const temp: ScoreEvent = { id: ++tempId, type: eventType, side };
      qc.setQueryData<LiveMatchData>(['live', liveMatchId], (old) =>
        old ? { ...old, events: [...old.events, temp] } : old
      );
      return { tempEventId: temp.id };
    },
    onSuccess: (real, _side, ctx) => {
      qc.setQueryData<LiveMatchData>(['live', liveMatchId], (old) => {
        if (!old) return old;
        const withoutTemp = old.events.filter((e) => e.id !== ctx.tempEventId && e.id !== real.id);
        return { ...old, events: [...withoutTemp, real].sort((a, b) => a.id - b.id) };
      });
    },
    onError: (_err, _side, ctx) => {
      qc.setQueryData<LiveMatchData>(['live', liveMatchId], (old) =>
        old ? { ...old, events: old.events.filter((e) => e.id !== ctx?.tempEventId) } : old
      );
    },
  });
}

export function useAwardPoint(liveMatchId: string) {
  return useInsertEvent(liveMatchId, 'point');
}

export function useUndoPoint(liveMatchId: string) {
  const mutation = useInsertEvent(liveMatchId, 'undo');
  return { ...mutation, mutate: () => mutation.mutate(null) };
}

export function useFinishLiveMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { liveMatchId: string; scoreA: number; scoreB: number }): Promise<string> => {
      const { data, error } = await supabase.rpc('finish_live_match', {
        p_live_match_id: input.liveMatchId,
        p_score_a: input.scoreA,
        p_score_b: input.scoreB,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_matchId, input) => {
      qc.invalidateQueries({ queryKey: ['matches'] });
      qc.invalidateQueries({ queryKey: ['live-list'] });
      qc.invalidateQueries({ queryKey: ['live', input.liveMatchId] });
    },
  });
}

export function useAbandonLiveMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (liveMatchId: string) => {
      const { error } = await supabase.rpc('abandon_live_match', { p_live_match_id: liveMatchId });
      if (error) throw error;
    },
    onSuccess: (_void, liveMatchId) => {
      qc.invalidateQueries({ queryKey: ['live-list'] });
      qc.invalidateQueries({ queryKey: ['live', liveMatchId] });
    },
  });
}
```

Temp-id note: optimistic events use descending ids starting just below `Number.MAX_SAFE_INTEGER`, so they sort after all real events (correct: they are the newest) and can never collide with real bigserial ids; the Realtime echo is deduped by real id in both the subscription handler and onSuccess.

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit` → Expected: clean. `npm test` → Expected: 47 passing.

```bash
git add lib/hooks/useLive.ts
git commit -m "feat: live match hooks with realtime subscription and optimistic scoring"
```

---

### Task 4: Screens — live scoreboard, home strip, Score-live branch

**Files:**
- Create: `app/(app)/live/[id].tsx`
- Modify: `app/(app)/_layout.tsx` (hide route)
- Modify: `app/(app)/index.tsx` (In-progress strip)
- Modify: `app/(app)/log-match.tsx` (Score live button on players step)

**Interfaces:**
- Consumes: everything from Tasks 2–3; `getSport`; `useAuth`.
- Produces: the finished milestone.

- [ ] **Step 1: Hide route — in `app/(app)/_layout.tsx`** add after the `match/[id]` line:

```tsx
      <Tabs.Screen name="live/[id]" options={{ href: null }} />
```

- [ ] **Step 2: Create `app/(app)/live/[id].tsx`**

```tsx
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../lib/auth';
import {
  useAbandonLiveMatch, useAwardPoint, useFinishLiveMatch, useLiveMatch, useUndoPoint,
} from '../../../lib/hooks/useLive';
import { foldEvents } from '../../../lib/scoring/engine';
import { SCORING_CONFIGS } from '../../../lib/scoring/configs';
import { getSport } from '../../../lib/sports';
import type { Side } from '../../../lib/scoring/types';

export default function LiveMatch() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const myId = session!.user.id;
  const { data, isLoading } = useLiveMatch(id ?? '');
  const award = useAwardPoint(id ?? '');
  const undoPoint = useUndoPoint(id ?? '');
  const finish = useFinishLiveMatch();
  const abandon = useAbandonLiveMatch();

  if (isLoading || !data) return <View className="flex-1 bg-white" />;
  const { match, events } = data;
  const config = SCORING_CONFIGS[match.sport_id];
  const sport = getSport(match.sport_id);
  if (!config) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Text className="text-gray-400">This sport has no live scoring</Text>
      </View>
    );
  }
  const state = foldEvents(config, events);
  const isParticipant = match.participants.some((p) => p.profile_id === myId);
  const names = (side: Side) =>
    match.participants.filter((p) => p.side === side).map((p) => p.profile.username).join(', ');
  const hasPoints = events.some((e) => e.type === 'point');

  if (match.status !== 'live') {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-white p-6">
        <Text className="text-xl font-semibold capitalize">{match.status}</Text>
        {match.finished_match_id && (
          <Link href={`/match/${match.finished_match_id}`} className="text-emerald-700">
            View the logged match
          </Link>
        )}
      </View>
    );
  }

  function onFinish() {
    finish.mutate(
      { liveMatchId: id!, scoreA: state.setsWon.a, scoreB: state.setsWon.b },
      {
        onSuccess: (matchId) => router.replace(`/match/${matchId}`),
        onError: (e) => Alert.alert('Could not finish', e.message),
      }
    );
  }

  function onAbandon() {
    Alert.alert('Abandon match?', 'Nothing will be logged.', [
      { text: 'Keep playing', style: 'cancel' },
      {
        text: 'Abandon',
        style: 'destructive',
        onPress: () =>
          abandon.mutate(id!, {
            onSuccess: () => router.back(),
            onError: (e) => Alert.alert('Failed', e.message),
          }),
      },
    ]);
  }

  const unitLabel = config.variant === 'tennis' ? 'Sets' : 'Games';

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16" contentContainerClassName="gap-4 pb-12">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl font-bold">{sport?.name ?? match.sport_id}</Text>
        <View className="flex-row items-center gap-2">
          <View className="h-2.5 w-2.5 rounded-full bg-red-500" />
          <Text className="font-semibold text-red-500">LIVE</Text>
        </View>
      </View>
      <Text className="text-gray-400">
        {match.match_type} · {names('a')} vs {names('b')}
      </Text>

      <View className="rounded-xl border border-gray-200 p-4">
        <View className="flex-row justify-between">
          <Text className="font-semibold text-gray-500">{unitLabel}</Text>
          <Text className="font-semibold">
            {state.setsWon.a} – {state.setsWon.b}
          </Text>
        </View>
        <View className="mt-1 flex-row justify-between">
          <Text className="text-gray-500">
            {config.variant === 'tennis' ? 'Games (current set)' : 'Points (current game)'}
          </Text>
          <Text>
            {state.units[state.units.length - 1].a} – {state.units[state.units.length - 1].b}
          </Text>
        </View>
        {state.inTiebreak && <Text className="mt-1 text-amber-600">Tiebreak</Text>}
      </View>

      <View className="flex-row items-center justify-center gap-6 py-4">
        <Text className="text-5xl font-bold">{state.points.a}</Text>
        <Text className="text-2xl text-gray-300">–</Text>
        <Text className="text-5xl font-bold">{state.points.b}</Text>
      </View>

      {isParticipant && !state.isComplete && (
        <View className="flex-row gap-3">
          {(['a', 'b'] as const).map((side) => (
            <Pressable
              key={side}
              className="flex-1 items-center rounded-xl bg-emerald-600 p-6 active:bg-emerald-700"
              onPress={() => award.mutate(side)}
            >
              <Text className="font-semibold text-white">Point</Text>
              <Text className="text-emerald-100" numberOfLines={1}>{names(side)}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {isParticipant && state.isComplete && (
        <Pressable className="rounded-xl bg-emerald-600 p-4" disabled={finish.isPending} onPress={onFinish}>
          <Text className="text-center font-semibold text-white">
            {finish.isPending ? 'Saving…' : `Finish — ${names(state.winner!)} wins`}
          </Text>
        </Pressable>
      )}

      {isParticipant && (
        <View className="flex-row gap-3">
          <Pressable
            className="flex-1 rounded-lg border border-gray-300 p-3"
            disabled={!hasPoints}
            onPress={() => undoPoint.mutate()}
          >
            <Text className={`text-center ${hasPoints ? 'text-gray-700' : 'text-gray-300'}`}>Undo</Text>
          </Pressable>
          <Pressable className="flex-1 rounded-lg border border-red-300 p-3" onPress={onAbandon}>
            <Text className="text-center text-red-500">Abandon</Text>
          </Pressable>
        </View>
      )}

      {!isParticipant && <Text className="text-center text-gray-400">Watching live</Text>}
    </ScrollView>
  );
}
```

- [ ] **Step 3: Home strip — in `app/(app)/index.tsx`** add imports:

```tsx
import { useLiveMatches } from '../../lib/hooks/useLive';
```

Inside `Home`, after the `records` line add:

```tsx
  const { data: liveMatches } = useLiveMatches();
```

Directly above the `<Text className="font-semibold">My record</Text>` line insert:

```tsx
      {(liveMatches ?? []).length > 0 && (
        <>
          <Text className="font-semibold">In progress</Text>
          {(liveMatches ?? []).map((lm) => (
            <Link key={lm.id} href={`/live/${lm.id}`} asChild>
              <Pressable className="flex-row items-center justify-between rounded-lg border border-red-200 p-3">
                <View>
                  <Text className="capitalize">{lm.sport_id.replace('_', ' ')}</Text>
                  <Text className="text-xs text-gray-400" numberOfLines={1}>
                    {lm.participants.filter((p) => p.side === 'a').map((p) => p.profile.username).join(', ')}
                    {' vs '}
                    {lm.participants.filter((p) => p.side === 'b').map((p) => p.profile.username).join(', ')}
                  </Text>
                </View>
                <Text className="font-semibold text-red-500">LIVE</Text>
              </Pressable>
            </Link>
          ))}
        </>
      )}
```

- [ ] **Step 4: Score-live branch — in `app/(app)/log-match.tsx`:**

Add imports:

```tsx
import { useStartLiveMatch } from '../../lib/hooks/useLive';
import { SCORING_CONFIGS } from '../../lib/scoring/configs';
```

Inside the component add (after `const logMatch = useLogMatch();`):

```tsx
  const startLive = useStartLiveMatch();
```

Add this handler after `onSubmit`:

```tsx
  function onScoreLive() {
    const err = stepValid();
    if (err) { Alert.alert('Hold on', err); return; }
    startLive.mutate(
      {
        sportId,
        matchType,
        format: format as '1v1' | 'teams',
        participants: [
          ...sideA.map((pid) => ({ profile_id: pid, side: 'a' as const })),
          ...sideB.map((pid) => ({ profile_id: pid, side: 'b' as const })),
        ],
      },
      {
        onSuccess: (liveId) => {
          setStep(0); setSportId(''); resetPlayers('1v1'); setStatInputs({}); setStatsFor(null);
          router.push(`/live/${liveId}`);
        },
        onError: (e) => Alert.alert('Could not start live match', e.message),
      }
    );
  }
```

In the JSX, inside the `{step === 2 && format !== 'ffa' && (` block, append after the friends-empty hint:

```tsx
          {SCORING_CONFIGS[sportId] && (
            <Pressable
              className="mt-2 rounded-lg border border-red-400 p-4"
              disabled={startLive.isPending}
              onPress={onScoreLive}
            >
              <Text className="text-center font-semibold text-red-500">
                {startLive.isPending ? 'Starting…' : '● Score live instead'}
              </Text>
            </Pressable>
          )}
```

Note: `matchType` defaults to `'official'` at this step; scorers can't change it in the live branch for v1 — acceptable, it's the default flow, and the type chip is on a later step of the post-match path. (If reviewers flag it: the spec's start flow places "Score live" on the players step by design.)

- [ ] **Step 5: Verify**

`npx tsc --noEmit` clean (start the dev server once if the new route's typed-routes entry is missing); `npm test` 47 passing; simulator boot check (screenshot, clean mount, kill server).

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/live" "app/(app)/_layout.tsx" "app/(app)/index.tsx" "app/(app)/log-match.tsx"
git commit -m "feat: live scoreboard screen, in-progress strip, and score-live entry point"
```

---

### Task 5: Close out

**Files:**
- Modify: `CLAUDE.md` (Status section)

- [ ] **Step 1:** Update CLAUDE.md §5: M3 built on `m3-live-scoring` — live scoring for the 5 racquet sports (event-sourced `live_events`, pure engine in `lib/scoring/`, Realtime spectating for friends, lifecycle RPCs in migration 0006, finish inserts a real match). Note deferrals unchanged (cricket engine, serve tracking, stat appending). Keep backend/test-account lines and the M4 roadmap note.

- [ ] **Step 2:** `npx tsc --noEmit && npm test` → clean, 47 passing.

- [ ] **Step 3:**

```bash
git add CLAUDE.md
git commit -m "docs: record milestone 3 completion"
```

---

## Controller-only steps

After Task 1: apply migration 0006 (`supabase db push`); verify realtime publication includes the new tables. After Task 4: live E2E — start a live tennis match as alice (via RPC), award points as alice AND bob, verify bob's read of events matches, stranger (service-role-created third account or anon) blocked from reading/inserting, non-participant insert rejected, fold a quick 2-set match with the engine locally to get final sets, finish via RPC → match row with correct outcomes + `finished_match_id`, abandon a second live match → nothing logged, direct insert/update on `live_matches` rejected. Then Suryansh's two-device walkthrough, final whole-branch review, merge on his sign-off.
