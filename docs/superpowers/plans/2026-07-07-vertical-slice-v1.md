# Sportly Vertical Slice v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the Sportly Expo app and ship the thinnest vertical slice: sign up → add a friend → log a simple match result → see it on both profiles.

**Architecture:** Expo (managed workflow) + Expo Router client talking directly to Supabase (Postgres + Auth) with Row Level Security as the authorization layer. TanStack Query owns all server state. Pure logic (outcome derivation, record aggregation) lives in `lib/` as plain TypeScript, tested with Vitest. No Edge Functions, realtime, ratings, or per-sport stats in this slice.

**Tech Stack:** Expo SDK (latest stable), TypeScript, Expo Router, NativeWind v4, TanStack Query, Zod, Supabase JS v2, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-07-tech-stack-design.md`. Managed Expo workflow only — no bare native code.
- All Supabase schema changes go through SQL migration files committed to `supabase/migrations/`, applied to the **dev** Supabase project (never prod) via the Supabase MCP `apply_migration` tool (or `supabase db push` if the CLI is linked).
- Every table has RLS enabled with explicit policies. No table is created without policies in the same migration.
- Match type values are exactly `'official'` and `'friendly'`; outcome values exactly `'win'`, `'loss'`, `'draw'` — these strings appear in DB checks, TypeScript types, and tests and must match everywhere.
- Env vars are `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in `.env` (gitignored).
- **Deliberate deferrals (do not add):** Google/Apple sign-in (email/password only for now), React Native Reusables, React Hook Form (Zod + controlled state suffices for the one form), React Native Testing Library, push notifications, EAS setup.
- Manual verification runs the app with `npx expo start` in the iOS simulator (or Expo Go on a device) with two test accounts: `alice` / `alice@test.com` and `bob` / `bob@test.com`, both password `password123`.

---

## File Structure

```
app/
  _layout.tsx              # Root: QueryClientProvider + AuthProvider + stack
  (auth)/_layout.tsx       # Redirects signed-in users into (app)
  (auth)/sign-in.tsx
  (auth)/sign-up.tsx
  (app)/_layout.tsx        # Guard: redirects signed-out users to (auth); tabs
  (app)/index.tsx          # Home: my profile + record + recent matches
  (app)/friends.tsx        # Search, requests, friend list
  (app)/log-match.tsx      # Log a match against a friend
  (app)/profile/[id].tsx   # Friend profile: head-to-head record
lib/
  supabase.ts              # Supabase client singleton
  auth.tsx                 # AuthProvider + useAuth
  types.ts                 # Shared row types
  outcomes.ts              # deriveOutcomes (pure)
  outcomes.test.ts
  records.ts               # computeRecord, filterHeadToHead (pure)
  records.test.ts
  hooks/
    useProfile.ts
    useFriends.ts          # + toFriendList pure helper
    useMatches.ts          # + useLogMatch mutation
supabase/migrations/
  0001_profiles_sports.sql
  0002_friendships.sql
  0003_matches.sql
```

---

### Task 1: Scaffold Expo app with TypeScript, Expo Router, and NativeWind

**Files:**
- Create: entire Expo template (`app/`, `package.json`, `tsconfig.json`, `app.json`, ...) at repo root
- Create: `tailwind.config.js`, `global.css`, `babel.config.js`, `metro.config.js`, `nativewind-env.d.ts`
- Modify: `.gitignore` (add `.env`)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a running Expo app where any component can use NativeWind `className` props; later tasks create screens under `app/` and modules under `lib/`.

- [ ] **Step 1: Scaffold into the existing repo**

The repo root is non-empty (README, CLAUDE.md, docs/), so scaffold into a temp dir and merge:

```bash
cd /Users/suryanshagarwal/Desktop/projects/Sportly
npx create-expo-app@latest tmp-scaffold --template default
rsync -a --exclude README.md tmp-scaffold/ .
rm -rf tmp-scaffold
npm run reset-project   # answer: delete example files (or move, then rm -rf app-example)
rm -rf app-example
```

Expected: `app/index.tsx` and `app/_layout.tsx` exist, `npx tsc --noEmit` passes.

- [ ] **Step 2: Install and configure NativeWind v4**

```bash
npx expo install nativewind tailwindcss react-native-reanimated react-native-safe-area-context
```

Create `tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: { extend: {} },
  plugins: [],
};
```

Create `global.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Create `babel.config.js`:

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
  };
};
```

Create `metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const config = getDefaultConfig(__dirname);
module.exports = withNativeWind(config, { input: './global.css' });
```

Create `nativewind-env.d.ts`:

```ts
/// <reference types="nativewind/types" />
```

- [ ] **Step 3: Prove NativeWind renders**

Replace `app/index.tsx`:

```tsx
import { Text, View } from 'react-native';
import '../global.css';

export default function Index() {
  return (
    <View className="flex-1 items-center justify-center bg-white">
      <Text className="text-2xl font-bold text-emerald-600">Sportly</Text>
    </View>
  );
}
```

Run: `npx expo start` → open iOS simulator.
Expected: green bold "Sportly" centered on white. Kill the server after verifying.

- [ ] **Step 4: Gitignore env + commit**

