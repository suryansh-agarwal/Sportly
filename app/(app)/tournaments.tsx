import { useState } from 'react';
import { Alert, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Link, router } from 'expo-router';
import { useSports } from '../../lib/hooks/useMatches';
import { useCreateTournament, useRespondToInvite, useTournaments } from '../../lib/hooks/useTournaments';

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

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-gray-500', active: 'text-emerald-600', completed: 'text-blue-600', cancelled: 'text-red-400',
};

export default function Tournaments() {
  const { data } = useTournaments();
  const { data: sports } = useSports();
  const create = useCreateTournament();
  const respond = useRespondToInvite();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [sportId, setSportId] = useState('');
  const [format, setFormat] = useState<'round_robin' | 'knockout'>('round_robin');

  function onCreate() {
    if (!name.trim() || !sportId) {
      Alert.alert('Hold on', 'Name and sport are required');
      return;
    }
    create.mutate(
      { name: name.trim(), sportId, format },
      {
        onSuccess: (id) => {
          setCreating(false); setName(''); setSportId('');
          router.push(`/tournament/${id}`);
        },
        onError: (e) => Alert.alert('Could not create', e.message),
      }
    );
  }

  return (
    <View className="flex-1 gap-4 bg-white p-6 pt-16">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl font-bold">Tournaments</Text>
        <Pressable className="rounded-lg bg-emerald-600 px-4 py-2" onPress={() => setCreating(!creating)}>
          <Text className="font-semibold text-white">{creating ? 'Close' : 'Create'}</Text>
        </Pressable>
      </View>

      {creating && (
        <View className="gap-3 rounded-xl border border-gray-200 p-4">
          <TextInput
            className="rounded-lg border border-gray-300 p-3"
            placeholder="Tournament name"
            value={name}
            onChangeText={setName}
          />
          <View className="flex-row flex-wrap gap-2">
            {(sports ?? []).map((s) => (
              <Chip key={s.id} label={s.name} selected={sportId === s.id} onPress={() => setSportId(s.id)} />
            ))}
          </View>
          <View className="flex-row gap-2">
            <Chip label="Round robin" selected={format === 'round_robin'} onPress={() => setFormat('round_robin')} />
            <Chip label="Knockout" selected={format === 'knockout'} onPress={() => setFormat('knockout')} />
          </View>
          <Pressable className="rounded-lg bg-emerald-600 p-3" disabled={create.isPending} onPress={onCreate}>
            <Text className="text-center font-semibold text-white">
              {create.isPending ? 'Creating…' : 'Create tournament'}
            </Text>
          </Pressable>
        </View>
      )}

      {(data?.invites ?? []).length > 0 && (
        <>
          <Text className="font-semibold">Invites</Text>
          {(data?.invites ?? []).map((t) => (
            <View key={t.id} className="flex-row items-center justify-between rounded-lg border border-amber-300 p-3">
              <View>
                <Text className="font-semibold">{t.name}</Text>
                <Text className="text-xs capitalize text-gray-400">
                  {t.sport_id.replace('_', ' ')} · {t.format.replace('_', ' ')}
                </Text>
              </View>
              <View className="flex-row gap-2">
                <Pressable
                  className="rounded bg-emerald-600 px-3 py-1"
                  onPress={() => respond.mutate({ tournamentId: t.id, accept: true })}
                >
                  <Text className="text-white">Join</Text>
                </Pressable>
                <Pressable
                  className="rounded border border-gray-300 px-3 py-1"
                  onPress={() => respond.mutate({ tournamentId: t.id, accept: false })}
                >
                  <Text className="text-gray-500">Decline</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </>
      )}

      <Text className="font-semibold">My tournaments</Text>
      <FlatList
        data={data?.mine ?? []}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => (
          <Link href={`/tournament/${item.id}`} asChild>
            <Pressable className="flex-row items-center justify-between rounded-lg border border-gray-200 p-3">
              <View>
                <Text className="font-semibold">{item.name}</Text>
                <Text className="text-xs capitalize text-gray-400">
                  {item.sport_id.replace('_', ' ')} · {item.format.replace('_', ' ')}
                </Text>
              </View>
              <Text className={`capitalize ${STATUS_COLORS[item.status]}`}>{item.status}</Text>
            </Pressable>
          </Link>
        )}
        ListEmptyComponent={<Text className="text-gray-400">No tournaments yet</Text>}
      />
    </View>
  );
}
