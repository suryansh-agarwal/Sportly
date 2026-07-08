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