Append to `.gitignore`:

```
.env
```

```bash
git add -A
git commit -m "feat: scaffold Expo app with TypeScript, Expo Router, NativeWind"
```

---

### Task 2: Supabase dev project, first migration (profiles + sports), client singleton

**Files:**
- Create: `supabase/migrations/0001_profiles_sports.sql`
- Create: `lib/supabase.ts`
- Create: `.env`

**Interfaces:**
- Consumes: nothing
- Produces: `supabase` client (`lib/supabase.ts`, named export `supabase: SupabaseClient`); DB tables `public.profiles(id, username, display_name, created_at)` and `public.sports(id, name)`; a trigger that auto-creates a profile row on signup from `raw_user_meta_data.username` / `.display_name`.

- [ ] **Step 1: Ensure a dev Supabase project exists**

Using the Supabase MCP tools: `list_projects`; if no project named `sportly-dev` exists, create one with `create_project` (name `sportly-dev`, smallest tier — confirm cost first with `get_cost`/`confirm_cost`). Then fetch `get_project_url` and `get_publishable_keys` for it.

Create `.env` at repo root with the real values:

```
EXPO_PUBLIC_SUPABASE_URL=<url from get_project_url>
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon/publishable key from get_publishable_keys>
```

- [ ] **Step 2: Write migration 0001**

Create `supabase/migrations/0001_profiles_sports.sql`:

```sql
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 50),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "authenticated users can read profiles"
  on public.profiles for select to authenticated using (true);

create policy "users can update own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()));

create function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'username',
    coalesce(new.raw_user_meta_data ->> 'display_name',
             new.raw_user_meta_data ->> 'username')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.sports (
  id text primary key,
  name text not null
);

alter table public.sports enable row level security;

create policy "authenticated users can read sports"
  on public.sports for select to authenticated using (true);

insert into public.sports (id, name) values
  ('football', 'Football'),
  ('cricket', 'Cricket'),
  ('basketball', 'Basketball'),
  ('tennis', 'Tennis'),
  ('padel', 'Padel'),
  ('pickleball', 'Pickleball'),
  ('table_tennis', 'Table Tennis'),
  ('badminton', 'Badminton');
```

- [ ] **Step 3: Apply and verify**

Apply with Supabase MCP `apply_migration` (name `profiles_sports`, the SQL above) against `sportly-dev`.

Verify with `execute_sql`: `select count(*) from public.sports;`
Expected: `8`.

- [ ] **Step 4: Client singleton**

```bash
npx expo install @supabase/supabase-js @react-native-async-storage/async-storage react-native-url-polyfill
npm install @tanstack/react-query zod
```

Create `lib/supabase.ts`:

```ts
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);
```

Run: `npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/ lib/supabase.ts package.json package-lock.json
git commit -m "feat: add Supabase client and profiles/sports schema"
```

---

### Task 3: Auth — provider, sign-up/sign-in screens, route guard

**Files:**
- Create: `lib/auth.tsx`
- Modify: `app/_layout.tsx`
- Create: `app/(auth)/_layout.tsx`, `app/(auth)/sign-in.tsx`, `app/(auth)/sign-up.tsx`
- Create: `app/(app)/_layout.tsx`
- Move: `app/index.tsx` → `app/(app)/index.tsx`

**Interfaces:**
- Consumes: `supabase` from `lib/supabase.ts`
- Produces: `AuthProvider` and `useAuth(): { session: Session | null; loading: boolean }` from `lib/auth.tsx`. All screens under `app/(app)/` may assume a signed-in session; `useAuth().session!.user.id` is the current profile id.

- [ ] **Step 1: Auth context**

Create `lib/auth.tsx`:

```tsx
import { createContext, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

const AuthContext = createContext<{ session: Session | null; loading: boolean }>({
  session: null,
  loading: true,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={{ session, loading }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
```

- [ ] **Step 2: Root layout with providers**

Replace `app/_layout.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { AuthProvider } from '../lib/auth';
import '../global.css';

const queryClient = new QueryClient();

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
```

(Remove the `import '../global.css'` line from `app/(app)/index.tsx` once it lives here.)

- [ ] **Step 3: Route groups and guards**

Create `app/(auth)/_layout.tsx`:

```tsx
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../lib/auth';

export default function AuthLayout() {
  const { session, loading } = useAuth();
  if (loading) return null;
  if (session) return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

Create `app/(app)/_layout.tsx`:

```tsx
import { Redirect, Tabs } from 'expo-router';
import { useAuth } from '../../lib/auth';

export default function AppLayout() {
  const { session, loading } = useAuth();
  if (loading) return null;
  if (!session) return <Redirect href="/sign-in" />;
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: 'Profile' }} />
      <Tabs.Screen name="friends" options={{ title: 'Friends' }} />
      <Tabs.Screen name="log-match" options={{ title: 'Log Match' }} />
      <Tabs.Screen name="profile/[id]" options={{ href: null }} />
    </Tabs>
  );
}
```

Move the placeholder home screen: `git mv app/index.tsx "app/(app)/index.tsx"`. Create placeholder files `app/(app)/friends.tsx`, `app/(app)/log-match.tsx`, and `app/(app)/profile/[id].tsx`, each exporting a default component rendering the screen name in a `<Text>` (same shape as the home placeholder) so the tab bar resolves.

- [ ] **Step 4: Sign-up screen**

Create `app/(auth)/sign-up.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { Link } from 'expo-router';
import { z } from 'zod';
import { supabase } from '../../lib/supabase';

