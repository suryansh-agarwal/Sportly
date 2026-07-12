import { FlatList, Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { useProfile } from '../../lib/hooks/useProfile';
import { useMatches } from '../../lib/hooks/useMatches';
import { useLiveMatches } from '../../lib/hooks/useLive';
import { computeRecord } from '../../lib/records';
import { matchSummary } from '../../lib/matchSummary';

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
  const { data: liveMatches } = useLiveMatches();

  return (
    <View className="flex-1 gap-4 bg-white p-6 pt-16">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl font-bold">{profile?.username ?? '…'}</Text>
        <Pressable onPress={() => supabase.auth.signOut()}>
          <Text className="text-red-500">Sign out</Text>
        </Pressable>
      </View>

      {(liveMatches ?? []).length > 0 && (
        <>
          <Text className="font-semibold">In progress</Text>
          {(liveMatches ?? []).map((lm) => (
            <Link key={lm.id} href={`/live/${lm.id}`} asChild>
              <Pressable className="flex-row items-center justify-between rounded-lg border border-red-200 p-3">
                <View>
                  <Text className="capitalize">{lm.sport_id.replace('_', ' ')}</Text>
                  <Text className="text-xs text-gray-400" numberOfLines={1}>
                    {lm.participants.filter((p) => p.side === 'a').map((p) => p.profile.username).join(', ')}
                    {' vs '}
                    {lm.participants.filter((p) => p.side === 'b').map((p) => p.profile.username).join(', ')}
                  </Text>
                </View>
                <Text className="font-semibold text-red-500">LIVE</Text>
              </Pressable>
            </Link>
          ))}
        </>
      )}

      <Text className="font-semibold">My record</Text>
      <RecordList records={records} />

      <Text className="font-semibold">Recent matches</Text>
      <FlatList
        data={matches ?? []}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => {
          const me = item.participants.find((p) => p.profile_id === myId);
          return (
            <Link href={`/match/${item.id}`} asChild>
              <Pressable className="flex-row items-center justify-between rounded-lg border border-gray-200 p-3">
                <View>
                  <Text className="capitalize">{item.sport_id.replace('_', ' ')}</Text>
                  <Text className="text-xs text-gray-400">
                    {item.format === 'ffa' ? 'free-for-all' : item.format} · {item.match_type}
                  </Text>
                </View>
                <View className="items-end">
                  <Text className={me?.outcome === 'win' ? 'text-emerald-600' : me?.outcome === 'loss' ? 'text-red-500' : 'text-gray-500'}>
                    {me?.outcome ?? '?'}
                  </Text>
                  <Text className="text-gray-500">{matchSummary(item, myId)}</Text>
                </View>
              </Pressable>
            </Link>
          );
        }}
        ListEmptyComponent={<Text className="text-gray-400">No matches logged</Text>}
      />
    </View>
  );
}
