# Sportly Milestone 5: Skill Ratings + Trust Hardening

**Date:** 2026-07-14
**Status:** Approved design
**Builds on:** M1–M4 (all merged to `main`). Vision: `CLAUDE.md` §2 (skill ratings). Closes the deferred trust findings from the M2/M3 reviews.

## Goal

Every profile shows a per-sport skill rating out of 100, derived server-side from official matches only, replayed over existing history at launch — plus the write-path hardening that ratings make necessary (participant consent, stats shape).

## Decisions Made (with the user — do not reopen)

- **Scale:** displayed **0–100**. **Algorithm:** standard **Elo internally**, logistic-mapped to the display scale. **Backfill:** full chronological replay of existing official matches at migration time.
- Only **official** matches move ratings. Friendlies and abandoned live matches never do.
- Rating math runs **only** inside the database write path (`apply_match_rating` called by `log_match` / `finish_live_match`). Clients display, never compute (except the pure display mapping).

## 1. Rating Engine (single plpgsql function, authoritative)

### Constants (canonical — DB, TS display mirror, and E2E goldens must agree)

- Internal start rating: **1000.0** (numeric).
- Display mapping: `display(R) = round(100 / (1 + 10^((1000 − R) / 400)))` → 1000→50, 1400→91, 600→9; clamp never needed (asymptotic).
- Expected score vs opponent: `E = 1 / (1 + 10^((R_them − R_me)/400))`.
- K-factor: **40** while `matches_played < 10` in that sport (per player), **24** after.
- Margin multiplier (sided matches with both scores present): `m = 1 + 0.5 × |score_a − score_b| / (score_a + score_b)`, capped at **1.5**; `m = 1` when `score_a + score_b = 0` or scores are null. Draws use `m = 1`.
- Update: `ΔR = K × m × (S − E)` with `S ∈ {1, 0.5, 0}` from the participant's stored `outcome`.

### Per format

- **1v1:** plain pairwise update.
- **Teams:** side rating = arithmetic mean of members' internal ratings (taken **before** any updates); each member updates against the opposing side's mean using their own K and the match margin. Every member of a side shares the side's S.
- **FFA:** for each unordered participant pair, S from rank comparison (lower rank number wins; equal ranks draw); margin multiplier = 1; each pairwise K is scaled by `1/(n−1)`. All expected scores computed from pre-match ratings; deltas summed then applied once per participant. `matches_played` increments by 1 per FFA match (not per pairing).
- Order of operations in all formats: read all pre-match ratings → compute all deltas → apply. No sequential within-match drift.

### `apply_match_rating(p_match_id uuid)`

plpgsql, SECURITY DEFINER, `search_path = public, pg_temp`, **not** granted to any client role (internal, like `advance_knockout`). Behavior: no-op for friendlies; upserts `ratings` rows (start 1000) for every participant; computes deltas per the rules above; updates `ratings.rating`/`matches_played`; writes `match_participants.rating_after` (internal rating after) and `rating_delta` (internal delta) for every participant. The function is **idempotent by guard**: if any participant of the match already has `rating_delta is not null`, it returns without doing anything. That makes accidental double-application harmless and the backfill safely re-runnable.

Called at the end of `log_match` and `finish_live_match` (both re-created in migration 0010 with the call added).

## 2. Schema — migration `0010_ratings_and_hardening.sql`

```sql
create table public.ratings (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  sport_id text not null references public.sports(id),
  rating numeric not null default 1000,
  matches_played integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (profile_id, sport_id)
);
alter table public.ratings enable row level security;
create policy "authenticated users can read ratings"
  on public.ratings for select to authenticated using (true);
-- no client writes

alter table public.match_participants
  add column rating_after numeric,
  add column rating_delta numeric;
```

### Trust hardening (same migration)

- **`log_match` participant-consent guard:** every participant other than `auth.uid()` must satisfy: accepted friendship with the caller, **or** both are `accepted` players of at least one common tournament. Error: `'participants must be your friends or tournament opponents'`.
- **`log_match` stats guard:** for each participant's non-null stats: `pg_column_size(stats) <= 2048` and every `jsonb_each` value has `jsonb_typeof = 'number'`. Error: `'stats must be numeric values'` / `'stats too large'`.
- Both `log_match` and `finish_live_match` re-created (full function bodies) with `perform public.apply_match_rating(v_match_id);` as the final statement before `return`.

### Backfill (end of the same migration)

```sql
do $$
declare r record;
begin
  for r in select id from public.matches
           where match_type = 'official'
           order by created_at, id
  loop
    perform public.apply_match_rating(r.id);
  end loop;
end $$;
```

(The idempotence guard is keyed on `rating_delta is not null`, so re-running the backfill is a harmless no-op.)

## 3. Display logic — `lib/ratings/`

```
lib/ratings/display.ts       # displayRating(internal: number): number  — the logistic mapping
                             # formatDelta(internalDelta, internalAfter): string — display-scale delta, e.g. "+3"/"−2"/"±0"
lib/ratings/display.test.ts  # goldens: 1000→50, 1400→91, 600→9, monotonic; delta = display(after) − display(after − delta)
```

`formatDelta` computes the **display-scale** difference (display(after) − display(before)) so the UI never shows internal Elo numbers.

## 4. Hooks & UI

- `useRatings(profileId)` in `lib/hooks/useRatings.ts` — key `['ratings', profileId]`, returns `{ sport_id, rating, matches_played }[]`. Invalidated by `useLogMatch`, `useFinishLiveMatch`, and `useRecordFixtureResult` (invalidate `['ratings']` prefix-wide — both participants' caches).
- **Home (`index.tsx`):** rating chip (display value, emerald pill) on each `RecordList` row — `RecordList` gains an optional `ratings` prop; my profile passes it.
- **Friend profile:** same chip via the same prop.
- **Match detail:** for official matches, each participant row in `StatTable`'s screen shows `formatDelta` next to the username (green positive / red negative / gray zero). Friendlies show nothing.
- No leaderboard, no rating on log-match/live screens (future, design-pass milestone).

## 5. Testing & Verification

- Vitest: display mapping goldens + monotonicity; formatDelta sign/rounding behavior (61 existing tests stay green).
- Controller E2E (goldens computed independently in Python with the same constants): fresh-sport 1v1 official (K=40 both, exact delta), margin cap (huge blowout → m capped at 1.5), draw (football 1v1), friendly no-op (ratings unchanged, deltas null), teams (side means, per-member K), FFA 3-player (pairwise, K/(n−1), one matches_played), provisional→settled K boundary at 10 matches, hardening negatives (stranger participant rejected; tournament-mate accepted; string-valued stats rejected; >2KB stats rejected), double-application guard, and backfill correctness (ratings for the existing dev history equal a from-scratch Python replay).
- Simulator walkthrough: ratings chips on both profiles, delta on a fresh match detail.

## Out of Scope (do not build)

Leaderboards; stat-weighted rating adjustments; rating decay/inactivity; per-sport K tuning UI; server-side live-event folding at finish (still deferred — documented trust boundary); seeding tournaments by rating; design polish.