const schema = z.object({
  username: z.string().regex(/^[a-z0-9_]{3,20}$/, '3-20 chars: a-z, 0-9, _'),
  email: z.string().email(),
  password: z.string().min(8, 'At least 8 characters'),
});

export default function SignUp() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    const parsed = schema.safeParse({ username, email, password });
    if (!parsed.success) {
      Alert.alert('Invalid input', parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: { data: { username: parsed.data.username, display_name: parsed.data.username } },
    });
    setBusy(false);
    if (error) Alert.alert('Sign up failed', error.message);
  }

  return (
    <View className="flex-1 justify-center gap-3 bg-white p-6">
      <Text className="mb-4 text-3xl font-bold text-emerald-600">Join Sportly</Text>
      <TextInput
        className="rounded-lg border border-gray-300 p-3"
        placeholder="username"
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
      />
      <TextInput
        className="rounded-lg border border-gray-300 p-3"
        placeholder="email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        className="rounded-lg border border-gray-300 p-3"
        placeholder="password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable
        className="mt-2 rounded-lg bg-emerald-600 p-4"
        disabled={busy}
        onPress={onSubmit}
      >
        <Text className="text-center font-semibold text-white">
          {busy ? 'Creating account…' : 'Sign up'}
        </Text>
      </Pressable>
      <Link href="/sign-in" className="mt-2 text-center text-emerald-700">
        Already have an account? Sign in
      </Link>
    </View>
  );
}
```

**Supabase dashboard setting:** in `sportly-dev` → Authentication → disable "Confirm email" so test signups create sessions immediately.

- [ ] **Step 5: Sign-in screen**

Create `app/(auth)/sign-in.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '../../lib/supabase';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) Alert.alert('Sign in failed', error.message);
  }

  return (
    <View className="flex-1 justify-center gap-3 bg-white p-6">
      <Text className="mb-4 text-3xl font-bold text-emerald-600">Sportly</Text>
      <TextInput
        className="rounded-lg border border-gray-300 p-3"
        placeholder="email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        className="rounded-lg border border-gray-300 p-3"
        placeholder="password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable
        className="mt-2 rounded-lg bg-emerald-600 p-4"
        disabled={busy}
        onPress={onSubmit}
      >
        <Text className="text-center font-semibold text-white">
          {busy ? 'Signing in…' : 'Sign in'}
        </Text>
      </Pressable>
      <Link href="/sign-up" className="mt-2 text-center text-emerald-700">
        New here? Create an account
      </Link>
    </View>
  );
}
```

- [ ] **Step 6: Verify the auth loop manually**

Run `npx expo start`, then in the simulator:
1. App opens on sign-in (no session) → navigate to sign-up.
2. Create `alice` / `alice@test.com` / `password123` → lands on the Profile tab.
3. Verify profile row exists via MCP `execute_sql`: `select username from public.profiles;` → Expected: one row, `alice`.
4. Also create `bob` / `bob@test.com` / `password123` (sign out first: temporarily unnecessary — instead create bob later from a second simulator, OR just sign up bob now and sign back in as alice).

Expected: both `alice` and `bob` rows in `profiles`.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add -A
git commit -m "feat: email/password auth with signup profile creation and route guards"
```

---

### Task 4: Pure logic with Vitest — outcome derivation and record aggregation (TDD)

**Files:**
- Create: `vitest.config.ts`, `lib/types.ts`, `lib/outcomes.ts`, `lib/outcomes.test.ts`, `lib/records.ts`, `lib/records.test.ts`
- Modify: `package.json` (add `"test": "vitest run"` script)

**Interfaces:**
- Consumes: nothing (pure TS)
- Produces:
  - `lib/types.ts`: `Outcome = 'win' | 'loss' | 'draw'`; `MatchType = 'official' | 'friendly'`; `ParticipantRow = { profile_id: string; score: number; outcome: Outcome }`; `MatchRow = { id: string; sport_id: string; match_type: MatchType; played_at: string; participants: ParticipantRow[] }`
  - `lib/outcomes.ts`: `deriveOutcomes(myScore: number, theirScore: number): { mine: Outcome; theirs: Outcome }`
  - `lib/records.ts`: `computeRecord(matches: MatchRow[], profileId: string): SportRecord[]` where `SportRecord = { sportId: string; wins: number; losses: number; draws: number }`; `filterHeadToHead(matches: MatchRow[], a: string, b: string): MatchRow[]`

- [ ] **Step 1: Vitest setup**

```bash
npm install -D vitest
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['lib/**/*.test.ts'] },
});
```

Add to `package.json` scripts: `"test": "vitest run"`.

Create `lib/types.ts`:

```ts
export type Outcome = 'win' | 'loss' | 'draw';
export type MatchType = 'official' | 'friendly';

export type ParticipantRow = {
  profile_id: string;
  score: number;
  outcome: Outcome;
};

export type MatchRow = {
  id: string;
  sport_id: string;
  match_type: MatchType;
  played_at: string;
  participants: ParticipantRow[];
};
```

