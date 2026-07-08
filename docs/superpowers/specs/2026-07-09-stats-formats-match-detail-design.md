# Sportly Milestone 2: Per-Sport Stats, Match Formats & Match Detail

**Date:** 2026-07-09
**Status:** Approved design
**Builds on:** vertical slice v1 (merged to `main`). Stack spec: `2026-07-07-tech-stack-design.md`. Vision: `CLAUDE.md`.

## Goal

Turn the slice's bare "winner + score" match into the full matchday document the vision demands: matches support **1v1, teams, and free-for-all**; every participant can carry **sport-native stats**; any match can be **tapped open into a detail screen**. Also closes the deferred data-integrity findings from the v1 final review (atomic writes, server-derived outcomes, friendship hardening).

Decomposition context: Milestone 2 of the post-slice roadmap. Live scoring (M3) and tournament mode (M4) build on this milestone's sport definitions and match formats. Groups/rosters and ratings remain later milestones.

## Decisions Made (with the user, do not reopen)

- **Match shapes:** 1v1, teams (side A vs side B, any size), free-for-all (ranked individuals). All in this milestone.
- **Record math:** 1v1/teams — your side's result is your result; head-to-head counts against every opponent on the opposing side. FFA — rank 1 gets a W (ties at rank 1 share it), everyone else gets an L; FFA affects overall records only, **never head-to-head**.
- **Stat depth:** full per-player stat sheets, all fields optional (quick logging stays quick).
- **Architecture:** Option A + light C — TypeScript sport registry (`lib/sports/`) with Zod schemas as the single source of truth; DB guards only that `stats` is a JSON object. Full server-side stat validation deferred until stats feed ratings.
- **Derived stats (economy, strike rate, PPG) are computed at display time from raw stored fields — never stored.**
- **Outcomes are derived server-side** in an atomic `log_match` RPC. The client never writes `outcome`.

## 1. Schema — migration `0004_match_formats_stats.sql`

```sql
-- matches: format + side scores
alter table public.matches
  add column format text not null default '1v1' check (format in ('1v1', 'teams', 'ffa')),
  add column score_a integer check (score_a >= 0),
  add column score_b integer check (score_b >= 0);

-- participants: side, rank, stats
alter table public.match_participants
  add column side text check (side in ('a', 'b')),
  add column rank integer check (rank >= 1),
  add column stats jsonb check (stats is null or jsonb_typeof(stats) = 'object');
```

Backfill existing 1v1 data in the same migration: participant with `profile_id = matches.created_by` → `side = 'a'` (other → `'b'`); `score_a`/`score_b` copied from the respective participant `score` columns. `match_participants.score` becomes nullable and **FFA-only from this milestone on**: the RPC writes it only for FFA participants (their individual points); for 1v1/teams it writes null and all reads use `score_a`/`score_b`. Old rows keep their historical values; no screen reads participant `score` for sided matches after this milestone.

Shape rules (enforced in the RPC, not as cross-table CHECKs): 1v1 → exactly 2 participants, one per side, both side scores present; teams → ≥1 participant per side, both side scores present, ranks null; ffa → ≥2 participants, every participant has a rank ≥1, sides and side scores null.

## 2. Atomic write path — `log_match` RPC (same migration)

`log_match(p_sport_id text, p_match_type text, p_format text, p_score_a int, p_score_b int, p_participants jsonb) returns uuid`

- Plain `language plpgsql`, **invoker rights** (no SECURITY DEFINER) so all existing RLS policies still gate the inserts; `set search_path = public, pg_temp`.
- `p_participants`: array of `{ profile_id, side, rank, score, stats }`.
- Validates shape rules above; **requires `auth.uid()` to be among the participants** (creator-must-play, closes review finding); inserts match + all participants in one transaction (closes orphaned-match finding).
- Derives outcomes server-side (closes outcome-spoofing finding): 1v1/teams — higher side score wins, equal draws, applied to every member of the side; ffa — `rank = 1` → win (shared on ties), else loss.
- Client insert policies on `matches`/`match_participants` are **dropped** in this migration; the RPC becomes the only write path for match data. Select policies unchanged.

`useLogMatch` becomes one `supabase.rpc('log_match', ...)` call.

## 3. Hardening — migration `0005_friendship_hardening.sql`

Closes the remaining v1 review findings:

