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

- **Done:** vision doc (this file), stack spec (approved), vertical-slice-v1 plan, and the **vertical slice v1 itself** on branch `vertical-slice-v1`: Expo SDK 57 + TypeScript + NativeWind app with Supabase email auth (signup trigger creates profile), friend requests, match logging (winner/score, official vs friendly), and per-sport W/L/D records with head-to-head profile views. Schema: `supabase/migrations/0001-0003` (profiles/sports, friendships, matches — all RLS'd), applied to the dev project. 8/8 Vitest tests, tsc clean, data-layer E2E passed (sign-in, friend flow, match logging, RLS negatives, official/friendly separation) — see `docs/superpowers/plans/2026-07-07-vertical-slice-v1.md` and the ledger.
- **Slice scope (was):** sign up → add friend → log simple match → per-sport W/L/D + head-to-head. Deliberately excluded: per-sport stats, live scoring, ratings, tournaments, groups, push, EAS, social sign-in.
- **Backend:** Supabase project **Sportly**, ref `amfubmmmsfycdhgtmcsw` (Sportly org, Tokyo), linked via CLI. Email confirmation is OFF (dev). ⚠️ Supabase rejects `@test.com` emails — test accounts are `suryanshagarwal13+alice@gmail.com` / `suryanshagarwal13+bob@gmail.com`, both `password123`, usernames `alice`/`bob`.
- **Known deferred findings (fix before ratings/tournaments trust this data):** (1) friendships UPDATE policy lacks column-immutability — an addressee could rewrite requester_id/addressee_id while accepting; needs a hardening migration (`with check` on addressee_id + immutability trigger). (2) `useLogMatch` two-step insert can orphan a participant-less match on partial failure — `computeRecord` skips them safely; consider an atomic RPC later. (3) Empty score input coerces to 0 in log-match. (4) `accept` mutation in friends screen has no onError. Ledger: `.superpowers/sdd/progress.md` (git-ignored).

## 6. Open Decisions (ask Suryansh — do not decide unilaterally)

- Rating scale (/10 vs /100) and algorithm (Elo-style vs stat-weighted) — needs its own spec.
- Each sport's detailed stat schema and live-scoring flow — per-sport specs when we get there.
- Whether friendlies count toward anything casual (streaks, fun stats) or stay purely archival.
- Visual identity beyond the logo concept (design system, palette, type) — future design milestone.
- Production Supabase project setup, EAS/app-store config, launch plan.

## 7. Who You're Building For

Suryansh Agarwal (see `~/CLAUDE.md` for full profile): HKUST Quantitative Finance student, Hong Kong, builder with shipped apps (expiry tracker, timetable optimizer, LinkUp). He reads the code, verifies claims, and expects honesty over polish — report failures plainly, never overstate. He gives terse follow-ups ("yep", "proceed", "1") and expects momentum without re-asking decided questions. Sportly has real launch ambition: he and his friends are the first users, the app stores are the target.
