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