- [ ] **Step 2: Write failing outcome tests**

Create `lib/outcomes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveOutcomes } from './outcomes';

describe('deriveOutcomes', () => {
  it('higher score wins', () => {
    expect(deriveOutcomes(3, 1)).toEqual({ mine: 'win', theirs: 'loss' });
  });
  it('lower score loses', () => {
    expect(deriveOutcomes(0, 2)).toEqual({ mine: 'loss', theirs: 'win' });
  });
  it('equal scores draw', () => {
    expect(deriveOutcomes(2, 2)).toEqual({ mine: 'draw', theirs: 'draw' });
  });
});
```

Run: `npm test` → Expected: FAIL (`Cannot find module './outcomes'`).

- [ ] **Step 3: Implement outcomes**

Create `lib/outcomes.ts`:

```ts
import type { Outcome } from './types';

export function deriveOutcomes(
  myScore: number,
  theirScore: number
): { mine: Outcome; theirs: Outcome } {
  if (myScore > theirScore) return { mine: 'win', theirs: 'loss' };
  if (myScore < theirScore) return { mine: 'loss', theirs: 'win' };
  return { mine: 'draw', theirs: 'draw' };
}
```

Run: `npm test` → Expected: 3 passing.

- [ ] **Step 4: Write failing record tests**

Create `lib/records.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { MatchRow } from './types';
import { computeRecord, filterHeadToHead } from './records';

const match = (
  id: string,
  sport: string,
  type: MatchRow['match_type'],
  a: [string, number, MatchRow['participants'][0]['outcome']],
  b: [string, number, MatchRow['participants'][0]['outcome']]
): MatchRow => ({
  id,
  sport_id: sport,
  match_type: type,
  played_at: '2026-07-07',
  participants: [
    { profile_id: a[0], score: a[1], outcome: a[2] },
    { profile_id: b[0], score: b[1], outcome: b[2] },
  ],
});

describe('computeRecord', () => {
  it('aggregates official wins/losses/draws per sport', () => {
    const matches = [
      match('1', 'tennis', 'official', ['alice', 2, 'win'], ['bob', 0, 'loss']),
      match('2', 'tennis', 'official', ['alice', 0, 'loss'], ['bob', 2, 'win']),
      match('3', 'tennis', 'official', ['alice', 1, 'draw'], ['bob', 1, 'draw']),
      match('4', 'football', 'official', ['alice', 3, 'win'], ['bob', 1, 'loss']),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([
      { sportId: 'tennis', wins: 1, losses: 1, draws: 1 },
      { sportId: 'football', wins: 1, losses: 0, draws: 0 },
    ]);
  });

  it('excludes friendly matches', () => {
    const matches = [
      match('1', 'tennis', 'friendly', ['alice', 2, 'win'], ['bob', 0, 'loss']),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([]);
  });

  it('ignores matches the profile is not in', () => {
    const matches = [
      match('1', 'tennis', 'official', ['bob', 2, 'win'], ['carol', 0, 'loss']),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([]);
  });
});

describe('filterHeadToHead', () => {
  it('keeps only matches containing both profiles', () => {
    const matches = [
      match('1', 'tennis', 'official', ['alice', 2, 'win'], ['bob', 0, 'loss']),
      match('2', 'tennis', 'official', ['alice', 2, 'win'], ['carol', 0, 'loss']),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob').map((m) => m.id)).toEqual(['1']);
  });
});
```

Run: `npm test` → Expected: FAIL (`Cannot find module './records'`).

- [ ] **Step 5: Implement records**

Create `lib/records.ts`:

```ts
import type { MatchRow } from './types';

export type SportRecord = {
  sportId: string;
  wins: number;
  losses: number;
  draws: number;
};

export function computeRecord(matches: MatchRow[], profileId: string): SportRecord[] {
  const bySport = new Map<string, SportRecord>();
  for (const m of matches) {
    if (m.match_type !== 'official') continue;
    const me = m.participants.find((p) => p.profile_id === profileId);
    if (!me) continue;
    let rec = bySport.get(m.sport_id);
    if (!rec) {
      rec = { sportId: m.sport_id, wins: 0, losses: 0, draws: 0 };
      bySport.set(m.sport_id, rec);
    }
    if (me.outcome === 'win') rec.wins += 1;
    else if (me.outcome === 'loss') rec.losses += 1;
    else rec.draws += 1;
  }
  return [...bySport.values()];
}

export function filterHeadToHead(matches: MatchRow[], a: string, b: string): MatchRow[] {
  return matches.filter(
    (m) =>
      m.participants.some((p) => p.profile_id === a) &&
      m.participants.some((p) => p.profile_id === b)
  );
}
```

