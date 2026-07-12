import { Alert, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useJoinByToken, usePreviewByToken } from '../../../lib/hooks/useTournaments';

export default function JoinByToken() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { data: preview, isError, isLoading } = usePreviewByToken(token ?? '');
  const join = useJoinByToken();

  if (isLoading) return <View className="flex-1 bg-white" />;
  if (isError || !preview) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Text className="text-gray-400">This invite link is not valid</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center gap-4 bg-white p-6">
      <Text className="text-2xl font-bold">{preview.name}</Text>
      <Text className="capitalize text-gray-400">
        {preview.sport_id.replace('_', ' ')} · {preview.format.replace('_', ' ')} · hosted by {preview.creator}
      </Text>
      <Text className="text-gray-500">{preview.player_count} players so far</Text>
      {preview.status === 'draft' ? (
        <Pressable
          className="w-full rounded-lg bg-emerald-600 p-4"
          disabled={join.isPending}
          onPress={() =>
            join.mutate(token!, {
              onSuccess: (tid) => router.replace(`/tournament/${tid}`),
              onError: (e) => Alert.alert('Could not join', e.message),
            })
          }
        >
          <Text className="text-center font-semibold text-white">
            {join.isPending ? 'Joining…' : 'Join tournament'}
          </Text>
        </Pressable>
      ) : (
        <Text className="text-gray-400">This tournament has already started</Text>
      )}
    </View>
  );
}
