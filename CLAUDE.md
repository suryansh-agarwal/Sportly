# CLAUDE.md — Sportly

This file is the complete briefing for any Claude session working in this repo. Read it fully before doing anything. It contains the mission, every decision already made, the exact conventions to follow, and what remains open. If something is stated here, do not re-ask or re-derive it; if something is listed under Open Decisions, ask Suryansh before committing to it. **Nothing in this file is aspirational filler — every line is either a made decision or an explicitly flagged open one.**

**Companion docs (read when relevant):**
- `docs/superpowers/specs/2026-07-07-tech-stack-design.md` — the approved stack spec with reasoning and rejected alternatives.
- `docs/superpowers/plans/2026-07-07-vertical-slice-v1.md` — the current implementation plan (8 tasks, complete code included). If executing it, follow it literally; the code in the plan is the spec.

---

## 1. Mission

Sportly is a social sports-tracking app for friends: a personal "professional record" for casual sports. You add friends, log real-life matches against them across many sports, record detailed sport-specific stats, and build a per-sport skill rating and head-to-head history over time. **It is a social network where the content is real-life matches.** The end state: your Sportly profile is your sporting identity — proof of how good you are at each sport, against whom, and whether you're improving.

**Name:** Sportly (never "Sport Lee" — that was a transcription artifact). **Logo:** a sophisticated, minimal stick figure of a running man.

## 2. Product Vision

### The core loop
1. Add friends.
2. Play a real-life match (football, cricket, basketball, tennis, padel, pickleball, table tennis, badminton — extensible list).
3. Log it: participants, score, sport-specific stats.
4. Your record updates: head-to-head vs that friend, per-sport rating, progress over time.
5. Browse profiles — yours and friends' — showing records, ratings, stat histories.

### Profiles & records
- Profile shows per-sport record: W/L/D overall and head-to-head per friend.
- The profile is the centerpiece of the app. Tournament opponents can view each other's profiles.
- Progress over time matters: users must be able to see if they're getting better or worse at each sport.

### Skill ratings
- One rating **per sport per user** (scale — /10 vs /100 — is an open decision).
- Derived from match results (possibly stats later). **Only official matches feed ratings and the professional record.**
- Rating math runs server-side only (Edge Functions), never on the client — otherwise records can be spoofed. This is a hard rule.

### Match types
- **Official:** counts toward the professional record and rating.
- **Friendly/Exhibition:** documented in full but does not count toward the official record.
- The official-vs-casual distinction is sacred: users must trust their official record reflects real, counted matches.
- Every match, either type, is a full document: date, sport, participants, score, stats. The app is a matchday journal.

### Per-sport stats
- Each sport has a native stat schema (cricket: runs, balls faced, fours, sixes, overs, wickets, economy; football: goals, assists; basketball: points, rebounds, assists; racquet sports: sets/games/points).
- Stat entry must feel native per sport, never a generic form.
- **Extensibility rule:** sport-specific behavior (stats, scoring, match structure) lives behind a per-sport definition — a Zod schema + scoring config. Adding a sport is a data/schema task, not a UI rewrite. Never hardcode one sport's assumptions into core models or UI.

### Live scoring
- Each sport gets an active, sport-native scoring mode during the match (e.g., point-by-point tennis).
- A designated scorer/"referee" role inputs scores live; others subscribe. Built on Supabase Realtime channels.

### Tournament mode
- Any user creates a tournament for a sport, invites players; formats: round robin and knockout (minimum).
- Participants see upcoming fixtures, view opponents' profiles. Tournament matches feed records like any match.
- Fixture generation runs server-side (Edge Function).

### Groups & pickup games
- Groups = friend circles / societies / court regulars.
- Pickup requests: "need 2 for tennis at 7pm tonight" posted to a group; members claim slots. This is the logistics layer that gets matches organized.

## 3. Decisions Locked (do not revisit, do not substitute)

### Stack
| Layer | Choice |
|---|---|
| App | Expo SDK (latest stable), **managed workflow only** — no bare native code, TypeScript |
| Navigation | Expo Router (file-based; deep links for tournament/group invites) |
| Server state | TanStack Query (all Supabase reads/writes) |
| Client state | Zustand — only for genuinely local state (e.g., in-progress live-scoring session before sync) |
| Styling | NativeWind v4 |
| Components | React Native Reusables (deferred until post-slice; slice uses plain RN + NativeWind) |
| Forms | Zod validation (React Hook Form deferred until forms get complex) |
| Backend | Supabase: Postgres + Auth + Realtime + Edge Functions (Deno/TS) + Storage |
| Push | Expo Push Notifications, triggered from Edge Functions via DB webhooks (post-slice) |
| Distribution | EAS Build/Submit/Update (post-slice) |
| Tests | Vitest for pure logic (`lib/**/*.test.ts`); RNTL later for key screens; no E2E pre-launch |

