import { describe, expect, it } from 'vitest';
import { toFriendList, type FriendshipRow } from './useFriends';

const alice = { id: 'a', username: 'alice', display_name: 'alice' };
const bob = { id: 'b', username: 'bob', display_name: 'bob' };
const carol = { id: 'c', username: 'carol', display_name: 'carol' };

describe('toFriendList', () => {
  it('splits accepted friends and incoming pending requests', () => {
    const rows: FriendshipRow[] = [
      { id: 'f1', status: 'accepted', requester: alice, addressee: bob },
      { id: 'f2', status: 'pending', requester: carol, addressee: alice },
      { id: 'f3', status: 'pending', requester: alice, addressee: carol },
    ];
    const result = toFriendList(rows, 'a');
    expect(result.friends).toEqual([bob]);
    expect(result.incoming).toEqual([{ friendshipId: 'f2', from: carol }]);
  });
});