Run: `npm test` → Expected: 7 passing (3 outcomes + 4 records).

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts lib/ package.json package-lock.json
git commit -m "feat: outcome derivation and record aggregation with Vitest"
```

---

### Task 5: Friendships — migration, hooks, friends screen

**Files:**
- Create: `supabase/migrations/0002_friendships.sql`
- Create: `lib/hooks/useProfile.ts`, `lib/hooks/useFriends.ts`, `lib/hooks/useFriends.test.ts` (pure helper only)
- Replace: `app/(app)/friends.tsx`

**Interfaces:**
- Consumes: `supabase`, `useAuth`, `profiles` table
- Produces:
  - DB table `public.friendships(id, requester_id, addressee_id, status, created_at)`, `status in ('pending','accepted')`
  - `Profile = { id: string; username: string; display_name: string }` (exported from `lib/hooks/useProfile.ts`)
  - `useProfile(id: string)` → TanStack query of `Profile`
  - `useFriends()` → `{ friends: Profile[]; incoming: { friendshipId: string; from: Profile }[] }`
  - `toFriendList(rows: FriendshipRow[], myId: string)` pure helper (same return shape), where `FriendshipRow = { id: string; status: 'pending' | 'accepted'; requester: Profile; addressee: Profile }`
  - Mutations: `useSendFriendRequest()` (input: addressee profile id), `useAcceptFriendRequest()` (input: friendship id)

- [ ] **Step 1: Write migration 0002**

Create `supabase/migrations/0002_friendships.sql`:

```sql
create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

alter table public.friendships enable row level security;

create policy "participants can read their friendships"
  on public.friendships for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

create policy "requester can send a pending request"
  on public.friendships for insert to authenticated
  with check (requester_id = (select auth.uid()) and status = 'pending');

create policy "addressee can accept"
  on public.friendships for update to authenticated
  using (addressee_id = (select auth.uid()))
  with check (status = 'accepted');
```

Apply via MCP `apply_migration` (name `friendships`). Verify with `execute_sql`:
`select count(*) from public.friendships;` → Expected: `0`.

- [ ] **Step 2: Profile hook**

Create `lib/hooks/useProfile.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../supabase';

export type Profile = { id: string; username: string; display_name: string };

export function useProfile(id: string) {
  return useQuery({
    queryKey: ['profile', id],
    queryFn: async (): Promise<Profile> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
  });
}
```

- [ ] **Step 3: Failing test for toFriendList**

Create `lib/hooks/useFriends.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toFriendList, type FriendshipRow } from './useFriends';

const alice = { id: 'a', username: 'alice', display_name: 'alice' };
const bob = { id: 'b', username: 'bob', display_name: 'bob' };
const carol = { id: 'c', username: 'carol', display_name: 'carol' };

describe('toFriendList', () => {
  it('splits accepted friends and incoming pending requests', () => {
    const rows: FriendshipRow[] = [
      { id: 'f1', status: 'accepted', requester: alice, addressee: bob },
      { id: 'f2', status: 'pending', requester: carol, addressee: alice },
      { id: 'f3', status: 'pending', requester: alice, addressee: carol },
    ];
    const result = toFriendList(rows, 'a');
    expect(result.friends).toEqual([bob]);
    expect(result.incoming).toEqual([{ friendshipId: 'f2', from: carol }]);
  });
});
```

Run: `npm test` → Expected: FAIL (`Cannot find module './useFriends'`).

- [ ] **Step 4: Friends hooks**

Create `lib/hooks/useFriends.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import type { Profile } from './useProfile';

export type FriendshipRow = {
  id: string;
  status: 'pending' | 'accepted';
  requester: Profile;
  addressee: Profile;
};

export function toFriendList(rows: FriendshipRow[], myId: string) {
  const friends: Profile[] = [];
  const incoming: { friendshipId: string; from: Profile }[] = [];
  for (const row of rows) {
    if (row.status === 'accepted') {
      friends.push(row.requester.id === myId ? row.addressee : row.requester);
    } else if (row.addressee.id === myId) {
      incoming.push({ friendshipId: row.id, from: row.requester });
    }
  }
  return { friends, incoming };
}

const FRIENDSHIP_SELECT =
  'id, status, requester:profiles!friendships_requester_id_fkey(id, username, display_name), addressee:profiles!friendships_addressee_id_fkey(id, username, display_name)';

export function useFriends() {
  const { session } = useAuth();
  const myId = session!.user.id;
  return useQuery({
    queryKey: ['friendships'],
    queryFn: async () => {
      const { data, error } = await supabase.from('friendships').select(FRIENDSHIP_SELECT);
      if (error) throw error;
      return toFriendList(data as unknown as FriendshipRow[], myId);
    },
  });
}

export function useSendFriendRequest() {
  const { session } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (addresseeId: string) => {
      const { error } = await supabase
        .from('friendships')
        .insert({ requester_id: session!.user.id, addressee_id: addresseeId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['friendships'] }),
  });
}

