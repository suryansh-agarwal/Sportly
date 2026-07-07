# Sportly

Sportly is a social sports-tracking app for friends. Think of it as a personal "professional record" for casual sports: you add friends, log the matches you play against them across many sports, record detailed per-sport stats, and build up a skill rating and head-to-head history over time. It is a social network where the content is real-life matches.

**Name:** Sportly. **Logo:** a sophisticated, minimal stick figure of a running man.

## The Core Loop

1. Add friends.
2. Play a real-life match (football, cricket, basketball, tennis, padel, pickleball, table tennis, badminton, and more — the sport list should be extensible).
3. Log the match in Sportly: who played, the score, and detailed sport-specific stats.
4. The result updates your record — your head-to-head history against each friend, your per-sport skill rating, and your progress over time.
5. Browse profiles: yours and your friends', showing records, ratings, and stat histories.

## Key Concepts

### Profiles & Records
- Every user has a profile showing their record per sport: wins/losses/draws overall and head-to-head against each friend.
- The profile is the centerpiece of the app — it's your sporting identity. Opponents in a tournament can view each other's profiles.
- Progress over time matters: a user should be able to see whether they're getting better or worse at each sport.

### Skill Rating System
- Each user gets a skill rating **per sport**, expressed out of 10 or out of 100 (final scale TBD).
- Ratings are derived from match results (and potentially stats). Only **official** matches count toward the rating and the professional record.

### Match Types
- **Friendly / Exhibition:** casual matches that may not count toward your official record or rating.
- **Official:** counted matches that build your professional record and feed the rating system.
- Every match, regardless of type, is documented: date, sport, participants, score, stats. The app is essentially a matchday journal.

### Per-Sport Stats
Each sport has its own native stat schema. Examples:
- **Cricket:** runs, balls faced, fours, sixes, overs bowled, wickets, economy rate.
- **Football:** goals, assists, etc.
- **Basketball:** points, rebounds, assists, etc.
- **Tennis / racquet sports:** sets, games, points.
Stats entry should feel native to each sport, not a generic form. New sports (and their schemas) should be easy to add — design the data model with this extensibility in mind.

### Live Scoring
- Each sport has an active, sport-native scoring mode usable during the match — e.g., point-by-point scoring in tennis.
- A designated person (a "referee"/scorer role) can input scores live as the match happens.

### Tournament Mode
- Any user can create a tournament for a sport and add/invite players; invited players join the tournament.
- Supported formats: **round robin** and **knockout** (at minimum).
- Participants can see their upcoming fixtures and view opponents' profiles.
- Tournament matches feed into records like any other match.

### Groups & Pickup Games
- Users can form groups (e.g., a friend circle, a society, a court's regulars).
- **Pickup requests:** post an open request into a group — "need 2 players for tennis at 7pm tonight" — and members sign up to fill the slots.
- This is the social/logistics layer that gets matches organized in the first place.

## Product Principles

- **Social first:** friends, groups, profiles, and shared match history are the fabric; stats are the substance.
- **Multi-sport by design:** never hardcode a single sport's assumptions into core models or UI. Sport-specific behavior (stats, scoring, match structure) lives behind a per-sport definition.
- **Official vs casual distinction is sacred:** users must trust that their official record reflects real, counted matches.
- **Every match is a document:** even a friendly should be loggable with full detail. The app is the record of your sporting life with your friends.

## Status & Open Decisions

The repo is currently empty — nothing has been built yet. Not yet decided (confirm with Suryansh before committing to any of these):
- Tech stack and platform (mobile-first is implied by the use case, but not decided).
- Rating scale (out of 10 vs out of 100) and the rating algorithm (Elo-style vs stat-weighted).
- Exact initial sport list and each sport's stat schema.
- Whether friendlies can optionally count toward anything (streaks, casual stats) or are purely archival.
- Auth, backend, and data storage choices.
