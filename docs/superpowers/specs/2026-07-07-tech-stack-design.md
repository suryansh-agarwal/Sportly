# Sportly Tech Stack Design

**Date:** 2026-07-07
**Status:** Approved direction (this doc); implementation not started
**Context:** See `CLAUDE.md` for the full product vision. This spec fixes the platform and stack choices so all future feature specs build on the same foundation.

## Decision Summary

Sportly ships as a **native-feel mobile app for iOS and Android**, built with **Expo (React Native) + TypeScript**, backed by **Supabase**. Chosen because: the founder knows React, launch ambition requires app store presence and push notifications, Sportly's data (head-to-head records, fixtures, ratings) is inherently relational, and live scoring needs managed realtime infrastructure.

Alternatives considered and rejected:
- **Flutter + Supabase** — equivalent capability, but requires learning Dart with no payoff given existing React skills.
- **Next.js PWA first, native later** — fastest to validate, but defers app store presence and iOS push notifications, which the launch ambition requires; risks building the client twice.

## 1. App Layer

| Concern | Choice |
|---|---|
| Framework | Expo SDK (latest stable), managed workflow, TypeScript |
| Navigation | Expo Router (file-based, deep linking for tournament/group invite links) |
| Server state | TanStack Query (caching, refetch, optimistic updates) |
| Client state | Zustand, only for genuinely local state (e.g., in-progress live-scoring session before sync) |
| Styling | NativeWind v4 (Tailwind syntax) |
| Components | React Native Reusables (shadcn-style RN primitives) |
| Forms & validation | React Hook Form + Zod |

Key rule: **each sport's stat schema is a Zod object.** Adding a new sport means adding a schema definition (and a scoring config), not writing new screens. Sport-specific behavior lives behind a per-sport definition, never hardcoded into core models or UI.

Stay on the managed Expo workflow until a concrete need forces bare native code.

## 2. Backend & Data (Supabase)

- **Database:** Postgres. **Row Level Security is the primary authorization mechanism** — friends can read each other's match data; strangers cannot.
- **Core tables (indicative, detailed schema is a future spec):** `profiles`, `friendships`, `sports`, `matches`, `match_participants`, `match_stats`, `ratings`, `tournaments`, `fixtures`, `groups`, `pickup_requests`. Relational core; sport-specific stat payloads go in a `jsonb` column on `match_stats`, validated against the sport's stat schema.
- **Auth:** Supabase Auth with email + Google + Apple sign-in. (Apple sign-in is required for App Store approval when any third-party social login is offered.)
- **Realtime:** Supabase Realtime channels for live scoring — the scorer/referee writes score events to a match channel; players and spectators subscribe.
- **Edge Functions (Deno/TypeScript)** for all server-trusted logic:
  - Rating recalculation after an official match (**rating math never runs on the client** — otherwise records can be spoofed)
  - Tournament fixture generation (round robin, knockout)
  - Match result confirmation flows
- **Push notifications:** Expo Push Notifications, triggered from Edge Functions via database webhooks — fixture reminders, pickup-game requests, friend requests.

## 3. Distribution & Environments

- **EAS Build + Submit** for App Store and Play Store releases; **EAS Update** for over-the-air JS fixes between store releases.
- **Two Supabase projects:** `sportly-dev` for development, `sportly-prod` for production. Develop against dev; promote schema changes via migrations. Supabase CLI local stack is optional and can be adopted later.
- **Git:** feature branches → `main`; EAS builds run off `main`.

## 4. Testing

- **Vitest** for pure logic — rating algorithm, per-sport Zod stat schemas, fixture generation. This is where correctness risk concentrates and gets real coverage.
- **React Native Testing Library** for key flows: match logging, live scoring.
- **No E2E framework (Detox/Maestro) pre-launch.** Revisit once real users exist.

## Out of Scope for This Spec

Decided separately in future specs:
- Detailed database schema and RLS policies
- Rating algorithm design (scale of 10 vs 100, Elo-style vs stat-weighted)
- Initial sport list and each sport's stat/scoring schemas
- App design system and screen designs
- Whether friendlies count toward any casual stats

## First Implementation Milestone (orientation, not a plan)

Scaffold the Expo app, connect Supabase auth, and ship the thinnest vertical slice: sign up → add a friend → log a simple match result → see it on both profiles. Everything else builds on that spine.
