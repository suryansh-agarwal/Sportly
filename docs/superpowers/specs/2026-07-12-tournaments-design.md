# Sportly Milestone 4: Tournament Mode

**Date:** 2026-07-12
**Status:** Approved design
**Builds on:** M1–M3 (merged to `main`). Vision: `CLAUDE.md` §2 (tournament mode).

## Goal

Any user creates a tournament for a sport, fills it with friends and link-joiners, and the app runs it: server-generated fixtures, standings or bracket, results recorded as real matches that feed records, a champion at the end.

## Decisions Made (with the user — do not reopen)

- **Entrants:** individuals only; every fixture is a **1v1 match** in the tournament's sport. Doubles/team tournaments come after persistent teams/groups exist.
- **Results:** a fixture resolves by linking a real match — either logged post-hoc or (racquet sports) live-scored via M3. Tournament matches are **official** and feed records like any match.
- **Joining:** creator invites friends (accept/decline) **and** a shareable join link (token) lets any authenticated app user join while the tournament is in draft.
- **Formats:** round robin (single cycle, 3/1/0 points) and knockout (single elimination, random seeding, byes for non-powers-of-2). Draws allowed in RR fixtures; rejected in KO fixtures.
- **Fixture generation runs server-side in a plpgsql RPC** (not an Edge Function — same trusted-write pattern as `log_match`/`finish_live_match`; revisit Edge Functions when push notifications need one).

## 1. Schema — migration `0007_tournaments.sql`

```sql
create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  sport_id text not null references public.sports(id),
  format text not null check (format in ('round_robin', 'knockout')),
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'cancelled')),
  created_by uuid not null references public.profiles(id),
  join_token text not null unique default encode(gen_random_bytes(9), 'base64url'),
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
  position integer not null check (position >= 1),   -- slot within the round (bracket math: winner of (r,p) feeds (r+1, ceil(p/2)))
  player_a uuid references public.profiles(id),      -- null = TBD (knockout future round)
  player_b uuid references public.profiles(id),      -- null = TBD or bye (bye fixtures are auto-resolved at generation)
  status text not null default 'pending' check (status in ('pending', 'done')),
  match_id uuid references public.matches(id),
  winner_id uuid references public.profiles(id),     -- null for RR draws
  created_at timestamptz not null default now(),
  unique (tournament_id, round, position)
);
```

### RLS

- Read on all three tables: tournament members (any `tournament_players` row regardless of status) — SECURITY DEFINER helper `is_tournament_member(tournament_id)`. Join-token preview goes through an RPC (below), not a select policy, so the token never grants standing read access.
- No client writes on any table — the lifecycle is entirely RPC-shaped.

### RPCs (all SECURITY DEFINER, `search_path = public, pg_temp`, `authenticated` only)

- `create_tournament(p_name, p_sport_id, p_format) returns uuid` — creates draft, adds creator as accepted player. (Client reads the join token back via its member select.)
- `invite_to_tournament(p_tournament_id, p_profile_id)` — creator only, draft only, invitee must have an accepted friendship with the creator.
- `respond_to_invite(p_tournament_id, p_accept boolean)` — invitee flips own row to accepted/declined; draft only.
- `preview_tournament_by_token(p_token) returns jsonb` — name, sport, format, creator username, player count; any authenticated user; no membership required.
- `join_by_token(p_token)` — draft only; inserts caller as accepted (idempotent if already a member: flips invited→accepted, no-ops if accepted).
- `start_tournament(p_tournament_id)` — creator only, draft only; requires ≥3 accepted players for round_robin, ≥2 for knockout; declined/invited rows are dropped from play (rows kept for history). Generates fixtures and sets status `active`:
  - **Round robin:** circle method — n players (odd n gets a phantom bye slot), n-1 rounds (n rounds if odd), every pair exactly once; fixtures where one side is the phantom are simply not created. Total fixtures = n(n-1)/2.
  - **Knockout:** bracket size = next power of 2; random seeding (`order by random()`); byes fill from the top of the draw; round-1 fixtures with a bye are created as `done` with the present player as `winner_id` and no match link; each resolved pair auto-creates its round-2 slot when both feeders are done (same rule as normal advancement).
