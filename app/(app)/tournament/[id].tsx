import { Alert, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../lib/auth';
import { useFriends } from '../../../lib/hooks/useFriends';
import { useStartLiveMatch } from '../../../lib/hooks/useLive';
import {
  useCancelTournament, useInvite, useStartTournament, useTournament,
} from '../../../lib/hooks/useTournaments';
import { computeStandings } from '../../../lib/tournaments/standings';
import { bracketRounds } from '../../../lib/tournaments/bracket';
import { SCORING_CONFIGS } from '../../../lib/scoring/configs';
import { getSport } from '../../../lib/sports';

export default function TournamentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const myId = session!.user.id;
  const { data: t, isError } = useTournament(id ?? '');
  const { data: friendData } = useFriends();
  const invite = useInvite();
  const start = useStartTournament();
  const cancel = useCancelTournament();
  const startLive = useStartLiveMatch();

  if (isError) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Text className="text-gray-400">Couldn't load this tournament</Text>
      </View>
    );
  }
  if (!t) return <View className="flex-1 bg-white" />;

  const isCreator = t.created_by === myId;
  const accepted = t.players.filter((p) => p.status === 'accepted');
  const nameOf = (pid: string | null) =>
    pid ? t.players.find((p) => p.profile_id === pid)?.profile.username ?? '?' : 'TBD';
  const minPlayers = t.format === 'round_robin' ? 3 : 2;
  const invitableFriends = (friendData?.friends ?? []).filter(
    (f) => !t.players.some((p) => p.profile_id === f.id)
  );

  const scoreDiffs: Record<string, number> = {};
  for (const f of t.fixtures) {
    if (f.status !== 'done' || !f.player_a || !f.player_b) continue;
    if (f.score_a == null || f.score_b == null) continue;
    scoreDiffs[f.player_a] = (scoreDiffs[f.player_a] ?? 0) + f.score_a - f.score_b;
    scoreDiffs[f.player_b] = (scoreDiffs[f.player_b] ?? 0) + f.score_b - f.score_a;
  }
  const standings = computeStandings(
    t.fixtures, scoreDiffs,
    accepted.map((p) => ({ profileId: p.profile_id, joinedAt: p.created_at }))
  );
  const rounds = bracketRounds(t.fixtures);

  function onShare() {
    Share.share({ message: `Join my Sportly tournament "${t!.name}": sportly://join/${t!.join_token}` });
  }

  function onStart() {
    start.mutate(id!, { onError: (e) => Alert.alert('Could not start', e.message) });
  }

  function onCancel() {
    Alert.alert('Cancel tournament?', 'Fixtures die; recorded matches remain.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Cancel it', style: 'destructive',
        onPress: () => cancel.mutate(id!, { onError: (e) => Alert.alert('Failed', e.message) }) },
    ]);
  }

  function onLogFixture(fixtureId: string, opponentId: string) {
    router.push({
      pathname: '/log-match',
      params: { fixtureId, tournamentId: id!, sportId: t!.sport_id, opponentId },
    });
  }

  function onLiveFixture(fixtureId: string, opponentId: string) {
    startLive.mutate(
      {
        sportId: t!.sport_id, matchType: 'official', format: '1v1',
        participants: [
          { profile_id: myId, side: 'a' }, { profile_id: opponentId, side: 'b' },
        ],
      },
      {
        onSuccess: (liveId) =>
          router.push({ pathname: '/live/[id]', params: { id: liveId, fixture: fixtureId, tournament: id! } }),
        onError: (e) => Alert.alert('Could not start live match', e.message),
      }
    );
  }

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16" contentContainerClassName="gap-4 pb-12">
      <Text className="text-2xl font-bold">{t.name}</Text>
      <Text className="capitalize text-gray-400">
        {getSport(t.sport_id)?.name ?? t.sport_id} · {t.format.replace('_', ' ')} · {t.status}
      </Text>

      {t.status === 'completed' && t.winner_id && (
        <View className="rounded-xl bg-emerald-50 p-4">
          <Text className="text-center text-lg font-bold text-emerald-700">
            🏆 {nameOf(t.winner_id)} wins!
          </Text>
        </View>
      )}

      <Text className="font-semibold">Players ({accepted.length})</Text>
      <View className="flex-row flex-wrap gap-2">
        {t.players.map((p) => (
          <Link key={p.profile_id} href={`/profile/${p.profile_id}`} asChild>
            <Pressable className={`rounded-full border px-3 py-1 ${p.status === 'accepted' ? 'border-emerald-300' : 'border-gray-200'}`}>
              <Text className={p.status === 'accepted' ? 'text-emerald-700' : 'text-gray-400'}>
                {p.profile.username}{p.status === 'invited' ? ' (invited)' : p.status === 'declined' ? ' (declined)' : ''}
              </Text>
            </Pressable>
          </Link>
        ))}
      </View>

      {t.status === 'draft' && (
        <>
          {isCreator && invitableFriends.length > 0 && (
            <>
              <Text className="font-semibold">Invite friends</Text>
              <View className="flex-row flex-wrap gap-2">
                {invitableFriends.map((f) => (
                  <Pressable
                    key={f.id}
                    className="rounded-full border border-gray-300 px-3 py-1"
                    onPress={() =>
                      invite.mutate(
                        { tournamentId: id!, profileId: f.id },
                        { onError: (e) => Alert.alert('Invite failed', e.message) }
                      )
                    }
                  >
                    <Text className="text-gray-700">+ {f.username}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
          <Pressable className="rounded-lg border border-emerald-600 p-3" onPress={onShare}>
            <Text className="text-center font-semibold text-emerald-700">Share join link</Text>
          </Pressable>
          {isCreator && (
            <Pressable
              className={`rounded-lg p-4 ${accepted.length >= minPlayers ? 'bg-emerald-600' : 'bg-gray-300'}`}
              disabled={accepted.length < minPlayers || start.isPending}
              onPress={onStart}
            >
              <Text className="text-center font-semibold text-white">
                {start.isPending ? 'Starting…' : `Start (${accepted.length}/${minPlayers} min)`}
              </Text>
            </Pressable>
          )}
        </>
      )}

      {t.status !== 'draft' && t.format === 'round_robin' && (
        <>
          <Text className="font-semibold">Standings</Text>
          <View className="rounded-xl border border-gray-200">
            <View className="flex-row border-b border-gray-200 p-2">
              <Text className="flex-1 font-semibold text-gray-500">Player</Text>
              {['P', 'W', 'D', 'L', 'Pts'].map((h) => (
                <Text key={h} className="w-10 text-center font-semibold text-gray-500">{h}</Text>
              ))}
            </View>
            {standings.map((row, i) => (
              <View key={row.profileId} className={`flex-row p-2 ${i === 0 && t.status === 'completed' ? 'bg-emerald-50' : ''}`}>
                <Text className="flex-1" numberOfLines={1}>{nameOf(row.profileId)}</Text>
                {[row.played, row.wins, row.draws, row.losses, row.points].map((v, j) => (
                  <Text key={j} className="w-10 text-center">{v}</Text>
                ))}
              </View>
            ))}
          </View>
        </>
      )}

      {t.status !== 'draft' && t.format === 'knockout' && (
        <>
          <Text className="font-semibold">Bracket</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-4">
              {rounds.map((round, ri) => (
                <View key={ri} className="justify-around gap-2">
                  <Text className="text-center text-xs text-gray-400">
                    {ri === rounds.length - 1 && rounds[ri].length === 1 ? 'Final' : `Round ${ri + 1}`}
                  </Text>
                  {round.map((f) => (
                    <View key={f.id} className="w-40 rounded-lg border border-gray-200 p-2">
                      {[f.player_a, f.player_b].map((pid, side) => (
                        <Text
                          key={side}
                          numberOfLines={1}
                          className={f.winner_id && pid === f.winner_id ? 'font-bold text-emerald-700' : pid ? '' : 'text-gray-300'}
                        >
                          {f.player_b === null && f.status === 'done' && side === 1 ? 'bye' : nameOf(pid)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        </>
      )}

      {t.status === 'active' && (
        <>
          <Text className="font-semibold">Fixtures</Text>
          {t.fixtures.filter((f) => f.status === 'pending' && f.player_a && f.player_b).map((f) => {
            const isMine = f.player_a === myId || f.player_b === myId;
            const opponent = f.player_a === myId ? f.player_b : f.player_a;
            return (
              <View
                key={f.id}
                className={`rounded-lg border p-3 ${isMine ? 'border-emerald-300' : 'border-gray-200'}`}
              >
                <Text>
                  {nameOf(f.player_a)} vs {nameOf(f.player_b)}
                  <Text className="text-gray-400">  · round {f.round}</Text>
                </Text>
                {isMine && opponent && (
                  <View className="mt-2 flex-row gap-2">
                    <Pressable
                      className="flex-1 rounded bg-emerald-600 p-2"
                      onPress={() => onLogFixture(f.id, opponent)}
                    >
                      <Text className="text-center text-white">Log result</Text>
                    </Pressable>
                    {SCORING_CONFIGS[t.sport_id] && (
                      <Pressable
                        className="flex-1 rounded border border-red-400 p-2"
                        disabled={startLive.isPending}
                        onPress={() => onLiveFixture(f.id, opponent)}
                      >
                        <Text className="text-center text-red-500">● Score live</Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            );
          })}
          {isCreator && (
            <Pressable className="rounded-lg border border-red-300 p-3" onPress={onCancel}>
              <Text className="text-center text-red-500">Cancel tournament</Text>
            </Pressable>
          )}
        </>
      )}

      {t.fixtures.some((f) => f.status === 'done' && f.match_id) && (
        <>
          <Text className="font-semibold">Played</Text>
          {t.fixtures.filter((f) => f.status === 'done' && f.match_id).map((f) => {
            const row = (
              <Pressable className="flex-row justify-between rounded-lg border border-gray-200 p-3">
                <Text numberOfLines={1}>
                  {nameOf(f.player_a)} vs {nameOf(f.player_b)}
                </Text>
                <Text className="text-gray-500">
                  {f.score_a != null && f.score_b != null ? `${f.score_a}–${f.score_b}` : ''}
                </Text>
              </Pressable>
            );
            // matches RLS is participant-only: only link into the match detail when I played in it
            const mine = f.player_a === myId || f.player_b === myId;
            return mine ? (
              <Link key={f.id} href={`/match/${f.match_id}`} asChild>{row}</Link>
            ) : (
              <View key={f.id}>{row}</View>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}
