import { FlatList, Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../lib/auth';
import { useProfile } from '../../../lib/hooks/useProfile';
import { useMatches } from '../../../lib/hooks/useMatches';
import { computeRecord, filterHeadToHead } from '../../../lib/records';
import { matchSummary } from '../../../lib/matchSummary';
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
      <Text className="font-semibold">Matches together</Text>
      <FlatList
        data={headToHead}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <Link href={`/match/${item.id}`} asChild>
            <Pressable className="flex-row items-center justify-between rounded-lg border border-gray-200 p-3">
              <View>
                <Text className="capitalize">{item.sport_id.replace('_', ' ')}</Text>
                <Text className="text-xs text-gray-400">{item.played_at} · {item.match_type}</Text>
              </View>
              <Text className="text-gray-500">{matchSummary(item, myId)}</Text>
            </Pressable>
          </Link>
        )}
        ListEmptyComponent={<Text className="text-gray-400">No sided matches together yet</Text>}
      />
    </View>
  );
}
