# Sportly Milestone 3: Live Scoring (Racquet Family)

**Date:** 2026-07-10
**Status:** Approved design
**Builds on:** M2 (merged to `main`): match formats, `log_match` RPC, `lib/sports/` registry. Stack spec: `2026-07-07-tech-stack-design.md`. Vision: `CLAUDE.md` §2 (live scoring).

## Goal

Score a racquet match point-by-point as it happens, from any participant's phone, with friends watching live — and have the finished match land in the official record through the existing trusted write path.

## Decisions Made (with the user — do not reopen)

- **Engine scope v1:** the racquet family only — tennis, padel, badminton, pickleball, table_tennis — via one configurable engine. Football/basketball/cricket keep post-match logging (cricket's ball-by-ball engine is its own future milestone).
- **Multiple scorers:** any participant can input points. Resolved architecturally by an **append-only event log in Postgres** — server-assigned ordering makes concurrent taps safe; no last-write-wins state.
- **Spectating:** any accepted friend of any participant can watch live. No separate referee role in v1.
- **Trust model:** unchanged from M2. Client folds events into a final score and the finish RPC logs it — no new spoofing surface, since manual logging already accepts arbitrary scores. Event-log consistency enforcement is deferred to whenever ratings need it.
- Serve tracking, post-match stat appending, non-racquet engines, tournament integration: **deferred**.

## 1. Scoring Engine — `lib/scoring/` (pure TS, no RN/Supabase imports)

```
lib/scoring/
  types.ts        # RacquetConfig, ScoreEvent, ScoreState
  engine.ts       # foldEvents(config, events): ScoreState  (+ single-step reduce)
  engine.test.ts  # the heaviest test file in the repo — see Testing
  configs.ts      # SCORING_CONFIGS: Record<sportId, RacquetConfig> for the 5 sports
```

### Rule variants (one reducer, discriminated config)

- **`tennis` variant** (tennis, padel): point sequence 0/15/30/40, deuce → advantage → game (win-by-2 at deuce); sets of 6 games win-by-2; **tiebreak at 6–6** (first to 7, win-by-2, counts as 7–6); match = best of 3 sets.
- **`rally` variant** (badminton: to 21, win-by-2, hard cap 30, best of 3; table_tennis: to 11, win-by-2, best of 5; pickleball: to 11, win-by-2, best of 3 — rally scoring, not side-out).

### API

```ts
type ScoreEvent = { id: number; type: 'point' | 'undo'; side: 'a' | 'b' | null };
// undo cancels the most recent not-yet-cancelled point event; undo with nothing to cancel is a no-op.

type ScoreState = {
  points: { a: string; b: string };      // current-game/current-rally display: "40", "Ad", "6" (tiebreak points), "15"
  units: { a: number; b: number }[];     // one entry per set (tennis variant: games in that set) or per game (rally variant: final points of completed games; current game's running points for the last entry)
  setsWon: { a: number; b: number };     // completed sets (tennis variant) / completed games (rally variant) — maps to score_a/score_b at finish
  inTiebreak: boolean;
  isComplete: boolean;
  winner: 'a' | 'b' | null;
};

foldEvents(config: RacquetConfig, events: ScoreEvent[]): ScoreState
```

Deterministic fold: any device replaying the same event list reaches the same state. Points awarded after `isComplete` are ignored by the fold (defensive; the UI also disables input).

Final side scores for logging: `setsWon` maps to the match's `score_a`/`score_b` (consistent with M2's scoreLabel: Sets for tennis/padel, Games for the rally sports).

## 2. Schema — migration `0006_live_scoring.sql`

```sql
create table public.live_matches (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id),
  match_type text not null check (match_type in ('official', 'friendly')),
  format text not null check (format in ('1v1', 'teams')),   -- no ffa in racquet live scoring
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
  id bigint generated always as identity primary key,   -- authoritative order
  live_match_id uuid not null references public.live_matches(id) on delete cascade,
  event_type text not null check (event_type in ('point', 'undo')),
  side text check (side in ('a', 'b')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check ((event_type = 'point') = (side is not null))
);
```

### RLS

- Helper `is_live_participant(live_match_id)` — SECURITY DEFINER, `search_path` set (mirrors `is_match_participant`).
- Helper `is_friend_of_live_participant(live_match_id)` — SECURITY DEFINER: exists an `accepted` friendship between `auth.uid()` and any participant.
- **Select** on all three tables: participant OR friend-of-participant.
- **Insert on `live_events`:** participant AND the parent match `status = 'live'`. Direct inserts allowed (no RPC per point — one tap = one insert; RLS is sufficient because events carry no outcome authority).
- **No client insert/update on `live_matches`/`live_participants`** — lifecycle goes through RPCs only.