- **Immutability trigger:** a `before update on public.friendships` trigger raising an exception when `NEW.requester_id <> OLD.requester_id` or `NEW.addressee_id <> OLD.addressee_id` (and when `OLD.status = 'accepted' and NEW.status <> 'accepted'` — accepted friendships can't be silently un-accepted; unfriending is a future delete flow, not an update). Plain `language plpgsql`, no SECURITY DEFINER, `set search_path = public, pg_temp`.
- **Canonical-pair uniqueness:** `create unique index friendships_canonical_pair on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));` — one friendship row per pair regardless of direction. The migration first deletes reverse-duplicate rows (keep the older `created_at`) so the index can build on existing dev data.

## 4. Sport definitions — `lib/sports/`

```
lib/sports/
  types.ts      # SportDefinition, StatField
  cricket.ts    # one file per sport
  football.ts
  basketball.ts
  tennis.ts
  padel.ts
  pickleball.ts
  table_tennis.ts
  badminton.ts
  index.ts      # SPORTS registry: Record<sportId, SportDefinition>, getSport(id)
  derived.ts    # derived-stat calculators (economy, strike rate, ...) + tests
```

```ts
// types.ts
export type StatField = {
  key: string;            // jsonb key, snake_case
  label: string;          // "Balls faced"
  shortLabel: string;     // "BF" (match-detail table header)
  max?: number;           // sanity cap for entry validation
};

export type DerivedStat = {
  key: string; label: string; shortLabel: string; decimals: number;
  compute: (stats: Record<string, number>) => number | null; // null = inputs missing
};

export type SportDefinition = {
  id: string;
  name: string;
  formats: ReadonlyArray<'1v1' | 'teams' | 'ffa'>;
  scoreLabel: string;               // "Goals" | "Runs" | "Points" | "Sets"
  statSchema: z.ZodObject<...>;     // all fields z.number().int().min(0).optional() (or .multipleOf for overs)
  statFields: StatField[];          // entry + display order
  derivedStats: DerivedStat[];      // display-only
};
```

Per-sport content (all fields optional integers ≥ 0 unless noted):

| Sport | formats | scoreLabel | statFields | derivedStats |
|---|---|---|---|---|
| cricket | 1v1, teams | Runs | runs, balls_faced, fours, sixes, overs_bowled (0.1 steps), runs_conceded, wickets, catches | strike_rate (runs/balls×100, 1dp), economy (runs_conceded/overs, 2dp) |
| football | 1v1, teams | Goals | goals, assists, saves, yellow_cards, red_cards | — |
| basketball | 1v1, teams, ffa | Points | points, rebounds, assists, steals, blocks, three_pointers | — |
| tennis | 1v1, teams | Sets | games_won, aces, double_faults, winners, unforced_errors | — |
| padel | 1v1, teams | Sets | games_won, winners, unforced_errors, smashes | — |
| pickleball | 1v1, teams | Games | points_won, aces, faults | — |
| table_tennis | 1v1, teams, ffa | Games | points_won, aces, serve_faults | — |
| badminton | 1v1, teams | Games | points_won, aces, smash_winners | — |

(“teams” covers doubles for racquet sports. Exact field lists are the spec; adding/renaming later is a one-file change.)

## 5. Pure logic updates — `lib/`

- `lib/types.ts`: `MatchRow` gains `format`, `score_a`, `score_b`; `ParticipantRow` gains `side`, `rank`, `stats` (all nullable). `MatchFormat = '1v1' | 'teams' | 'ffa'`.
- `lib/outcomes.ts`: add `deriveSideOutcomes(scoreA, scoreB)` and `deriveFfaOutcomes(ranks: Map<profileId, rank>)` — pure mirrors of the RPC logic, used for optimistic UI and tested against the same cases the RPC must satisfy.
- `lib/records.ts`: `computeRecord` — unchanged core (reads participant `outcome`), works for all formats by construction. `filterHeadToHead(matches, a, b)` — now excludes `format === 'ffa'` and requires a and b on **opposite sides**.
- Colocated Vitest tests for every branch: side outcomes, FFA ties, team record aggregation, FFA-excluded head-to-head, opposite-side requirement, every sport's `statSchema` (accepts valid, strips/rejects invalid), every `derivedStats.compute` (incl. missing-input → null).

## 6. Screens

- **`app/(app)/log-match.tsx` — rebuilt as a stepped flow** (single route, internal step state): ① sport (chips, as today) → ② format (chips, only `sport.formats`; hidden when only 1v1) → ③ participants — 1v1: friend picker; teams: two side rosters (tap friends into A/B, creator auto-on A, movable); ffa: ordered list with rank steppers → ④ scores — side scores labeled `sport.scoreLabel` (1v1/teams) or per-player points (ffa; ranks drive outcome) → ⑤ official/friendly + optional stats: one collapsible section per participant rendering `sport.statFields` as numeric inputs, entirely skippable → submit via `log_match` RPC, Zod-validated payload first.
- **`app/(app)/match/[id].tsx` — match detail (new):** fetches one match (`useMatch(id)` hook, key `['match', id]`); header: sport name, date, official/friendly badge, format; score line: side A vs side B with usernames per side and winner highlighted, or FFA ranking table; stats: per-side tables — rows = participants, columns = `statFields.shortLabel` + derived stats, only columns where at least one player entered a value; friendlies render identically (full document) with the friendly badge.
- **Home (`index.tsx`) + profile (`profile/[id].tsx`):** every match row wrapped in a `Link` to `/match/[id]`; row shows sport, format tag, short score (e.g. `3–1`, or `1st of 4` for FFA), outcome color as today.
- Utilitarian styling (emerald-on-white) — the design pass is still a later milestone.

## 7. Verification

- `npx tsc --noEmit` clean; full Vitest suite green (existing 8 + all new cases).
- Data-layer E2E extension (controller-run, as in v1): log a teams match and an FFA match via the RPC as real users; assert server-derived outcomes, stats round-trip, creator-not-participant rejected, direct `insert` into `matches` rejected (policy dropped), reverse-duplicate friendship rejected, addressee tamper-update rejected.
- Simulator walkthrough script for Suryansh: log a 2v2 football match with stats → tap it from home → detail shows sides/scores/stat table; log a 3-player FFA table tennis match → detail shows ranking; verify records/head-to-head changes on both profiles.

## Out of Scope (deferred, do not build)

Live scoring (M3); tournament mode (M4); groups/rosters and persistent teams; ratings; per-sport server-side stat validation; design polish; RNTL; push/EAS/social sign-in. Template-cruft sweep (unused deps/assets, splash color) stays parked for the design milestone.
