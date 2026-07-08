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
