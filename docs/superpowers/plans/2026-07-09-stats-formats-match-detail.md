# Sportly M2: Stats, Formats & Match Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Matches support 1v1/teams/FFA with per-sport player stats, written atomically through a server-side `log_match` RPC, browsable via a new match detail screen.

**Architecture:** Migration 0004 adds format/side/rank/stats columns and the SECURITY DEFINER `log_match` RPC (the only write path for matches — client insert policies are dropped; outcomes derived server-side). Migration 0005 hardens friendships. Sport definitions are a TypeScript registry (`lib/sports/`, one file per sport: Zod stat schema + display metadata + derived-stat calculators). Pure logic in `lib/` stays framework-free and Vitest-covered. Screens: log-match becomes a 5-step flow; match detail is a new hidden route.

**Tech Stack:** Existing stack only — Expo SDK 57, TypeScript, Expo Router, NativeWind v4, TanStack Query, Zod, supabase-js, Vitest. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-09-stats-formats-match-detail-design.md` — the spec governs on any conflict.

## Global Constraints

- Canonical strings everywhere: match types `'official'`/`'friendly'`; outcomes `'win'`/`'loss'`/`'draw'`; formats `'1v1'`/`'teams'`/`'ffa'`; sides `'a'`/`'b'`.
- Record math (decided, do not reopen): 1v1/teams — side result applies to every member, head-to-head counts only sided matches with the two profiles on opposite sides; FFA — rank 1 = win (ties share it), everyone else loss, FFA never appears in head-to-head.
- Outcomes are derived **server-side only** (in `log_match`). The pure TS mirrors exist for tests/optimistic UI, never for persistence. Clients never write `outcome`.
- Derived stats (strike rate, economy) are computed at display time, **never stored** in jsonb.
- Migrations are file-only for implementers: write `supabase/migrations/000N_*.sql`; the controller applies them (`supabase db push`) and runs live verification. Implementers never run Supabase MCP tools or `db push`.
- SECURITY DEFINER functions must `set search_path` explicitly. `log_match` is granted to `authenticated` only.
- All stat fields optional; stat entry skippable. Stats jsonb DB guard is only `jsonb_typeof(stats) = 'object'`.
- Deliberate deferrals (do NOT build): live scoring, tournaments, groups/rosters, ratings, per-sport server-side stat validation, design polish, RNTL, React Hook Form, React Native Reusables, push, EAS.
- Verification per task: `npx tsc --noEmit` clean and `npm test` green. Screens tasks additionally boot the app in the iOS simulator (`npx expo start --ios`, screenshot via `xcrun simctl io booted screenshot`, then kill the server) and confirm no red screen.
- `.superpowers/` is git-ignored scratch — never commit it. No secrets in committed files.
- Work on branch `m2-stats-formats` (controller creates it from `main`).

---

## File Structure

```
supabase/migrations/
  0004_match_formats_stats.sql   # columns, backfill, log_match RPC, drop insert policies
  0005_friendship_hardening.sql  # immutability trigger + canonical-pair unique index
lib/
  types.ts                       # + MatchFormat, Side; MatchRow/ParticipantRow extended
  outcomes.ts                    # deriveSideOutcomes, deriveFfaOutcomes (replaces deriveOutcomes)
  records.ts                     # filterHeadToHead: sided + opposite-side + no-FFA
  matchSummary.ts                # NEW: one-line score/rank summary for list rows
  sports/
    types.ts                     # StatField, DerivedStat, SportDefinition
    derived.ts                   # strikeRate, economy
    cricket.ts football.ts basketball.ts tennis.ts
    padel.ts pickleball.ts table_tennis.ts badminton.ts
    index.ts                     # SPORTS registry + getSport()
  hooks/
    useMatches.ts                # new select, useMatch(id), useLogMatch → rpc
app/(app)/
  log-match.tsx                  # rebuilt: 5-step flow
  match/[id].tsx                 # NEW: match detail
  index.tsx                      # rows link to detail
  profile/[id].tsx               # + head-to-head match list, rows link to detail
  _layout.tsx                    # hide match/[id] from tab bar
```

---

### Task 1: Migration 0004 — formats, stats, backfill, `log_match` RPC

**Files:**
- Create: `supabase/migrations/0004_match_formats_stats.sql`

**Interfaces:**
- Consumes: existing `matches`, `match_participants`, `sports`, `profiles` tables (migrations 0001–0003).
- Produces: columns `matches.format/score_a/score_b`, `match_participants.side/rank/stats`; function `public.log_match(p_sport_id text, p_match_type text, p_format text, p_score_a integer, p_score_b integer, p_participants jsonb) returns uuid`. Task 5's `useLogMatch` calls it via `supabase.rpc('log_match', {...})` with participant objects `{ profile_id, side, rank, score, stats }`.

- [ ] **Step 1: Write the migration file** (file only — do NOT apply it; the controller does)

Create `supabase/migrations/0004_match_formats_stats.sql`:

```sql
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
```

- [ ] **Step 2: Sanity-check the SQL locally**

Run: `grep -c "raise exception" supabase/migrations/0004_match_formats_stats.sql`
Expected: `15`. Also re-read the file against this plan — it must match exactly.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0004_match_formats_stats.sql
git commit -m "feat: match formats, participant stats, and atomic log_match RPC"
```

---

### Task 2: Migration 0005 — friendship hardening

**Files:**
- Create: `supabase/migrations/0005_friendship_hardening.sql`

**Interfaces:**
- Consumes: `friendships` table (migration 0002).
- Produces: trigger `friendship_immutability`; unique index `friendships_canonical_pair`. No TS interfaces.

- [ ] **Step 1: Write the migration file** (file only — controller applies)

Create `supabase/migrations/0005_friendship_hardening.sql`:

```sql
create function public.enforce_friendship_immutability()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.requester_id <> old.requester_id or new.addressee_id <> old.addressee_id then
    raise exception 'friendship participants are immutable';
  end if;
  if old.status = 'accepted' and new.status <> 'accepted' then
    raise exception 'accepted friendships cannot be reverted';
  end if;
  return new;
end;
$$;

create trigger friendship_immutability
  before update on public.friendships
  for each row execute function public.enforce_friendship_immutability();

-- Remove reverse-direction duplicates (keep the older row) so the index can build
delete from public.friendships f
using public.friendships g
where f.requester_id = g.addressee_id
  and f.addressee_id = g.requester_id
  and (f.created_at > g.created_at
       or (f.created_at = g.created_at and f.id > g.id));

create unique index friendships_canonical_pair
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0005_friendship_hardening.sql
git commit -m "feat: harden friendships with immutability trigger and canonical-pair uniqueness"
```

---

### Task 3: Pure logic — types, outcomes, head-to-head, match summary (TDD)

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/outcomes.ts`, `lib/outcomes.test.ts` (full rewrite of both)
- Modify: `lib/records.ts` (only `filterHeadToHead`), `lib/records.test.ts` (full rewrite)
- Create: `lib/matchSummary.ts`, `lib/matchSummary.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 5–7 depend on exact names):
  - `lib/types.ts`: `MatchFormat = '1v1' | 'teams' | 'ffa'`; `Side = 'a' | 'b'`; `ParticipantRow = { profile_id: string; score: number | null; outcome: Outcome; side: Side | null; rank: number | null; stats: Record<string, number> | null }`; `MatchRow = { id: string; sport_id: string; match_type: MatchType; format: MatchFormat; played_at: string; score_a: number | null; score_b: number | null; participants: ParticipantRow[] }`.
  - `lib/outcomes.ts`: `deriveSideOutcomes(scoreA: number, scoreB: number): { a: Outcome; b: Outcome }`; `deriveFfaOutcomes(ranks: Map<string, number>): Map<string, Outcome>`. (`deriveOutcomes` is deleted — nothing may import it after this task.)
  - `lib/records.ts`: `computeRecord` unchanged; `filterHeadToHead(matches, a, b)` with new semantics.
  - `lib/matchSummary.ts`: `matchSummary(m: MatchRow, viewerId: string): string`.

