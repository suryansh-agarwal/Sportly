# Handoff: Sportly session → M5 (Ratings) execution

**Written 2026-07-14 by the session that built M1–M4.** Read `CLAUDE.md` first (it is the durable briefing and is up to date); this file adds the session-specific state and process detail a fresh session needs to continue at the same quality bar. Trust this + git log + `.superpowers/sdd/progress.md` over any summary.

## Where things stand (exact)

- `main` = `92641f3` + two spec/handoff commits after it. All of M1 (vertical slice), M2 (formats+stats), M3 (live scoring), M4 (tournaments) are merged, pushed to `github.com/suryansh-agarwal/Sportly`, E2E-verified, and final-reviewed. 61/61 Vitest, tsc clean on main.
- **M5 (ratings + trust hardening) is SPECCED, NOT PLANNED, NOT BUILT.** Approved spec: `docs/superpowers/specs/2026-07-14-ratings-design.md`. Suryansh approved the design conversationally (scale /100, Elo internal, full-history backfill — his explicit picks). **Your first task: write the implementation plan** per superpowers:writing-plans, then execute via subagent-driven development. Expected shape: ~4 tasks (migration 0010; lib/ratings display + tests; useRatings hook + invalidations; UI chips/deltas) + close-out + controller E2E. Branch name: `m5-ratings`.
- Migrations 0001–0009 are applied to the dev Supabase project. 0010 will be the ratings migration.

## The established execution process (follow it exactly — it has caught real bugs every milestone)

1. Plan in `docs/superpowers/plans/` with COMPLETE code per task (the plan is the spec; implementers transcribe). Global Constraints section carries canonical values verbatim.
2. Branch from main. Reset ledger: `echo "M5 ledger start" > .superpowers/sdd/progress.md` (git-ignored dir; NEVER commit it).
3. Per task: `task-brief` script → dispatch implementer subagent (haiku for pure transcription, sonnet for anything with simulator verification or debugging latitude; ALWAYS set the model explicitly) → `review-package BASE HEAD` (record BASE before dispatch, never HEAD~1) → dispatch task reviewer (sonnet) with the brief + report + diff paths and the binding constraints pasted verbatim. Fix subagents for Critical/Important; re-review after fixes. Append one ledger line per completed task.
4. Migrations are FILE-ONLY for implementers. The controller (you) applies them: `supabase db push` (repo is linked to the project; answer Y is auto-fed). Then live-verify via REST with keys fetched at runtime (see Environment quirks).
5. Controller-run E2E after the build tasks: python scripts in `$CLAUDE_JOB_DIR/tmp/` hitting the REST/RPC API as the real test users (patterns in this session: e2e.py, e2e_m2.py, e2e_m3.py, e2e_m4.py, e2e_m4_ko6.py — rewrite fresh, the pattern is: sign in via password grant, call RPCs, assert PASS/FAIL lines, exit 1 on failure). ALWAYS include negative/RLS cases and — lesson from M4 — **test at non-trivial scale** (the knockout premature-completion Critical was invisible at n=3, caught only by review, proven at n=6).
6. Final whole-branch review on the **most capable model (fable)** with `review-package $(git merge-base main HEAD) HEAD`. Expect real findings — every milestone's final review found something the task reviews missed (M2: query-cache cross-user leak; M3: missed realtime events on reconnect; M4: the KO Critical). Fix Criticals/Importants via one fix subagent, re-review the fix wave, record minors in CLAUDE.md §5 truthfully.
7. Suryansh's simulator walkthrough gates the merge. Give him a concrete numbered script with expected values. Merge `--no-ff`, push, verify tsc+tests on main.

## Environment quirks (each cost time once — don't rediscover)

