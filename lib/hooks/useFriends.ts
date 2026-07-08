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
