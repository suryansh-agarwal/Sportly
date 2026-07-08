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