- **Supabase project:** name `Sportly`, ref `amfubmmmsfycdhgtmcsw`, org `itolcljjxouehbymlpoh` (his own org — the claude.ai Supabase MCP CANNOT access it; got "permission denied". Use the `supabase` CLI, which is linked, and raw REST). Keys: `supabase projects api-keys --project-ref amfubmmmsfycdhgtmcsw -o json` — fetch into a shell variable at runtime; NEVER paste a key literal into a command (the permission classifier blocks it, correctly).
- `.env` at repo root has the URL + anon key (gitignored); E2E scripts `source .env`.
- **Test accounts** (email confirm is OFF on the project; Supabase REJECTS @test.com emails): `suryanshagarwal13+{alice,bob,carol,dave,erin,frank}@gmail.com`, all `password123`, usernames = the +suffix. alice↔bob are friends. carol/dave/erin/frank joined tournaments via token (carol is nobody's friend — useful for testing the new consent guard's tournament-mate clause).
- **Dev data note for the 0010 backfill:** the dev DB contains real official matches from the E2Es (several table_tennis/tennis/football/badminton matches incl. teams, FFA, tournament fixtures). The backfill E2E golden must replay whatever exists — query matches first, compute goldens in Python from that.
- Expo/simulator: `npx expo start --ios` in background; screenshot `xcrun simctl io booted screenshot /tmp/x.png` and Read it. New routes break tsc until `.expo/types/router.d.ts` regenerates (start dev server once). Subagents sometimes stall "waiting for bundle" — nudge them via SendMessage to take the screenshot and finish. A persisted session lands on the Profile tab, not sign-in — that's fine as a boot check.
- `sleep N && cmd` chains are blocked; use run_in_background or Monitor until-loops.
- Auto-mode classifier blocks: literal secrets in commands, and security-posture changes (e.g. toggling email confirm) — the latter is Suryansh's to do in the dashboard.

## Things to carry into the M5 plan specifically

- The spec's constants (start 1000, K 40/24 at 10 matches, margin `1 + 0.5·diff/total` cap 1.5, display logistic, FFA K/(n−1)) must appear VERBATIM in: migration 0010, `lib/ratings/display.ts`, and the E2E's Python golden calculator. Three copies — the E2E is what proves they agree.
- 0010 re-creates `log_match` (currently at 0007-era body + 0004 origin — the CURRENT authoritative body is in **0004**, amended nowhere else) and `finish_live_match` (authoritative body in **0006**). record_fixture_result's current body is in **0009** (not 0007/0008). Copy from the latest version of each.
- The consent guard MUST allow tournament-mates (common tournament, both accepted) or M4 fixtures between non-friends break — there's an E2E-ready case: carol vs alice.
- `useRecordFixtureResult`, `useLogMatch`, `useFinishLiveMatch` all need `['ratings']` invalidation added.
- `RecordList` is exported from `app/(app)/index.tsx` and reused by `profile/[id].tsx` — the ratings-chip prop touches both call sites.
- Deferred-and-documented (do NOT let a reviewer talk you into building them mid-M5): server-side live-event folding, leaderboards, rating decay, M3 polish batch, M4 minors (all listed in CLAUDE.md §5).

## Suryansh's working style (also in ~/CLAUDE.md, but the essentials)

Terse go-aheads ("go", "1", "yes", "continue") mean proceed at full speed without re-asking. He reads code and expects honesty over polish — report failures plainly, record caveats in CLAUDE.md, never claim unverified success. Verification is part of done: tsc + tests + actually running the thing. He does the on-device walkthrough personally — hand him a precise script. Quality must not degrade late in long sessions.

## Immediate next actions for the new session

1. `git log --oneline -5` + `cat .superpowers/sdd/progress.md` to confirm state matches this handoff.
2. Invoke superpowers:writing-plans for the M5 spec → `docs/superpowers/plans/2026-07-14-ratings.md` (complete code, self-review for the known failure modes: CTE scoping in plpgsql, test fixtures that don't exercise their branch, counts).
3. Execute via superpowers:subagent-driven-development on branch `m5-ratings`, per the process above.
4. After merge: next roadmap items are M6 groups & pickup requests (first Edge Function + push) and the design pass (frontend-design / ui-ux-pro-max skills, replace utilitarian emerald-on-white).