Rejected alternatives (don't re-propose): Flutter (no payoff over React skills), PWA-first (defers app store + iOS push, risks building twice), Firebase (NoSQL fights relational records).

### Architecture rules
- Client talks directly to Supabase; **Row Level Security is the authorization layer.** Every table gets RLS enabled with explicit policies in the same migration that creates it. No exceptions.
- Server-trusted logic (rating calc, fixture generation, result confirmation) lives in Edge Functions, never the client.
- All schema changes go through SQL migration files committed to `supabase/migrations/` (numbered `000N_name.sql`), applied to the **dev** project via Supabase MCP `apply_migration` or `supabase db push`. Never mutate schema ad hoc, never touch prod casually.
- SECURITY DEFINER functions always set `search_path` explicitly (RLS recursion/hijack protection — hard-learned rule).
- Relational core + `jsonb` for sport-specific stat payloads (validated against the sport's Zod schema).

### Canonical values (used in DB checks, TS types, and tests — must match everywhere)
- Match types: exactly `'official'` and `'friendly'`.
- Outcomes: exactly `'win'`, `'loss'`, `'draw'`.
- Sport ids are snake_case slugs: `football`, `cricket`, `basketball`, `tennis`, `padel`, `pickleball`, `table_tennis`, `badminton`.
- Usernames: `^[a-z0-9_]{3,20}$`.

### Repo layout
- `app/` — Expo Router routes ONLY. Route groups: `(auth)` for signed-out, `(app)` for signed-in (tab layout guards on session).
- `lib/` — everything else: `supabase.ts` (client singleton), `auth.tsx` (AuthProvider/useAuth), `types.ts` (shared row types), pure logic modules (`outcomes.ts`, `records.ts`) with colocated `*.test.ts`, `hooks/` for TanStack Query hooks.
- `supabase/migrations/` — numbered SQL migrations.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design docs and implementation plans.
- Pure logic (aggregation, derivation, rating math) is plain TypeScript in `lib/`, imported by hooks/screens — never inlined in components. This is what makes it testable with Vitest without RN.

### Environment & secrets
- `.env` (gitignored): `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- Supabase dev project: `sportly-dev` (create on first backend task if absent; free tier). Production project comes later — never point dev work at prod.
- Never write keys/tokens into committed files, chat summaries, or this file.

## 4. How to Work in This Repo

- **Workflow:** superpowers process — brainstorm → spec → plan → subagent-driven execution with per-task review. New features start with a spec in `docs/superpowers/specs/`, not with code.
- **Verification is part of done:** `npx tsc --noEmit` clean, `npm test` (Vitest) passing, and for UI work actually run the app (`npx expo start`, iOS simulator) and look at it — or tell Suryansh exactly what to check on-device. Never claim something works without having verified it.
- **Commits:** conventional style (`feat:`, `fix:`, `docs:`, `chore:`), small and frequent, message describes the change not the process. Feature branches for milestone work (current: `vertical-slice-v1`); merge to `main` when the milestone is verified.
- **Scope discipline:** match stated scope exactly. Deferrals listed in a plan's Global Constraints are binding — don't gold-plate. YAGNI ruthlessly.
- **Test accounts** for manual verification: `alice@test.com` / `bob@test.com`, both `password123`, usernames `alice`/`bob`. Email confirmation is disabled in the dev project's auth settings (dashboard toggle — Suryansh does this manually if needed).
- **UI taste:** premium-minimal — clean, generous whitespace, subtle animation, no "boring generic AI slop UI." The v1 slice is deliberately utilitarian (emerald-on-white); a real design pass is a future milestone with `frontend-design`/`ui-ux-pro-max` skills. Don't polish the slice prematurely.
- **When context runs low:** write a dense handoff (state, next step, open review findings, exact file paths) so a fresh session resumes at full quality. Update the Status section below whenever a milestone lands — keep it truthful, never aspirational.

## 5. Status (update me as work lands)

- **Done — v1 (merged to `main`):** Expo SDK 57 + TypeScript + NativeWind app with Supabase email auth (signup trigger creates profile), friend requests, match logging, per-sport W/L/D records + head-to-head. Plan: `docs/superpowers/plans/2026-07-07-vertical-slice-v1.md`.
- **Done — M2 (branch `m2-stats-formats`):** matches support **1v1 / teams / free-for-all** with per-sport player stats. Sport definitions live in the `lib/sports/` registry (Zod stat schema + statFields + derived stats per sport; derived values like economy/strike rate computed at display, never stored). **All match writes go through the SECURITY DEFINER `log_match` RPC** (migration 0004; client insert policies dropped; outcomes derived server-side; creator must participate). Friendships hardened (migration 0005: immutability trigger + canonical-pair unique index). Log-match is a 5-step flow; match detail screen at `app/(app)/match/[id]` with per-side stat tables; home + profile rows tap through to it. 25/25 Vitest tests. Spec: `docs/superpowers/specs/2026-07-09-stats-formats-match-detail-design.md`, plan: `docs/superpowers/plans/2026-07-09-stats-formats-match-detail.md`.
- **v1 findings closed by M2:** orphaned partial inserts (atomic RPC), outcome spoofing (server-derived), friendship immutability, reverse-duplicate friendships. **Both former "must fix before ratings" findings CLOSED by M5 migration 0010:** (1) consent guard — every non-creator `log_match` participant must be an accepted friend of the caller or share an accepted spot in some tournament (match-confirmation flow remains a possible future upgrade); (2) stats guard — object stats limited to 2048 bytes (`pg_column_size`) with numeric-only values. Caveat: non-object stats payloads bypass the size guard but were already silently nulled at insert, so nothing bad persists. **Still open (minor):** friends-screen `accept` mutation has no onError; step counter shows "of 5" when the format step is skipped; no "add a friend" hint on the FFA roster step; `statInputs` not cleared when changing sport mid-flow (stale keys → confusing strict-schema alert, no bad data); raw Postgres error text in submit alerts; template cruft parked for the design milestone.
- **Backend:** Supabase project **Sportly**, ref `amfubmmmsfycdhgtmcsw` (Sportly org, Tokyo), linked via CLI. Email confirmation is OFF (dev). ⚠️ Supabase rejects `@test.com` emails — test accounts are `suryanshagarwal13+alice@gmail.com` / `suryanshagarwal13+bob@gmail.com`, both `password123`, usernames `alice`/`bob`. Migrations 0001–0005 applied.
- **Done — M3 (branch `m3-live-scoring`):** live scoring for the 5 racquet sports. Event-sourced: every point is a row in `live_events` (server-ordered → multi-scorer safe); the pure engine `lib/scoring/` (tennis variant with deuce/tiebreak, rally variant with win-by-2/cap) folds events into score state; friends of participants spectate via Supabase Realtime (`postgres_changes`, RLS-gated). Lifecycle via SECURITY DEFINER RPCs in migration 0006 (`start_live_match`/`finish_live_match`/`abandon_live_match`); finish inserts a real match with server-derived outcomes and links `finished_match_id`. Live screen at `app/(app)/live/[id]`, "In progress" strip on home, "Score live" entry on the log-match players step (match_type is 'official' on that path for v1). Spec: `2026-07-10-live-scoring-design.md`, plan: `2026-07-12-live-scoring.md`. M3 deferrals: cricket/football/basketball engines, serve tracking, post-match stat appending. **M3 polish batch (minor, from final review):** Undo button stays enabled after undoing everything (inserts harmless no-op rows — compute net stack depth or return canUndo from foldEvents); brief +2 score flash when the realtime echo beats onSuccess; "View the logged match" link shown to spectators who can't read the match (matches select policy is participant/creator only — gate on isParticipant); live screen query errors render a blank screen (show an error state); tennis center scoreboard reads 0–0 at the completion moment (points reset before complete — cosmetic); `['live-list']` staleness (no focus refetch in RN — consider refetchInterval or AppState hook at design pass). **For the ratings spec:** make `finish_live_match` fold `live_events` server-side as the enforcement point (event log already supports it); verify realtime token refresh on 90-minute matches.
- **Done — M4 (branch `m4-tournaments`):** tournament mode. Round robin (circle method, 3/1/0 points, tiebreak ladder points→two-way h2h→score diff→join order) and single-elimination knockout (next-power-of-2 bracket, random seeding, auto-resolved byes, `(r,p)→(r+1,ceil(p/2))` advancement) — all generated and advanced **server-side** in migration 0007/0008 RPCs (`create/invite/respond/preview/join_by_token/start/record_fixture_result/cancel`); zero client writes. Fixtures resolve by linking real matches (log-match prefill or M3 live scoring); fixture scores are denormalized onto `fixtures` because `matches` RLS is participant-only. Join links: `sportly://join/<token>`. New tournaments tab + `tournament/[id]` (standings table / bracket columns) + `join/[token]` screens. Spec: `2026-07-12-tournaments-design.md`, plan: `2026-07-12-tournaments.md`. Known minor (final review, recorded not fixed): retrying Save after a "fixture link failed" alert can double-log the match; live-fixture start doesn't invalidate the tournament query until finish; declined tournaments linger under "My tournaments"; join screen says "already started" for cancelled tournaments; no player cap (a 30-player RR join-pile-up = 435 fixtures); join tokens use md5(random()) ≈ 64 bits non-crypto (fine while joins are auth-gated + draft-only; switch to gen_random_uuid-based if it ever matters); if the app dies between live-finish and fixture-link, the fixture needs a second match to resolve (consider a "link existing match" affordance); actual tiebreak ladder is points→diff-presorted-top-two-h2h-swap (spec's prose order differs for 3-way ties — SQL and TS agree with each other, document before ratings).
- **Done — M5 (branch `m5-ratings`, awaiting owner walkthrough + merge):** per-sport skill ratings /100. Internal Elo lives in `ratings` (start 1000, numeric; read-only to clients via RLS) and is computed ONLY in the SECURITY DEFINER `apply_match_rating` (migration 0010; not executable by any client role), called by re-created `log_match` + `finish_live_match`; participants get `rating_after`/`rating_delta` (null = never rated / friendly). Constants: K 40→24 at 10 matches, margin `1 + 0.5·|a−b|/(a+b)` cap 1.5 (m=1 for draws/null/0-sum), teams use pre-match side means, FFA pairwise with K/(n−1) and matches_played +1 per match; idempotence guard on `rating_delta is not null` made the full-history backfill (in 0010) safely re-runnable. Display mapping mirrored in `lib/ratings/display.ts` (`displayRating` logistic, `formatDelta` display-scale with U+2212/±0). `useRatings` hook (`['ratings', id]`), invalidated by log/finish/fixture mutations; emerald rating chips on home + friend-profile `RecordList` rows; "Rating changes" section on official match detail (deliberate deviation from spec's "inside StatTable" — StatTable early-returns when no stats, e.g. live-finished matches). Trust hardening: consent + stats guards in `log_match` (see the "CLOSED by M5" line above). Verified: tsc clean, 66/66 Vitest, migration applied to dev, controller E2E 29/29 (backfill replay of the 22 pre-existing matches matches an independent Python Elo replay; margin cap, draw, teams means, FFA, K boundary at 10, consent negatives incl. tournament-mate carol↔alice, stats negatives, RPC/RLS write denials, final 37-match from-scratch replay). NOT yet verified: chips/deltas on-device (simulator boot check only — walkthrough pending). Spec: `2026-07-14-ratings-design.md`, plan: `2026-07-14-ratings.md`. Note: margin cap 1.5 only binds on shutouts — `|a−b|/(a+b) ≤ 1` means m ∈ [1, 1.5] by construction.
- **Roadmap after M5:** M6 groups & pickup requests (first Edge Function + push) → design pass milestone (frontend-design / ui-ux-pro-max). Each starts with its own spec. Ledger: `.superpowers/sdd/progress.md` (git-ignored).
- **Expo Router gotcha:** adding a new route makes `tsc` fail until `.expo/types/router.d.ts` regenerates — start the dev server once (or `npx expo customize tsconfig.json` scenarios) and re-run.

## 6. Open Decisions (ask Suryansh — do not decide unilaterally)

- Each sport's detailed stat schema and live-scoring flow — per-sport specs when we get there.
- Whether friendlies count toward anything casual (streaks, fun stats) or stay purely archival.
- Visual identity beyond the logo concept (design system, palette, type) — future design milestone.
- Production Supabase project setup, EAS/app-store config, launch plan.

## 7. Who You're Building For

Suryansh Agarwal (see `~/CLAUDE.md` for full profile): HKUST Quantitative Finance student, Hong Kong, builder with shipped apps (expiry tracker, timetable optimizer, LinkUp). He reads the code, verifies claims, and expects honesty over polish — report failures plainly, never overstate. He gives terse follow-ups ("yep", "proceed", "1") and expects momentum without re-asking decided questions. Sportly has real launch ambition: he and his friends are the first users, the app stores are the target.