- `record_fixture_result(p_fixture_id, p_match_id)` — caller is one of the fixture's players; fixture pending, tournament active. Validates the linked match: exists and caller can read it, same sport, format `1v1`, its two participants are exactly the fixture's two players, `match_type = 'official'`. Derives the fixture winner from the match's participant outcomes; **knockout rejects draws** (`racquet` sports cannot draw anyway; football/basketball 1v1 can — the error tells the user to replay/log a decisive match). Marks fixture done; **knockout advancement:** writes the winner into the next round's fixture (creating it when the counterpart feeder is also done, per the position math above); final resolved → tournament `completed` + `winner_id`. **Round robin completion:** when all fixtures are done, status `completed` and `winner_id` = standings leader (points, then head-to-head result between tied pair, then total score difference across tournament matches, then earliest join — deterministic server-side; the same ordering is mirrored in TS for display).
- `cancel_tournament(p_tournament_id)` — creator only, draft or active; status `cancelled`. Recorded matches remain (they're real matches); pending fixtures die with the tournament.

One deliberate consequence: the same real match could theoretically be linked to only one fixture (`record_fixture_result` rejects a `p_match_id` already linked to any fixture — uniqueness enforced by partial unique index on `fixtures(match_id) where match_id is not null`).

## 2. Pure logic — `lib/tournaments/`

```
lib/tournaments/
  standings.ts       # computeStandings(fixtures, matchesById, playerIds): StandingsRow[]
  standings.test.ts  #   points 3/1/0, tiebreaks: head-to-head, score diff, join order
  bracket.ts         # bracketRounds(fixtures): Round[] — groups by round, orders by position, marks byes/TBD
  bracket.test.ts
```

Both are display-side mirrors; the server's completion logic is authoritative. Types exported: `StandingsRow = { profileId, played, wins, draws, losses, points, scoreDiff }`, `BracketSlot`, `Round`.

## 3. Hooks — `lib/hooks/useTournaments.ts`

`useTournaments()` (`['tournaments']` — my tournaments + pending invites, split like `useFriends`), `useTournament(id)` (`['tournament', id]` — row + players + fixtures with usernames), `useCreateTournament`, `useInvite`, `useRespondToInvite`, `usePreviewByToken(token)`, `useJoinByToken`, `useStartTournament`, `useRecordFixtureResult`, `useCancelTournament`. Mutations invalidate `['tournament', id]` and `['tournaments']`; recording a result also invalidates `['matches']`.

## 4. Screens

- **New 4th tab `app/(app)/tournaments.tsx`:** pending invites (accept/decline), my tournaments list (status badge), Create button → inline stepped flow (name → sport → format → done; invite + share from the detail screen).
- **`app/(app)/tournament/[id].tsx`** (hidden route): header (name, sport, format, status); draft: player list with invite-friend chips, share-link button (`Share.share` with the deep link — v1 shares the raw app-scheme URL `sportly://join/<token>` since no website exists yet; a universal https link is future work), Start button (creator, with count guard); active/completed: **standings table** (RR) or **bracket columns** (KO) from the pure modules; fixtures list — mine highlighted with two actions: **Log result** (pushes log-match prefilled: sport, 1v1, opponent locked, official; on success calls `record_fixture_result`) and **Score live** for racquet sports (starts an M3 live match; on finish, `record_fixture_result` with the finished match id); completed: champion banner.
- **`app/(app)/join/[token].tsx`** (hidden route, deep-link target `sportly://join/<token>` + the share URL): preview card via `usePreviewByToken` → Join button → navigates to the tournament.
- **Prefill mechanics:** log-match accepts optional route params (`fixtureId`, locked sport/opponent); the live screen's finish handler and log-match's success handler call `record_fixture_result` when `fixtureId` is present. This is the only change to existing screens.

## 5. Testing & Verification

- Vitest: standings math incl. every tiebreak level; bracket rounds/byes/TBD display; plus a generation-mirror test asserting RR pairing properties (n(n-1)/2 fixtures, all pairs unique, everyone plays everyone) against fixture sets shaped like the RPC's output.
- Controller E2E: full RR lifecycle (create → invite → accept → token-join a third player → start → n(n-1)/2 fixtures exist → record results via real logged matches → completion + correct winner) and KO lifecycle (byes auto-resolved, advancement, draw rejected, final → champion); negatives: non-creator start rejected, non-player record rejected, wrong-players match rejected, double-link rejected, stranger reads nothing, token preview works for stranger, join after start rejected.
- Simulator walkthrough for Suryansh (create a 4-player table tennis knockout, live-score a semifinal, watch the bracket fill).

## Out of Scope (do not build)

Doubles/team tournaments; groups & pickup requests (M5, with push); multi-stage formats (groups → knockout); seeding by rating; schedule/dates for fixtures; spectator push notifications; Edge Functions; design polish.