### RPCs (SECURITY DEFINER, `search_path = public, pg_temp`, granted to `authenticated` only)

- `start_live_match(p_sport_id, p_match_type, p_format, p_participants jsonb) returns uuid` — validates: racquet sport (one of the 5), creator among participants, 1v1 exactly one per side / teams ≥1 per side, distinct profiles; inserts `live_matches` + `live_participants` atomically.
- `finish_live_match(p_live_match_id, p_score_a, p_score_b) returns uuid` — caller is participant; match is `'live'`; scores non-negative, not equal (racquet matches can't draw). Marks `completed`, inserts the real match + participants with server-derived outcomes (same logic as `log_match`; stats null; participant `score` null), sets `finished_match_id`, all in one transaction. Returns the new match id.
- `abandon_live_match(p_live_match_id)` — caller is participant; match is `'live'`; marks `abandoned`. Nothing is logged.

### Realtime

`alter publication supabase_realtime add table public.live_events, public.live_matches;` — clients subscribe to `postgres_changes` (INSERT on `live_events`, UPDATE on `live_matches` for status flips), which respects RLS.

## 3. Hooks — `lib/hooks/useLive.ts`

- `useLiveMatch(id)` — one query (`['live', id]`): match row + participants (+usernames) + all events; then a Realtime channel: new `live_events` INSERTs append into the query cache (incremental fold), `live_matches` UPDATE invalidates. Unsubscribes on unmount.
- `useLiveMatches()` — `['live-list']`: rows with `status = 'live'` visible to me (RLS does the filtering), for the home strip.
- `useStartLiveMatch()`, `useFinishLiveMatch()`, `useAbandonLiveMatch()` — RPC mutations. Finish invalidates `['matches']` and `['live-list']`.
- `useAwardPoint(liveMatchId)` / `useUndoPoint(liveMatchId)` — direct inserts into `live_events` with optimistic append into `['live', id]` (rolled back on error; the Realtime echo is deduped by event id).

## 4. Screens

- **Start flow:** on the existing Log Match screen, when the chosen sport is one of the 5 racquet sports and format is 1v1/teams, the players step offers two actions: **"Score live"** (calls `start_live_match`, navigates to the live screen — skips the scores/stats steps) and the existing "Next" post-match path. No new route for setup.
- **Live screen `app/(app)/live/[id].tsx`** (hidden from tab bar): scoreboard — sets row, current-set games, big current-game points ("40 – Ad", tiebreak shown as raw points); two giant tap zones (side A / side B) to award the point — rendered only for participants; Undo button; **Finish** button appears when `isComplete` (calls finish RPC, navigates to the logged match's detail screen); **Abandon** behind a confirm alert. Spectators see the same scoreboard read-only with a "LIVE" pill. `status != 'live'` renders a terminal state (link to the match detail if completed).
- **Home:** an "In progress" horizontal strip above Recent matches listing `useLiveMatches()` rows (sport, sides, LIVE pill) — tap to open the live screen. Hidden when empty.

## 5. Testing & Verification

- **Engine (Vitest, exhaustive):** tennis deuce/advantage cycles; game win-by-2; set to 6 win-by-2; tiebreak entry at 6–6, win-by-2 inside tiebreak, 7–6 set result; best-of-3 completion; rally variant: to-11/to-21 win-by-2, badminton's 30-point cap, best-of-5 for table tennis; undo across boundaries (undo a set-winning point restores the set); undo-at-zero no-op; points-after-complete ignored; determinism (fold = incremental reduce).
- Config table test: all 5 sports have configs; config sport ids ⊂ SPORTS registry ids.
- tsc clean; whole suite green.
- **Controller E2E (live dev project):** start a live tennis match as alice; award points as alice AND bob (multi-scorer); verify a friend can read events but a stranger cannot; verify non-participant cannot insert events; play a fold-verified quick match to completion; finish → real match row exists with correct server-derived outcomes and `finished_match_id` link; abandon path logs nothing; direct insert/update on `live_matches` rejected.
- **Simulator walkthrough (Suryansh):** two simulators or phone+simulator — score from both devices simultaneously, watch the other update in ~1s; finish and see it in records.

## Out of Scope (do not build)

Cricket/football/basketball live engines; serve tracking/indicators; side-out pickleball scoring; post-match stat appending; spectator reactions/chat; tournament integration; push notifications ("friend went live"); design polish beyond the utilitarian slice style.