export function useAcceptFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (friendshipId: string) => {
      const { error } = await supabase
        .from('friendships')
        .update({ status: 'accepted' })
        .eq('id', friendshipId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['friendships'] }),
  });
}
```

Run: `npm test` → Expected: all passing (8 tests).

- [ ] **Step 5: Friends screen**

Replace `app/(app)/friends.tsx`:

```tsx
import { useState } from 'react';
import { Alert, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import type { Profile } from '../../lib/hooks/useProfile';
import { useAcceptFriendRequest, useFriends, useSendFriendRequest } from '../../lib/hooks/useFriends';

export default function Friends() {
  const { session } = useAuth();
  const { data } = useFriends();
  const sendRequest = useSendFriendRequest();
  const accept = useAcceptFriendRequest();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Profile[]>([]);

  async function search() {
    const { data: rows, error } = await supabase
      .from('profiles')
      .select('id, username, display_name')
      .ilike('username', `%${query}%`)
      .neq('id', session!.user.id)
      .limit(10);
    if (error) Alert.alert('Search failed', error.message);
    else setResults(rows);
  }

  return (
    <View className="flex-1 gap-4 bg-white p-6 pt-16">
      <Text className="text-2xl font-bold">Friends</Text>

      <View className="flex-row gap-2">
        <TextInput
          className="flex-1 rounded-lg border border-gray-300 p-3"
          placeholder="search username"
          autoCapitalize="none"
          value={query}
          onChangeText={setQuery}
        />
        <Pressable className="justify-center rounded-lg bg-emerald-600 px-4" onPress={search}>
          <Text className="font-semibold text-white">Search</Text>
        </Pressable>
      </View>

      {results.map((p) => (
        <View key={p.id} className="flex-row items-center justify-between rounded-lg border border-gray-200 p-3">
          <Text>{p.username}</Text>
          <Pressable
            className="rounded bg-emerald-600 px-3 py-1"
            onPress={() =>
              sendRequest.mutate(p.id, {
                onError: (e) => Alert.alert('Request failed', e.message),
              })
            }
          >
            <Text className="text-white">Add</Text>
          </Pressable>
        </View>
      ))}

      {data && data.incoming.length > 0 && (
        <>
          <Text className="font-semibold">Requests</Text>
          {data.incoming.map((r) => (
            <View key={r.friendshipId} className="flex-row items-center justify-between rounded-lg border border-amber-300 p-3">
              <Text>{r.from.username}</Text>
              <Pressable
                className="rounded bg-amber-500 px-3 py-1"
                onPress={() => accept.mutate(r.friendshipId)}
              >
                <Text className="text-white">Accept</Text>
              </Pressable>
            </View>
          ))}
        </>
      )}

      <Text className="font-semibold">My friends</Text>
      <FlatList
        data={data?.friends ?? []}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <Link href={`/profile/${item.id}`} className="rounded-lg border border-gray-200 p-3">
            <Text>{item.username}</Text>
          </Link>
        )}
        ListEmptyComponent={<Text className="text-gray-400">No friends yet</Text>}
      />
    </View>
  );
}
```

- [ ] **Step 6: Verify manually**

With the app running: as alice, search `bob`, tap Add. Sign out is not built — instead verify via MCP `execute_sql`:
`select status from public.friendships;` → Expected: `pending`.
Then as bob (second simulator or sign in as bob), Friends tab shows the request; tap Accept → bob's friends list shows `alice`. Re-check SQL → Expected: `accepted`.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit && npm test
git add -A
git commit -m "feat: friend requests and friends list"
```

---

### Task 6: Matches — migration, hooks, log-match screen

**Files:**
- Create: `supabase/migrations/0003_matches.sql`
- Create: `lib/hooks/useMatches.ts`
- Replace: `app/(app)/log-match.tsx`

**Interfaces:**
- Consumes: `deriveOutcomes` (lib/outcomes.ts), `MatchRow` (lib/types.ts), `useFriends`, `useAuth`, `supabase`
- Produces:
  - DB tables `public.matches` and `public.match_participants` (shapes match `MatchRow`/`ParticipantRow` in `lib/types.ts`)
  - `useMatches()` → TanStack query returning `MatchRow[]` ordered newest first, query key `['matches']`
  - `useLogMatch()` → mutation with input `{ sportId: string; matchType: 'official' | 'friendly'; opponentId: string; myScore: number; theirScore: number }`
  - `useSports()` → query returning `{ id: string; name: string }[]`

- [ ] **Step 1: Write migration 0003**

Create `supabase/migrations/0003_matches.sql`:

```sql
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id),
  match_type text not null default 'official' check (match_type in ('official', 'friendly')),
  played_at date not null default current_date,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.match_participants (
  match_id uuid not null references public.matches(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  score integer not null default 0 check (score >= 0),
  outcome text not null check (outcome in ('win', 'loss', 'draw')),
  primary key (match_id, profile_id)
);

alter table public.matches enable row level security;
alter table public.match_participants enable row level security;

create function public.is_match_participant(m uuid)
returns boolean
language sql security definer set search_path = ''
stable
as $$
  select exists (
    select 1 from public.match_participants
    where match_id = m and profile_id = (select auth.uid())
  );
$$;

create policy "participants can read their matches"
  on public.matches for select to authenticated
  using (public.is_match_participant(id) or created_by = (select auth.uid()));

create policy "creator can insert a match"
  on public.matches for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "participants can read match participants"
  on public.match_participants for select to authenticated
  using (public.is_match_participant(match_id));

create policy "match creator can insert participants"
  on public.match_participants for insert to authenticated
  with check (
    exists (
      select 1 from public.matches
      where id = match_id and created_by = (select auth.uid())
    )
  );
```