- [ ] **Step 1: Update `lib/types.ts`** (replace file)

```ts
export type Outcome = 'win' | 'loss' | 'draw';
export type MatchType = 'official' | 'friendly';
export type MatchFormat = '1v1' | 'teams' | 'ffa';
export type Side = 'a' | 'b';

export type ParticipantRow = {
  profile_id: string;
  score: number | null;
  outcome: Outcome;
  side: Side | null;
  rank: number | null;
  stats: Record<string, number> | null;
};

export type MatchRow = {
  id: string;
  sport_id: string;
  match_type: MatchType;
  format: MatchFormat;
  played_at: string;
  score_a: number | null;
  score_b: number | null;
  participants: ParticipantRow[];
};
```

(`npx tsc --noEmit` will now fail in tests/hooks — expected; the following steps fix each in turn. The suite must be green again by Step 8. `lib/hooks/useMatches.ts` still imports `deriveOutcomes` and builds old-shape rows — it is rewritten in Task 5; until then only the *tests* in this task must compile and pass: run vitest with `npm test`, which doesn't typecheck the hooks. Leave `useMatches.ts` untouched.)

- [ ] **Step 2: Rewrite `lib/outcomes.test.ts` (failing first)**

```ts
import { describe, expect, it } from 'vitest';
import { deriveFfaOutcomes, deriveSideOutcomes } from './outcomes';

describe('deriveSideOutcomes', () => {
  it('higher side score wins', () => {
    expect(deriveSideOutcomes(3, 1)).toEqual({ a: 'win', b: 'loss' });
    expect(deriveSideOutcomes(0, 2)).toEqual({ a: 'loss', b: 'win' });
  });
  it('equal side scores draw', () => {
    expect(deriveSideOutcomes(2, 2)).toEqual({ a: 'draw', b: 'draw' });
  });
});

describe('deriveFfaOutcomes', () => {
  it('rank 1 wins, everyone else loses', () => {
    const out = deriveFfaOutcomes(new Map([['x', 1], ['y', 2], ['z', 3]]));
    expect(out.get('x')).toBe('win');
    expect(out.get('y')).toBe('loss');
    expect(out.get('z')).toBe('loss');
  });
  it('ties at rank 1 share the win', () => {
    const out = deriveFfaOutcomes(new Map([['x', 1], ['y', 1], ['z', 3]]));
    expect(out.get('x')).toBe('win');
    expect(out.get('y')).toBe('win');
    expect(out.get('z')).toBe('loss');
  });
});
```

Run: `npm test` → Expected: FAIL (`deriveSideOutcomes` is not exported).

- [ ] **Step 3: Rewrite `lib/outcomes.ts`, verify green**

```ts
import type { Outcome } from './types';

export function deriveSideOutcomes(scoreA: number, scoreB: number): { a: Outcome; b: Outcome } {
  if (scoreA > scoreB) return { a: 'win', b: 'loss' };
  if (scoreA < scoreB) return { a: 'loss', b: 'win' };
  return { a: 'draw', b: 'draw' };
}

export function deriveFfaOutcomes(ranks: Map<string, number>): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  for (const [profileId, rank] of ranks) {
    outcomes.set(profileId, rank === 1 ? 'win' : 'loss');
  }
  return outcomes;
}
```

Run: `npm test -- outcomes` → Expected: 4 passing.

- [ ] **Step 4: Rewrite `lib/records.test.ts` (failing first)**

```ts
import { describe, expect, it } from 'vitest';
import type { MatchFormat, MatchRow, MatchType, Outcome, ParticipantRow, Side } from './types';
import { computeRecord, filterHeadToHead } from './records';

const P = (id: string, side: Side | null, outcome: Outcome, rank: number | null = null): ParticipantRow =>
  ({ profile_id: id, score: null, outcome, side, rank, stats: null });

const M = (
  id: string, sport: string, type: MatchType, format: MatchFormat,
  scoreA: number | null, scoreB: number | null, participants: ParticipantRow[]
): MatchRow =>
  ({ id, sport_id: sport, match_type: type, format, played_at: '2026-07-09', score_a: scoreA, score_b: scoreB, participants });

describe('computeRecord', () => {
  it('aggregates official wins/losses/draws per sport (1v1)', () => {
    const matches = [
      M('1', 'tennis', 'official', '1v1', 2, 0, [P('alice', 'a', 'win'), P('bob', 'b', 'loss')]),
      M('2', 'tennis', 'official', '1v1', 0, 2, [P('alice', 'a', 'loss'), P('bob', 'b', 'win')]),
      M('3', 'tennis', 'official', '1v1', 1, 1, [P('alice', 'a', 'draw'), P('bob', 'b', 'draw')]),
      M('4', 'football', 'official', '1v1', 3, 1, [P('alice', 'a', 'win'), P('bob', 'b', 'loss')]),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([
      { sportId: 'tennis', wins: 1, losses: 1, draws: 1 },
      { sportId: 'football', wins: 1, losses: 0, draws: 0 },
    ]);
  });

  it('team result applies to every member of the side', () => {
    const matches = [
      M('1', 'football', 'official', 'teams', 2, 1,
        [P('alice', 'a', 'win'), P('carol', 'a', 'win'), P('bob', 'b', 'loss'), P('dave', 'b', 'loss')]),
    ];
    expect(computeRecord(matches, 'carol')).toEqual([{ sportId: 'football', wins: 1, losses: 0, draws: 0 }]);
    expect(computeRecord(matches, 'dave')).toEqual([{ sportId: 'football', wins: 0, losses: 1, draws: 0 }]);
  });

  it('ffa: rank 1 wins, others lose', () => {
    const matches = [
      M('1', 'table_tennis', 'official', 'ffa', null, null,
        [P('alice', null, 'win', 1), P('bob', null, 'loss', 2), P('carol', null, 'loss', 3)]),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([{ sportId: 'table_tennis', wins: 1, losses: 0, draws: 0 }]);
    expect(computeRecord(matches, 'bob')).toEqual([{ sportId: 'table_tennis', wins: 0, losses: 1, draws: 0 }]);
  });

  it('excludes friendly matches', () => {
    const matches = [
      M('1', 'tennis', 'friendly', '1v1', 2, 0, [P('alice', 'a', 'win'), P('bob', 'b', 'loss')]),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([]);
  });

  it('ignores matches the profile is not in', () => {
    const matches = [
      M('1', 'tennis', 'official', '1v1', 2, 0, [P('bob', 'a', 'win'), P('carol', 'b', 'loss')]),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([]);
  });
});

describe('filterHeadToHead', () => {
  it('keeps sided matches with the two profiles on opposite sides', () => {
    const matches = [
      M('1', 'tennis', 'official', '1v1', 2, 0, [P('alice', 'a', 'win'), P('bob', 'b', 'loss')]),
      M('2', 'football', 'official', 'teams', 1, 0,
        [P('alice', 'a', 'win'), P('bob', 'b', 'loss'), P('carol', 'b', 'loss')]),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob').map((m) => m.id)).toEqual(['1', '2']);
  });

  it('excludes teammates on the same side', () => {
    const matches = [
      M('1', 'football', 'official', 'teams', 1, 0,
        [P('alice', 'a', 'win'), P('bob', 'a', 'win'), P('carol', 'b', 'loss')]),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob')).toEqual([]);
  });

  it('excludes ffa matches entirely', () => {
    const matches = [
      M('1', 'table_tennis', 'official', 'ffa', null, null,
        [P('alice', null, 'win', 1), P('bob', null, 'loss', 2)]),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob')).toEqual([]);
  });

  it('excludes matches missing either profile', () => {
    const matches = [
      M('1', 'tennis', 'official', '1v1', 2, 0, [P('alice', 'a', 'win'), P('carol', 'b', 'loss')]),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob')).toEqual([]);
  });
});
```

Run: `npm test -- records` → Expected: FAIL (old `filterHeadToHead` keeps same-side and FFA matches; also fixtures now compile against new types).

- [ ] **Step 5: Update `filterHeadToHead` in `lib/records.ts`, verify green**

Replace only the `filterHeadToHead` function (leave `computeRecord` and `SportRecord` untouched):

```ts
export function filterHeadToHead(matches: MatchRow[], a: string, b: string): MatchRow[] {
  return matches.filter((m) => {
    if (m.format === 'ffa') return false;
    const pa = m.participants.find((p) => p.profile_id === a);
    const pb = m.participants.find((p) => p.profile_id === b);
    return !!pa?.side && !!pb?.side && pa.side !== pb.side;
  });
}
```

Run: `npm test -- records` → Expected: 9 passing.

- [ ] **Step 6: Write `lib/matchSummary.test.ts` (failing first)**

```ts
import { describe, expect, it } from 'vitest';
import type { MatchRow, ParticipantRow } from './types';
import { matchSummary } from './matchSummary';

const base: Omit<MatchRow, 'participants' | 'format' | 'score_a' | 'score_b'> = {
  id: '1', sport_id: 'tennis', match_type: 'official', played_at: '2026-07-09',
};
const P = (id: string, side: 'a' | 'b' | null, rank: number | null = null): ParticipantRow =>
  ({ profile_id: id, score: null, outcome: 'win', side, rank, stats: null });

describe('matchSummary', () => {
  it('shows viewer-side-first score for sided matches', () => {
    const m: MatchRow = { ...base, format: '1v1', score_a: 3, score_b: 1,
      participants: [P('alice', 'a'), P('bob', 'b')] };
    expect(matchSummary(m, 'alice')).toBe('3–1');
    expect(matchSummary(m, 'bob')).toBe('1–3');
  });
  it('shows placement for ffa', () => {
    const m: MatchRow = { ...base, format: 'ffa', score_a: null, score_b: null,
      participants: [P('alice', null, 1), P('bob', null, 2), P('carol', null, 3)] };
    expect(matchSummary(m, 'bob')).toBe('2nd of 3');
    expect(matchSummary(m, 'alice')).toBe('1st of 3');
  });
  it('empty string when data is missing', () => {
    const m: MatchRow = { ...base, format: 'teams', score_a: null, score_b: null, participants: [] };
    expect(matchSummary(m, 'alice')).toBe('');
  });
});
```

Run: `npm test -- matchSummary` → Expected: FAIL (module missing).

- [ ] **Step 7: Implement `lib/matchSummary.ts`, verify green**

```ts
import type { MatchRow } from './types';

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

export function matchSummary(m: MatchRow, viewerId: string): string {
  if (m.format === 'ffa') {
    const me = m.participants.find((p) => p.profile_id === viewerId);
    if (!me?.rank) return '';
    return `${ordinal(me.rank)} of ${m.participants.length}`;
  }
  if (m.score_a == null || m.score_b == null) return '';
  const mySide = m.participants.find((p) => p.profile_id === viewerId)?.side;
  return mySide === 'b' ? `${m.score_b}–${m.score_a}` : `${m.score_a}–${m.score_b}`;
}
```

Run: `npm test -- matchSummary` → Expected: 3 passing.

- [ ] **Step 8: Full suite + commit**

Run: `npm test` → Expected: all passing (4 outcomes + 9 records + 3 summary + 1 friends = 17).
(`npx tsc --noEmit` still fails only in `lib/hooks/useMatches.ts` — that is Task 5's job; note it in your report rather than fixing it.)

```bash
git add lib/types.ts lib/outcomes.ts lib/outcomes.test.ts lib/records.ts lib/records.test.ts lib/matchSummary.ts lib/matchSummary.test.ts
git commit -m "feat: multi-format outcome derivation, head-to-head semantics, match summaries"
```

---

### Task 4: Sport definition registry (TDD)

**Files:**
- Create: `lib/sports/types.ts`, `lib/sports/derived.ts`, `lib/sports/derived.test.ts`, `lib/sports/cricket.ts`, `lib/sports/football.ts`, `lib/sports/basketball.ts`, `lib/sports/tennis.ts`, `lib/sports/padel.ts`, `lib/sports/pickleball.ts`, `lib/sports/table_tennis.ts`, `lib/sports/badminton.ts`, `lib/sports/index.ts`, `lib/sports/index.test.ts`

**Interfaces:**
- Consumes: `MatchFormat` from `lib/types.ts` (Task 3).
- Produces (Tasks 6–7 depend on): `SportDefinition`, `StatField`, `DerivedStat` from `lib/sports/types.ts`; `SPORTS: Record<string, SportDefinition>` and `getSport(id: string): SportDefinition | undefined` from `lib/sports/index.ts`.

- [ ] **Step 1: `lib/sports/types.ts`**

```ts
import type { z } from 'zod';
import type { MatchFormat } from '../types';

export type StatField = {
  key: string;
  label: string;
  shortLabel: string;
};

export type DerivedStat = {
  key: string;
  label: string;
  shortLabel: string;
  decimals: number;
  compute: (stats: Record<string, number>) => number | null;
};

export type SportDefinition = {
  id: string;
  name: string;
  formats: ReadonlyArray<MatchFormat>;
  scoreLabel: string;
  statSchema: z.ZodTypeAny;
  statFields: StatField[];
  derivedStats: DerivedStat[];
};
```

- [ ] **Step 2: `lib/sports/derived.test.ts` (failing first)**

```ts
import { describe, expect, it } from 'vitest';
import { economy, strikeRate } from './derived';

describe('strikeRate', () => {
  it('runs per 100 balls', () => expect(strikeRate({ runs: 50, balls_faced: 40 })).toBeCloseTo(125));
  it('null when balls_faced missing or zero', () => {
    expect(strikeRate({ runs: 50 })).toBeNull();
    expect(strikeRate({ runs: 50, balls_faced: 0 })).toBeNull();
  });
});

describe('economy', () => {
  it('runs conceded per over', () => expect(economy({ runs_conceded: 30, overs_bowled: 4 })).toBeCloseTo(7.5));
  it('null when overs missing or zero', () => {
    expect(economy({ runs_conceded: 30 })).toBeNull();
    expect(economy({ runs_conceded: 30, overs_bowled: 0 })).toBeNull();
  });
});
```

Run: `npm test -- derived` → Expected: FAIL (module missing).

- [ ] **Step 3: `lib/sports/derived.ts`, verify green**

```ts
export function strikeRate(stats: Record<string, number>): number | null {
  if (stats.runs == null || !stats.balls_faced) return null;
  return (stats.runs / stats.balls_faced) * 100;
}

export function economy(stats: Record<string, number>): number | null {
  if (stats.runs_conceded == null || !stats.overs_bowled) return null;
  return stats.runs_conceded / stats.overs_bowled;
}
```

Run: `npm test -- derived` → Expected: 4 passing.

- [ ] **Step 4: The eight sport files**

Shared convention: every stat field is `z.number().int().min(0).optional()` except cricket's `overs_bowled`, which allows decimals: `z.number().min(0).optional()`. Every schema is `.strict()` (unknown keys rejected).

`lib/sports/cricket.ts`:

```ts
import { z } from 'zod';
import type { SportDefinition } from './types';
import { economy, strikeRate } from './derived';

const stat = () => z.number().int().min(0).optional();

export const cricket: SportDefinition = {
  id: 'cricket',
  name: 'Cricket',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Runs',
  statSchema: z.object({
    runs: stat(), balls_faced: stat(), fours: stat(), sixes: stat(),
    overs_bowled: z.number().min(0).optional(),
    runs_conceded: stat(), wickets: stat(), catches: stat(),
  }).strict(),
  statFields: [
    { key: 'runs', label: 'Runs', shortLabel: 'R' },
    { key: 'balls_faced', label: 'Balls faced', shortLabel: 'BF' },
    { key: 'fours', label: 'Fours', shortLabel: '4s' },
    { key: 'sixes', label: 'Sixes', shortLabel: '6s' },
    { key: 'overs_bowled', label: 'Overs bowled', shortLabel: 'O' },
    { key: 'runs_conceded', label: 'Runs conceded', shortLabel: 'RC' },
    { key: 'wickets', label: 'Wickets', shortLabel: 'W' },
    { key: 'catches', label: 'Catches', shortLabel: 'Ct' },
  ],
  derivedStats: [
    { key: 'strike_rate', label: 'Strike rate', shortLabel: 'SR', decimals: 1, compute: strikeRate },
    { key: 'economy', label: 'Economy', shortLabel: 'Econ', decimals: 2, compute: economy },
  ],
};
```

`lib/sports/football.ts`:

```ts
import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const football: SportDefinition = {
  id: 'football',
  name: 'Football',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Goals',
  statSchema: z.object({
    goals: stat(), assists: stat(), saves: stat(), yellow_cards: stat(), red_cards: stat(),
  }).strict(),
  statFields: [
    { key: 'goals', label: 'Goals', shortLabel: 'G' },
    { key: 'assists', label: 'Assists', shortLabel: 'A' },
    { key: 'saves', label: 'Saves', shortLabel: 'Sv' },
    { key: 'yellow_cards', label: 'Yellow cards', shortLabel: 'YC' },
    { key: 'red_cards', label: 'Red cards', shortLabel: 'RC' },
  ],
  derivedStats: [],
};
```

`lib/sports/basketball.ts`:

```ts
import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const basketball: SportDefinition = {
  id: 'basketball',
  name: 'Basketball',
  formats: ['1v1', 'teams', 'ffa'],
  scoreLabel: 'Points',
  statSchema: z.object({
    points: stat(), rebounds: stat(), assists: stat(), steals: stat(), blocks: stat(), three_pointers: stat(),
  }).strict(),
  statFields: [
    { key: 'points', label: 'Points', shortLabel: 'PTS' },
    { key: 'rebounds', label: 'Rebounds', shortLabel: 'REB' },
    { key: 'assists', label: 'Assists', shortLabel: 'AST' },
    { key: 'steals', label: 'Steals', shortLabel: 'STL' },
    { key: 'blocks', label: 'Blocks', shortLabel: 'BLK' },
    { key: 'three_pointers', label: 'Three pointers', shortLabel: '3PT' },
  ],
  derivedStats: [],
};
```

`lib/sports/tennis.ts`:

```ts
import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const tennis: SportDefinition = {
  id: 'tennis',
  name: 'Tennis',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Sets',
  statSchema: z.object({
    games_won: stat(), aces: stat(), double_faults: stat(), winners: stat(), unforced_errors: stat(),
  }).strict(),
  statFields: [
    { key: 'games_won', label: 'Games won', shortLabel: 'GW' },
    { key: 'aces', label: 'Aces', shortLabel: 'Ace' },
    { key: 'double_faults', label: 'Double faults', shortLabel: 'DF' },
    { key: 'winners', label: 'Winners', shortLabel: 'Win' },
    { key: 'unforced_errors', label: 'Unforced errors', shortLabel: 'UE' },
  ],
  derivedStats: [],
};
```

`lib/sports/padel.ts`:

```ts
import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const padel: SportDefinition = {
  id: 'padel',
  name: 'Padel',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Sets',
  statSchema: z.object({
    games_won: stat(), winners: stat(), unforced_errors: stat(), smashes: stat(),
  }).strict(),
  statFields: [
    { key: 'games_won', label: 'Games won', shortLabel: 'GW' },
    { key: 'winners', label: 'Winners', shortLabel: 'Win' },
    { key: 'unforced_errors', label: 'Unforced errors', shortLabel: 'UE' },
    { key: 'smashes', label: 'Smashes', shortLabel: 'Sm' },
  ],
  derivedStats: [],
};
```

`lib/sports/pickleball.ts`:

```ts
import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const pickleball: SportDefinition = {
  id: 'pickleball',
  name: 'Pickleball',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Games',
  statSchema: z.object({
    points_won: stat(), aces: stat(), faults: stat(),
  }).strict(),
  statFields: [
    { key: 'points_won', label: 'Points won', shortLabel: 'PW' },
    { key: 'aces', label: 'Aces', shortLabel: 'Ace' },
    { key: 'faults', label: 'Faults', shortLabel: 'F' },
  ],
  derivedStats: [],
};
```

`lib/sports/table_tennis.ts`:

```ts
import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const tableTennis: SportDefinition = {
  id: 'table_tennis',
  name: 'Table Tennis',
  formats: ['1v1', 'teams', 'ffa'],
  scoreLabel: 'Games',
  statSchema: z.object({
    points_won: stat(), aces: stat(), serve_faults: stat(),
  }).strict(),
  statFields: [
    { key: 'points_won', label: 'Points won', shortLabel: 'PW' },
    { key: 'aces', label: 'Aces', shortLabel: 'Ace' },
    { key: 'serve_faults', label: 'Serve faults', shortLabel: 'SF' },
  ],
  derivedStats: [],
};
```

`lib/sports/badminton.ts`:

```ts
import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const badminton: SportDefinition = {
  id: 'badminton',
  name: 'Badminton',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Games',
  statSchema: z.object({
    points_won: stat(), aces: stat(), smash_winners: stat(),
  }).strict(),
  statFields: [
    { key: 'points_won', label: 'Points won', shortLabel: 'PW' },
    { key: 'aces', label: 'Aces', shortLabel: 'Ace' },
    { key: 'smash_winners', label: 'Smash winners', shortLabel: 'SW' },
  ],
  derivedStats: [],
};
```

- [ ] **Step 5: `lib/sports/index.test.ts` (failing first)**

```ts
import { describe, expect, it } from 'vitest';
import { SPORTS, getSport } from './index';

const CANONICAL_IDS = [
  'football', 'cricket', 'basketball', 'tennis',
  'padel', 'pickleball', 'table_tennis', 'badminton',
];

describe('SPORTS registry', () => {
  it('contains exactly the canonical sport ids', () => {
    expect(Object.keys(SPORTS).sort()).toEqual([...CANONICAL_IDS].sort());
  });

  it('every definition is internally consistent', () => {
    for (const [id, sport] of Object.entries(SPORTS)) {
      expect(sport.id).toBe(id);
      expect(sport.formats.length).toBeGreaterThan(0);
      expect(sport.statFields.length).toBeGreaterThan(0);
      // every statField key is accepted by the schema
      const sample = Object.fromEntries(sport.statFields.map((f) => [f.key, 1]));
      expect(sport.statSchema.safeParse(sample).success, `${id} schema rejects its own fields`).toBe(true);
    }
  });

  it('schemas accept empty stats, reject unknown keys and negatives', () => {
    for (const sport of Object.values(SPORTS)) {
      expect(sport.statSchema.safeParse({}).success).toBe(true);
      expect(sport.statSchema.safeParse({ bogus_key: 1 }).success).toBe(false);
      const firstKey = sport.statFields[0].key;
      expect(sport.statSchema.safeParse({ [firstKey]: -1 }).success).toBe(false);
    }
  });

  it('getSport returns definitions and undefined for unknown ids', () => {
    expect(getSport('cricket')?.name).toBe('Cricket');
    expect(getSport('quidditch')).toBeUndefined();
  });
});
```

Run: `npm test -- sports/index` → Expected: FAIL (module missing).

- [ ] **Step 6: `lib/sports/index.ts`, verify green**

```ts
import type { SportDefinition } from './types';
import { badminton } from './badminton';
import { basketball } from './basketball';
import { cricket } from './cricket';
import { football } from './football';
import { padel } from './padel';
import { pickleball } from './pickleball';
import { tableTennis } from './table_tennis';
import { tennis } from './tennis';

export type { DerivedStat, SportDefinition, StatField } from './types';

export const SPORTS: Record<string, SportDefinition> = {
  football, cricket, basketball, tennis, padel, pickleball,
  table_tennis: tableTennis, badminton,
};

export function getSport(id: string): SportDefinition | undefined {
  return SPORTS[id];
}
```

Run: `npm test` → Expected: all passing (17 + 4 derived + 4 registry = 25).

- [ ] **Step 7: Commit**

```bash
git add lib/sports/
git commit -m "feat: per-sport definition registry with stat schemas and derived stats"
```

---

### Task 5: Hooks — new match select, `useMatch`, RPC-backed `useLogMatch`

**Files:**
- Modify: `lib/hooks/useMatches.ts` (full rewrite)

**Interfaces:**
- Consumes: `MatchRow`, `MatchType`, `MatchFormat`, `ParticipantRow` (Task 3); `log_match` RPC (Task 1); `supabase`, `useAuth`.
- Produces (Tasks 6–7 depend on):
  - `useSports()` — unchanged shape.
  - `useMatches()` — `MatchRow[]`, key `['matches']`, ordered `played_at` desc then `created_at` desc.
  - `useMatch(id: string)` — key `['match', id]`, returns `MatchDetailRow` (participants carry `profile: { username: string }`).
  - `LogMatchParticipant = { profile_id: string; side: Side | null; rank: number | null; score: number | null; stats: Record<string, number> | null }`
  - `LogMatchInput = { sportId: string; matchType: MatchType; format: MatchFormat; scoreA: number | null; scoreB: number | null; participants: LogMatchParticipant[] }`
  - `useLogMatch()` — mutation calling the RPC, invalidates `['matches']`.

- [ ] **Step 1: Rewrite `lib/hooks/useMatches.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import type { MatchFormat, MatchRow, MatchType, ParticipantRow, Side } from '../types';

const MATCH_SELECT =
  'id, sport_id, match_type, format, played_at, score_a, score_b, ' +
  'participants:match_participants(profile_id, score, outcome, side, rank, stats)';

const MATCH_DETAIL_SELECT =
  'id, sport_id, match_type, format, played_at, score_a, score_b, ' +
  'participants:match_participants(profile_id, score, outcome, side, rank, stats, profile:profiles(username))';

export type MatchDetailParticipant = ParticipantRow & { profile: { username: string } };
export type MatchDetailRow = Omit<MatchRow, 'participants'> & { participants: MatchDetailParticipant[] };

export function useSports() {
  return useQuery({
    queryKey: ['sports'],
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data, error } = await supabase.from('sports').select('id, name').order('name');
      if (error) throw error;
      return data;
    },
  });
}

export function useMatches() {
  return useQuery({
    queryKey: ['matches'],
    queryFn: async (): Promise<MatchRow[]> => {
      const { data, error } = await supabase
        .from('matches')
        .select(MATCH_SELECT)
        .order('played_at', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as unknown as MatchRow[];
    },
  });
}

export function useMatch(id: string) {
  return useQuery({
    queryKey: ['match', id],
    enabled: !!id,
    queryFn: async (): Promise<MatchDetailRow> => {
      const { data, error } = await supabase
        .from('matches')
        .select(MATCH_DETAIL_SELECT)
        .eq('id', id)
        .single();
      if (error) throw error;
      return data as unknown as MatchDetailRow;
    },
  });
}

export type LogMatchParticipant = {
  profile_id: string;
  side: Side | null;
  rank: number | null;
  score: number | null;
  stats: Record<string, number> | null;
};

export type LogMatchInput = {
  sportId: string;
  matchType: MatchType;
  format: MatchFormat;
  scoreA: number | null;
  scoreB: number | null;
  participants: LogMatchParticipant[];
};

export function useLogMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogMatchInput) => {
      const { error } = await supabase.rpc('log_match', {
        p_sport_id: input.sportId,
        p_match_type: input.matchType,
        p_format: input.format,
        p_score_a: input.scoreA,
        p_score_b: input.scoreB,
        p_participants: input.participants,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matches'] }),
  });
}
```

(Note: `useAuth` and `deriveOutcomes` imports are gone — the server owns identity and outcomes now.)

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit` → Expected: errors remaining ONLY in `app/(app)/log-match.tsx` (it still uses the old `LogMatchInput` shape — Task 6 rebuilds it). If `log-match.tsx` errors block the check, this is expected; note the exact remaining errors in your report.
Run: `npm test` → Expected: 25 passing.

```bash
git add lib/hooks/useMatches.ts
git commit -m "feat: match hooks for formats, detail query, and log_match RPC"
```

---

### Task 6: Log-match stepped flow

**Files:**
- Modify: `app/(app)/log-match.tsx` (full rewrite)

**Interfaces:**
- Consumes: `useSports`, `useLogMatch`, `LogMatchParticipant` (Task 5); `useFriends` (`data.friends: Profile[]`); `useAuth`; `getSport` (Task 4); `MatchFormat`, `MatchType`, `Side` (Task 3).
- Produces: the screen. No downstream code consumers.

- [ ] **Step 1: Rewrite `app/(app)/log-match.tsx`**

```tsx
import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { useFriends } from '../../lib/hooks/useFriends';
import { useLogMatch, useSports, type LogMatchParticipant } from '../../lib/hooks/useMatches';
import { getSport } from '../../lib/sports';
import type { MatchFormat, MatchType, Side } from '../../lib/types';

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

function SectionLabel({ children }: { children: string }) {
  return <Text className="font-semibold">{children}</Text>;
}

const FORMAT_LABELS: Record<MatchFormat, string> = { '1v1': '1 v 1', teams: 'Teams', ffa: 'Free-for-all' };

export default function LogMatch() {
  const { session } = useAuth();
  const myId = session!.user.id;
  const { data: sports } = useSports();
  const { data: friendData } = useFriends();
  const logMatch = useLogMatch();

  const [step, setStep] = useState(0);
  const [sportId, setSportId] = useState('');
  const [format, setFormat] = useState<MatchFormat>('1v1');
  const [sideA, setSideA] = useState<string[]>([myId]);
  const [sideB, setSideB] = useState<string[]>([]);
  const [ffaIds, setFfaIds] = useState<string[]>([myId]);
  const [ranks, setRanks] = useState<Record<string, string>>({});
  const [scoreA, setScoreA] = useState('');
  const [scoreB, setScoreB] = useState('');
  const [matchType, setMatchType] = useState<MatchType>('official');
  const [statsFor, setStatsFor] = useState<string | null>(null);
  const [statInputs, setStatInputs] = useState<Record<string, Record<string, string>>>({});

  const sport = sportId ? getSport(sportId) : undefined;
  const friends = friendData?.friends ?? [];
  const everyone = [{ id: myId, username: 'me' }, ...friends.map((f) => ({ id: f.id, username: f.username }))];
  const nameOf = (id: string) => everyone.find((e) => e.id === id)?.username ?? '?';
  const participants = format === 'ffa' ? ffaIds : [...sideA, ...sideB];

  function resetPlayers(nextFormat: MatchFormat) {
    setFormat(nextFormat);
    setSideA([myId]);
    setSideB([]);
    setFfaIds([myId]);
    setRanks({});
    setScoreA('');
    setScoreB('');
  }

  function toggleSide(id: string, side: Side) {
    const [mine, other, setMine, setOther] =
      side === 'a' ? [sideA, sideB, setSideA, setSideB] : [sideB, sideA, setSideB, setSideA];
    if (mine.includes(id)) setMine(mine.filter((x) => x !== id));
    else {
      setMine([...mine, id]);
      setOther(other.filter((x) => x !== id));
    }
  }

  function toggleFfa(id: string) {
    setFfaIds(ffaIds.includes(id) ? ffaIds.filter((x) => x !== id) : [...ffaIds, id]);
  }

  function stepValid(): string | null {
    switch (step) {
      case 0: return sportId ? null : 'Pick a sport';
      case 1: return null;
      case 2:
        if (format === '1v1') return sideA.length === 1 && sideB.length === 1 ? null : 'Pick exactly one opponent';
        if (format === 'teams') return sideA.length >= 1 && sideB.length >= 1 ? null : 'Both sides need players';
        return ffaIds.length >= 2 ? null : 'Pick at least 2 players';
      case 3:
        if (format === 'ffa') {
          const parsed = ffaIds.map((id) => Number(ranks[id]));
          if (parsed.some((r) => !Number.isInteger(r) || r < 1)) return 'Every player needs a rank (1 or higher)';
          if (Math.min(...parsed) !== 1) return 'Someone must be ranked 1st';
          return null;
        }
        const a = Number(scoreA), b = Number(scoreB);
        if (scoreA.trim() === '' || scoreB.trim() === '') return 'Enter both scores';
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return 'Scores must be whole numbers';
        return null;
      default: return null;
    }
  }

  function next() {
    const err = stepValid();
    if (err) { Alert.alert('Hold on', err); return; }
    // skip format step when the sport only supports 1v1
    if (step === 0 && sport && sport.formats.length === 1) { setFormat(sport.formats[0]); setStep(2); return; }
    setStep(step + 1);
  }

  function back() {
    if (step === 2 && sport && sport.formats.length === 1) { setStep(0); return; }
    setStep(step - 1);
  }

  function buildStats(id: string): Record<string, number> | null {
    const raw = statInputs[id];
    if (!raw) return null;
    const entries = Object.entries(raw).filter(([, v]) => v.trim() !== '');
    if (entries.length === 0) return null;
    return Object.fromEntries(entries.map(([k, v]) => [k, Number(v)]));
  }

  function onSubmit() {
    if (!sport) return;
    const parts: LogMatchParticipant[] =
      format === 'ffa'
        ? ffaIds.map((id) => ({ profile_id: id, side: null, rank: Number(ranks[id]), score: null, stats: buildStats(id) }))
        : [
            ...sideA.map((id) => ({ profile_id: id, side: 'a' as Side, rank: null, score: null, stats: buildStats(id) })),
            ...sideB.map((id) => ({ profile_id: id, side: 'b' as Side, rank: null, score: null, stats: buildStats(id) })),
          ];
    for (const p of parts) {
      if (p.stats) {
        const result = sport.statSchema.safeParse(p.stats);
        if (!result.success) {
          Alert.alert(`Invalid stats for ${nameOf(p.profile_id)}`, result.error.issues[0].message);
          return;
        }
      }
    }
    logMatch.mutate(
      {
        sportId, matchType, format,
        scoreA: format === 'ffa' ? null : Number(scoreA),
        scoreB: format === 'ffa' ? null : Number(scoreB),
        participants: parts,
      },
      {
        onSuccess: () => {
          setStep(0); setSportId(''); resetPlayers('1v1'); setStatInputs({}); setStatsFor(null);
          router.push('/');
        },
        onError: (e) => Alert.alert('Failed to log match', e.message),
      }
    );
  }

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16" contentContainerClassName="gap-4 pb-12">
      <Text className="text-2xl font-bold">Log a match</Text>
      <Text className="text-gray-400">Step {step + 1} of 5</Text>

      {step === 0 && (
        <>
          <SectionLabel>Sport</SectionLabel>
          <View className="flex-row flex-wrap gap-2">
            {(sports ?? []).map((s) => (
              <Chip key={s.id} label={s.name} selected={sportId === s.id}
                onPress={() => { setSportId(s.id); resetPlayers('1v1'); }} />
            ))}
          </View>
        </>
      )}

      {step === 1 && sport && (
        <>
          <SectionLabel>Format</SectionLabel>
          <View className="flex-row gap-2">
            {sport.formats.map((f) => (
              <Chip key={f} label={FORMAT_LABELS[f]} selected={format === f} onPress={() => resetPlayers(f)} />
            ))}
          </View>
        </>
      )}

      {step === 2 && format !== 'ffa' && (
        <>
          <SectionLabel>{format === '1v1' ? 'You (side A)' : 'Side A'}</SectionLabel>
          <View className="flex-row flex-wrap gap-2">
            {everyone.map((p) => (
              <Chip key={p.id} label={p.username} selected={sideA.includes(p.id)}
                onPress={() => toggleSide(p.id, 'a')} />
            ))}
          </View>
          <SectionLabel>{format === '1v1' ? 'Opponent (side B)' : 'Side B'}</SectionLabel>
          <View className="flex-row flex-wrap gap-2">
            {everyone.map((p) => (
              <Chip key={p.id} label={p.username} selected={sideB.includes(p.id)}
                onPress={() => toggleSide(p.id, 'b')} />
            ))}
          </View>
          {friends.length === 0 && <Text className="text-gray-400">Add a friend first</Text>}
        </>
      )}

      {step === 2 && format === 'ffa' && (
        <>
          <SectionLabel>Players</SectionLabel>
          <View className="flex-row flex-wrap gap-2">
            {everyone.map((p) => (
              <Chip key={p.id} label={p.username} selected={ffaIds.includes(p.id)} onPress={() => toggleFfa(p.id)} />
            ))}
          </View>
        </>
      )}

      {step === 3 && format !== 'ffa' && sport && (
        <>
          <SectionLabel>{`${sport.scoreLabel} — side A (${sideA.map(nameOf).join(', ')})`}</SectionLabel>
          <TextInput className="rounded-lg border border-gray-300 p-3" keyboardType="number-pad"
            value={scoreA} onChangeText={setScoreA} />
          <SectionLabel>{`${sport.scoreLabel} — side B (${sideB.map(nameOf).join(', ')})`}</SectionLabel>
          <TextInput className="rounded-lg border border-gray-300 p-3" keyboardType="number-pad"
            value={scoreB} onChangeText={setScoreB} />
        </>
      )}

      {step === 3 && format === 'ffa' && (
        <>
          <SectionLabel>Final ranking</SectionLabel>
          {ffaIds.map((id) => (
            <View key={id} className="flex-row items-center gap-3">
              <Text className="flex-1">{nameOf(id)}</Text>
              <TextInput className="w-16 rounded-lg border border-gray-300 p-2 text-center" keyboardType="number-pad"
                placeholder="#" value={ranks[id] ?? ''}
                onChangeText={(v) => setRanks({ ...ranks, [id]: v })} />
            </View>
          ))}
        </>
      )}

      {step === 4 && sport && (
        <>
          <SectionLabel>Type</SectionLabel>
          <View className="flex-row gap-2">
            <Chip label="Official" selected={matchType === 'official'} onPress={() => setMatchType('official')} />
            <Chip label="Friendly" selected={matchType === 'friendly'} onPress={() => setMatchType('friendly')} />
          </View>
          <SectionLabel>Player stats (optional)</SectionLabel>
          {participants.map((id) => (
            <View key={id} className="rounded-lg border border-gray-200">
              <Pressable className="flex-row justify-between p-3" onPress={() => setStatsFor(statsFor === id ? null : id)}>
                <Text className="font-semibold">{nameOf(id)}</Text>
                <Text className="text-emerald-700">{statsFor === id ? 'Hide' : 'Add stats'}</Text>
              </Pressable>
              {statsFor === id && (
                <View className="gap-2 border-t border-gray-200 p-3">
                  {sport.statFields.map((f) => (
                    <View key={f.key} className="flex-row items-center gap-3">
                      <Text className="flex-1 text-gray-700">{f.label}</Text>
                      <TextInput className="w-20 rounded-lg border border-gray-300 p-2 text-center"
                        keyboardType="numeric" value={statInputs[id]?.[f.key] ?? ''}
                        onChangeText={(v) =>
                          setStatInputs({ ...statInputs, [id]: { ...statInputs[id], [f.key]: v } })
                        } />
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
        </>
      )}

      <View className="mt-2 flex-row gap-3">
        {step > 0 && (
          <Pressable className="flex-1 rounded-lg border border-emerald-600 p-4" onPress={back}>
            <Text className="text-center font-semibold text-emerald-700">Back</Text>
          </Pressable>
        )}
        {step < 4 ? (
          <Pressable className="flex-1 rounded-lg bg-emerald-600 p-4" onPress={next}>
            <Text className="text-center font-semibold text-white">Next</Text>
          </Pressable>
        ) : (
          <Pressable className="flex-1 rounded-lg bg-emerald-600 p-4" disabled={logMatch.isPending} onPress={onSubmit}>
            <Text className="text-center font-semibold text-white">
              {logMatch.isPending ? 'Saving…' : 'Save match'}
            </Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → Expected: **clean** (this was the last file on the old shapes).
Run: `npm test` → Expected: 25 passing.
Boot check: `npx expo start --ios` (background), wait for build, `xcrun simctl io booted screenshot /tmp/m2-task6.png`, Read the screenshot — app reaches sign-in with no red screen. Kill the server.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/log-match.tsx"
git commit -m "feat: stepped log-match flow with formats, rosters, ranks, and stat entry"
```

---

### Task 7: Match detail screen + tappable match rows

**Files:**
- Create: `app/(app)/match/[id].tsx`
- Modify: `app/(app)/_layout.tsx` (hide the new route from the tab bar)
- Modify: `app/(app)/index.tsx` (recent-match rows link to detail, show summary)
- Modify: `app/(app)/profile/[id].tsx` (add head-to-head match list with links)

**Interfaces:**
- Consumes: `useMatch`, `MatchDetailRow`, `MatchDetailParticipant`, `useMatches` (Task 5); `matchSummary` (Task 3); `getSport` (Task 4); `computeRecord`, `filterHeadToHead`; `useAuth`, `useProfile`.
- Produces: the finished milestone. No downstream consumers.

- [ ] **Step 1: Hide the route — in `app/(app)/_layout.tsx`**, add inside `<Tabs>` after the `profile/[id]` screen:

```tsx
      <Tabs.Screen name="match/[id]" options={{ href: null }} />
```

- [ ] **Step 2: Create `app/(app)/match/[id].tsx`**

```tsx
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useMatch, type MatchDetailParticipant } from '../../../lib/hooks/useMatches';
import { getSport } from '../../../lib/sports';

function StatTable({ participants, sportId }: { participants: MatchDetailParticipant[]; sportId: string }) {
  const sport = getSport(sportId);
  if (!sport) return null;
  const fields = sport.statFields.filter((f) => participants.some((p) => p.stats?.[f.key] != null));
  const derived = sport.derivedStats.filter((d) => participants.some((p) => p.stats && d.compute(p.stats) != null));
  if (fields.length === 0 && derived.length === 0) {
    return <Text className="text-gray-400">No stats recorded</Text>;
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        <View className="flex-row border-b border-gray-200 pb-1">
          <Text className="w-24 font-semibold text-gray-500">Player</Text>
          {fields.map((f) => (
            <Text key={f.key} className="w-14 text-center font-semibold text-gray-500">{f.shortLabel}</Text>
          ))}
          {derived.map((d) => (
            <Text key={d.key} className="w-14 text-center font-semibold text-emerald-700">{d.shortLabel}</Text>
          ))}
        </View>
        {participants.map((p) => (
          <View key={p.profile_id} className="flex-row border-b border-gray-100 py-1">
            <Text className="w-24" numberOfLines={1}>{p.profile.username}</Text>
            {fields.map((f) => (
              <Text key={f.key} className="w-14 text-center">
                {p.stats?.[f.key] != null ? String(p.stats[f.key]) : '–'}
              </Text>
            ))}
            {derived.map((d) => {
              const v = p.stats ? d.compute(p.stats) : null;
              return (
                <Text key={d.key} className="w-14 text-center text-emerald-700">
                  {v != null ? v.toFixed(d.decimals) : '–'}
                </Text>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export default function MatchDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: match, isLoading } = useMatch(id ?? '');

  if (isLoading) return <View className="flex-1 bg-white" />;
  if (!match) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Text className="text-gray-400">Match not found</Text>
      </View>
    );
  }

  const sport = getSport(match.sport_id);
  const sideA = match.participants.filter((p) => p.side === 'a');
  const sideB = match.participants.filter((p) => p.side === 'b');
  const ranked = [...match.participants].sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
  const aWon = match.score_a != null && match.score_b != null && match.score_a > match.score_b;
  const bWon = match.score_a != null && match.score_b != null && match.score_b > match.score_a;

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16" contentContainerClassName="gap-4 pb-12">
      <Text className="text-2xl font-bold">{sport?.name ?? match.sport_id}</Text>
      <View className="flex-row items-center gap-2">
        <Text className="text-gray-500">{match.played_at}</Text>
        <View className={`rounded-full px-2 py-0.5 ${match.match_type === 'official' ? 'bg-emerald-100' : 'bg-amber-100'}`}>
          <Text className={match.match_type === 'official' ? 'text-emerald-700' : 'text-amber-700'}>
            {match.match_type}
          </Text>
        </View>
        <Text className="text-gray-400">{match.format === 'ffa' ? 'free-for-all' : match.format}</Text>
      </View>

      {match.format !== 'ffa' ? (
        <>
          <View className="flex-row items-center justify-between rounded-xl border border-gray-200 p-4">
            <View className="flex-1">
              <Text className={`text-lg ${aWon ? 'font-bold text-emerald-700' : ''}`} numberOfLines={2}>
                {sideA.map((p) => p.profile.username).join(', ')}
              </Text>
            </View>
            <Text className="px-3 text-2xl font-bold">
              {match.score_a} – {match.score_b}
            </Text>
            <View className="flex-1">
              <Text className={`text-right text-lg ${bWon ? 'font-bold text-emerald-700' : ''}`} numberOfLines={2}>
                {sideB.map((p) => p.profile.username).join(', ')}
              </Text>
            </View>
          </View>
          <Text className="font-semibold">Stats</Text>
          <StatTable participants={[...sideA, ...sideB]} sportId={match.sport_id} />
        </>
      ) : (
        <>
          <Text className="font-semibold">Final ranking</Text>
          {ranked.map((p) => (
            <View key={p.profile_id} className="flex-row justify-between rounded-lg border border-gray-200 p-3">
              <Text className={p.rank === 1 ? 'font-bold text-emerald-700' : ''}>
                #{p.rank} {p.profile.username}
              </Text>
              {p.score != null && <Text className="text-gray-500">{p.score} pts</Text>}
            </View>
          ))}
          <Text className="font-semibold">Stats</Text>
          <StatTable participants={ranked} sportId={match.sport_id} />
        </>
      )}
    </ScrollView>
  );
}
```

- [ ] **Step 3: Make home rows tappable — in `app/(app)/index.tsx`**, add imports:

```tsx
import { Link } from 'expo-router';
import { matchSummary } from '../../lib/matchSummary';
```

Replace the `renderItem` in the Recent matches `FlatList` with:

```tsx
        renderItem={({ item }) => {
          const me = item.participants.find((p) => p.profile_id === myId);
          return (
            <Link href={`/match/${item.id}`} asChild>
              <Pressable className="flex-row items-center justify-between rounded-lg border border-gray-200 p-3">
                <View>
                  <Text className="capitalize">{item.sport_id.replace('_', ' ')}</Text>
                  <Text className="text-xs text-gray-400">
                    {item.format === 'ffa' ? 'free-for-all' : item.format} · {item.match_type}
                  </Text>
                </View>
                <View className="items-end">
                  <Text className={me?.outcome === 'win' ? 'text-emerald-600' : me?.outcome === 'loss' ? 'text-red-500' : 'text-gray-500'}>
                    {me?.outcome ?? '?'}
                  </Text>
                  <Text className="text-gray-500">{matchSummary(item, myId)}</Text>
                </View>
              </Pressable>
            </Link>
          );
        }}
```

- [ ] **Step 4: Head-to-head list on the friend profile — replace `app/(app)/profile/[id].tsx`**

```tsx
import { FlatList, Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../lib/auth';
import { useProfile } from '../../../lib/hooks/useProfile';
import { useMatches } from '../../../lib/hooks/useMatches';
import { computeRecord, filterHeadToHead } from '../../../lib/records';
import { matchSummary } from '../../../lib/matchSummary';
import { RecordList } from '../index';

export default function FriendProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const myId = session!.user.id;
  const { data: profile } = useProfile(id);
  const { data: matches } = useMatches();

  const headToHead = filterHeadToHead(matches ?? [], myId, id);
  const theirRecordVsMe = computeRecord(headToHead, id);

  return (
    <View className="flex-1 gap-4 bg-white p-6 pt-16">
      <Text className="text-2xl font-bold">{profile?.username ?? '…'}</Text>
      <Text className="font-semibold">Their record vs you</Text>
      <RecordList records={theirRecordVsMe} />
      <Text className="font-semibold">Matches together</Text>
      <FlatList
        data={headToHead}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <Link href={`/match/${item.id}`} asChild>
            <Pressable className="flex-row items-center justify-between rounded-lg border border-gray-200 p-3">
              <View>
                <Text className="capitalize">{item.sport_id.replace('_', ' ')}</Text>
                <Text className="text-xs text-gray-400">{item.played_at} · {item.match_type}</Text>
              </View>
              <Text className="text-gray-500">{matchSummary(item, myId)}</Text>
            </Pressable>
          </Link>
        )}
        ListEmptyComponent={<Text className="text-gray-400">No sided matches together yet</Text>}
      />
    </View>
  );
}
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` → Expected: clean.
Run: `npm test` → Expected: 25 passing.
Boot check: `npx expo start --ios` (background), screenshot, confirm sign-in renders with no red screen; kill the server.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/match" "app/(app)/_layout.tsx" "app/(app)/index.tsx" "app/(app)/profile/[id].tsx"
git commit -m "feat: match detail screen with per-sport stat tables and tappable match rows"
```

---

### Task 8: Close out the milestone

**Files:**
- Modify: `CLAUDE.md` (Status section)

**Interfaces:**
- Consumes: everything prior.
- Produces: truthful status for future sessions.

- [ ] **Step 1: Update `CLAUDE.md` §5 Status**

Rewrite the Status section to state: M2 (stats, formats, match detail) built on branch `m2-stats-formats` — matches support 1v1/teams/FFA with per-sport stats via `lib/sports/` registry; all match writes go through the SECURITY DEFINER `log_match` RPC (client insert policies dropped, outcomes server-derived); friendships hardened (immutability trigger + canonical-pair index); match detail screen live. Note which v1 deferred findings this closes (orphaned insert, outcome spoofing, friendship immutability, reverse duplicates) and which remain (empty-score-coerces-to-0 UX, accept-mutation onError, template cruft). Keep the M3 (live scoring) / M4 (tournaments) roadmap note. Do not delete the test-account and backend lines.

- [ ] **Step 2: Full sweep**

Run: `npx tsc --noEmit && npm test` → Expected: clean, 25 passing.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record milestone 2 completion"
```

---

## Controller-only steps (not implementer tasks)

After Task 2: apply migrations 0004 + 0005 to the dev project (`supabase db push`), then verify: `log_match` exists and is `SECURITY DEFINER`; direct `insert into matches` as a user JWT is rejected; backfilled rows have sides and side scores. After Task 7: run the extended data-layer E2E (teams match via RPC, FFA match via RPC, server-derived outcomes, stats round-trip, creator-not-participant rejected, reverse-duplicate friendship rejected, addressee tamper-update rejected). Then hand Suryansh the simulator walkthrough script from the spec (§7) and, after his sign-off, merge `m2-stats-formats` → `main` and push.
