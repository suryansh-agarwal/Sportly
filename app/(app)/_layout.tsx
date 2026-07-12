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
      <Tabs.Screen name="tournaments" options={{ title: 'Tournaments' }} />
      <Tabs.Screen name="profile/[id]" options={{ href: null }} />
      <Tabs.Screen name="match/[id]" options={{ href: null }} />
      <Tabs.Screen name="live/[id]" options={{ href: null }} />
      <Tabs.Screen name="tournament/[id]" options={{ href: null }} />
      <Tabs.Screen name="join/[token]" options={{ href: null }} />
    </Tabs>
  );
}