Apply via MCP `apply_migration` (name `matches`). Verify with `execute_sql`:
`select count(*) from public.matches;` → Expected: `0`.

- [ ] **Step 2: Match hooks**

Create `lib/hooks/useMatches.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { deriveOutcomes } from '../outcomes';
import type { MatchRow, MatchType } from '../types';

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
        .select(
          'id, sport_id, match_type, played_at, participants:match_participants(profile_id, score, outcome)'
        )
        .order('played_at', { ascending: false });
      if (error) throw error;
      return data as unknown as MatchRow[];
    },
  });
}

export type LogMatchInput = {
  sportId: string;
  matchType: MatchType;
  opponentId: string;
  myScore: number;
  theirScore: number;
};

export function useLogMatch() {
  const { session } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogMatchInput) => {
      const myId = session!.user.id;
      const { data: match, error } = await supabase
        .from('matches')
        .insert({ sport_id: input.sportId, match_type: input.matchType, created_by: myId })
        .select('id')
        .single();
      if (error) throw error;
      const { mine, theirs } = deriveOutcomes(input.myScore, input.theirScore);
      const { error: pError } = await supabase.from('match_participants').insert([
        { match_id: match.id, profile_id: myId, score: input.myScore, outcome: mine },
        { match_id: match.id, profile_id: input.opponentId, score: input.theirScore, outcome: theirs },
      ]);
      if (pError) throw pError;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matches'] }),
  });
}
```

Run: `npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 3: Log-match screen**

Replace `app/(app)/log-match.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { z } from 'zod';
import { useFriends } from '../../lib/hooks/useFriends';
import { useLogMatch, useSports } from '../../lib/hooks/useMatches';
import type { MatchType } from '../../lib/types';

const schema = z.object({
  sportId: z.string().min(1, 'Pick a sport'),
  opponentId: z.string().min(1, 'Pick an opponent'),
  myScore: z.number().int().min(0),
  theirScore: z.number().int().min(0),
});

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

export default function LogMatch() {
  const { data: sports } = useSports();
  const { data: friendData } = useFriends();
  const logMatch = useLogMatch();
  const [sportId, setSportId] = useState('');
  const [opponentId, setOpponentId] = useState('');
  const [matchType, setMatchType] = useState<MatchType>('official');
  const [myScore, setMyScore] = useState('');
  const [theirScore, setTheirScore] = useState('');

  function onSubmit() {
    const parsed = schema.safeParse({
      sportId,
      opponentId,
      myScore: Number(myScore),
      theirScore: Number(theirScore),
    });
    if (!parsed.success) {
      Alert.alert('Invalid match', parsed.error.issues[0].message);
      return;
    }
    logMatch.mutate(
      { ...parsed.data, matchType },
      {
        onSuccess: () => {
          setSportId(''); setOpponentId(''); setMyScore(''); setTheirScore('');
          router.push('/');
        },
        onError: (e) => Alert.alert('Failed to log match', e.message),
      }
    );
  }

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16" contentContainerClassName="gap-4">
      <Text className="text-2xl font-bold">Log a match</Text>

      <Text className="font-semibold">Sport</Text>
      <View className="flex-row flex-wrap gap-2">
        {(sports ?? []).map((s) => (
          <Chip key={s.id} label={s.name} selected={sportId === s.id} onPress={() => setSportId(s.id)} />
        ))}
      </View>

      <Text className="font-semibold">Opponent</Text>
      <View className="flex-row flex-wrap gap-2">
        {(friendData?.friends ?? []).map((f) => (
          <Chip key={f.id} label={f.username} selected={opponentId === f.id} onPress={() => setOpponentId(f.id)} />
        ))}
        {(friendData?.friends ?? []).length === 0 && (
          <Text className="text-gray-400">Add a friend first</Text>
        )}
      </View>

      <Text className="font-semibold">Type</Text>
      <View className="flex-row gap-2">
        <Chip label="Official" selected={matchType === 'official'} onPress={() => setMatchType('official')} />
        <Chip label="Friendly" selected={matchType === 'friendly'} onPress={() => setMatchType('friendly')} />
      </View>

      <View className="flex-row gap-3">
        <View className="flex-1">
          <Text className="font-semibold">My score</Text>
          <TextInput
            className="rounded-lg border border-gray-300 p-3"
            keyboardType="number-pad"
            value={myScore}
            onChangeText={setMyScore}
          />
        </View>
        <View className="flex-1">
          <Text className="font-semibold">Their score</Text>
          <TextInput
            className="rounded-lg border border-gray-300 p-3"
            keyboardType="number-pad"
            value={theirScore}
            onChangeText={setTheirScore}
          />
        </View>
      </View>

      <Pressable className="rounded-lg bg-emerald-600 p-4" disabled={logMatch.isPending} onPress={onSubmit}>
        <Text className="text-center font-semibold text-white">
          {logMatch.isPending ? 'Saving…' : 'Save match'}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
```

- [ ] **Step 4: Verify manually**

As alice: Log Match tab → pick Tennis, opponent bob, Official, 2–0 → Save. Verify via MCP `execute_sql`:
`select outcome, score from public.match_participants order by score desc;`
Expected: two rows — `win, 2` and `loss, 0`.

- [ ] **Step 5: Typecheck, test, commit**

```bash
npx tsc --noEmit && npm test
git add -A
git commit -m "feat: match logging with derived outcomes and RLS"
```

---

### Task 7: Profiles — own record on home, friend head-to-head page

**Files:**
- Replace: `app/(app)/index.tsx`
- Replace: `app/(app)/profile/[id].tsx`

**Interfaces:**
- Consumes: `useAuth`, `useProfile`, `useMatches`, `computeRecord`, `filterHeadToHead`, `useSports`, `supabase` (sign out)
- Produces: the finished slice — no downstream consumers.

- [ ] **Step 1: Shared record display component inside index**

Replace `app/(app)/index.tsx`:

```tsx
import { FlatList, Pressable, Text, View } from 'react-native';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { useProfile } from '../../lib/hooks/useProfile';
import { useMatches } from '../../lib/hooks/useMatches';
import { computeRecord } from '../../lib/records';

export function RecordList({ records }: { records: ReturnType<typeof computeRecord> }) {
  if (records.length === 0) {
    return <Text className="text-gray-400">No official matches yet</Text>;
  }
  return (
    <View className="gap-2">
      {records.map((r) => (
        <View key={r.sportId} className="flex-row justify-between rounded-lg border border-gray-200 p-3">
          <Text className="font-semibold capitalize">{r.sportId.replace('_', ' ')}</Text>
          <Text>
            {r.wins}W - {r.losses}L - {r.draws}D
          </Text>
        </View>
      ))}
    </View>
  );
}

export default function Home() {
  const { session } = useAuth();
  const myId = session!.user.id;
  const { data: profile } = useProfile(myId);
  const { data: matches } = useMatches();
  const records = computeRecord(matches ?? [], myId);

  return (
    <View className="flex-1 gap-4 bg-white p-6 pt-16">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl font-bold">{profile?.username ?? '…'}</Text>
        <Pressable onPress={() => supabase.auth.signOut()}>
          <Text className="text-red-500">Sign out</Text>
        </Pressable>
      </View>

      <Text className="font-semibold">My record</Text>
      <RecordList records={records} />

      <Text className="font-semibold">Recent matches</Text>
      <FlatList
        data={matches ?? []}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => {
          const me = item.participants.find((p) => p.profile_id === myId);
          return (
            <View className="flex-row justify-between rounded-lg border border-gray-200 p-3">
              <Text className="capitalize">{item.sport_id.replace('_', ' ')}</Text>
              <Text className={me?.outcome === 'win' ? 'text-emerald-600' : me?.outcome === 'loss' ? 'text-red-500' : 'text-gray-500'}>
                {me?.outcome ?? '?'} · {item.match_type}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={<Text className="text-gray-400">No matches logged</Text>}
      />
    </View>
  );
}
```

- [ ] **Step 2: Friend profile with head-to-head**

Replace `app/(app)/profile/[id].tsx`:

```tsx
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../lib/auth';
import { useProfile } from '../../../lib/hooks/useProfile';
import { useMatches } from '../../../lib/hooks/useMatches';
import { computeRecord, filterHeadToHead } from '../../../lib/records';
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
      <Text className="text-gray-400">
        {headToHead.length} match{headToHead.length === 1 ? '' : 'es'} together
      </Text>
    </View>
  );
}
```

- [ ] **Step 3: End-to-end manual verification (the whole slice)**

Fresh run-through with the app (`npx expo start`):
1. Sign in as alice → home shows her tennis record `1W - 0L - 0D` (from Task 6's match) and the match in Recent.
2. Friends tab → tap bob → his profile shows "Their record vs you: tennis 0W - 1L - 0D" and "1 match together".
3. Sign out → sign in as bob → home shows tennis `0W - 1L - 0D` and the same match in Recent. **This is the "both profiles" proof.**
4. Log a friendly match as bob vs alice (any score) → home Recent shows it, but the record numbers don't change (friendlies excluded).

Expected: all four checks pass.

- [ ] **Step 4: Typecheck, test, commit**

```bash
npx tsc --noEmit && npm test
git add -A
git commit -m "feat: profile records and head-to-head view"
```

---

### Task 8: Close out the milestone

**Files:**
- Modify: `CLAUDE.md` (Status section)

**Interfaces:**
- Consumes: everything prior
- Produces: updated project status for future sessions.

- [ ] **Step 1: Update CLAUDE.md status**

In `CLAUDE.md`, replace the sentence "The repo is currently empty — nothing has been built yet." with:

```markdown
**Built so far (vertical slice v1):** Expo + TypeScript + NativeWind app with Supabase email auth, friend requests, simple match logging (winner/score, official vs friendly), and per-sport W-L-D records with head-to-head profile views. Schema in `supabase/migrations/`. Dev backend: Supabase project `sportly-dev`. See `docs/superpowers/plans/2026-07-07-vertical-slice-v1.md`.
```

- [ ] **Step 2: Full verification sweep**

```bash
npx tsc --noEmit && npm test
```

Expected: clean typecheck, 8 tests passing.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: record vertical slice v1 completion"
```
