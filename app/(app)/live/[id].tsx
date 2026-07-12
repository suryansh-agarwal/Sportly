import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../lib/auth';
import {
  useAbandonLiveMatch, useAwardPoint, useFinishLiveMatch, useLiveMatch, useUndoPoint,
} from '../../../lib/hooks/useLive';
import { foldEvents } from '../../../lib/scoring/engine';
import { SCORING_CONFIGS } from '../../../lib/scoring/configs';
import { getSport } from '../../../lib/sports';
import type { Side } from '../../../lib/scoring/types';
import { useRecordFixtureResult } from '../../../lib/hooks/useTournaments';

export default function LiveMatch() {
  const { id, fixture, tournament } = useLocalSearchParams<{ id: string; fixture?: string; tournament?: string }>();
  const { session } = useAuth();
  const myId = session!.user.id;
  const { data, isLoading } = useLiveMatch(id ?? '');
  const award = useAwardPoint(id ?? '');
  const undoPoint = useUndoPoint(id ?? '');
  const finish = useFinishLiveMatch();
  const abandon = useAbandonLiveMatch();
  const recordResult = useRecordFixtureResult();

  if (isLoading || !data) return <View className="flex-1 bg-white" />;
  const { match, events } = data;
  const config = SCORING_CONFIGS[match.sport_id];
  const sport = getSport(match.sport_id);
  if (!config) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Text className="text-gray-400">This sport has no live scoring</Text>
      </View>
    );
  }
  const state = foldEvents(config, events);
  const isParticipant = match.participants.some((p) => p.profile_id === myId);
  const names = (side: Side) =>
    match.participants.filter((p) => p.side === side).map((p) => p.profile.username).join(', ');
  const hasPoints = events.some((e) => e.type === 'point');

  if (match.status !== 'live') {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-white p-6">
        <Text className="text-xl font-semibold capitalize">{match.status}</Text>
        {match.finished_match_id && (
          <Link href={`/match/${match.finished_match_id}`} className="text-emerald-700">
            View the logged match
          </Link>
        )}
      </View>
    );
  }

  function onFinish() {
    finish.mutate(
      { liveMatchId: id!, scoreA: state.setsWon.a, scoreB: state.setsWon.b },
      {
        onSuccess: (matchId) => {
          if (fixture && tournament) {
            recordResult.mutate(
              { fixtureId: fixture, matchId, tournamentId: tournament },
              {
                onSuccess: () => router.replace(`/tournament/${tournament}`),
                onError: (e) => {
                  Alert.alert('Match saved, but fixture link failed', e.message);
                  router.replace(`/match/${matchId}`);
                },
              }
            );
          } else {
            router.replace(`/match/${matchId}`);
          }
        },
        onError: (e) => Alert.alert('Could not finish', e.message),
      }
    );
  }

  function onAbandon() {
    Alert.alert('Abandon match?', 'Nothing will be logged.', [
      { text: 'Keep playing', style: 'cancel' },
      {
        text: 'Abandon',
        style: 'destructive',
        onPress: () =>
          abandon.mutate(id!, {
            onSuccess: () => router.back(),
            onError: (e) => Alert.alert('Failed', e.message),
          }),
      },
    ]);
  }

  const unitLabel = config.variant === 'tennis' ? 'Sets' : 'Games';

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16" contentContainerClassName="gap-4 pb-12">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl font-bold">{sport?.name ?? match.sport_id}</Text>
        <View className="flex-row items-center gap-2">
          <View className="h-2.5 w-2.5 rounded-full bg-red-500" />
          <Text className="font-semibold text-red-500">LIVE</Text>
        </View>
      </View>
      <Text className="text-gray-400">
        {match.match_type} · {names('a')} vs {names('b')}
      </Text>

      <View className="rounded-xl border border-gray-200 p-4">
        <View className="flex-row justify-between">
          <Text className="font-semibold text-gray-500">{unitLabel}</Text>
          <Text className="font-semibold">
            {state.setsWon.a} – {state.setsWon.b}
          </Text>
        </View>
        <View className="mt-1 flex-row justify-between">
          <Text className="text-gray-500">
            {config.variant === 'tennis' ? 'Games (current set)' : 'Points (current game)'}
          </Text>
          <Text>
            {state.units[state.units.length - 1].a} – {state.units[state.units.length - 1].b}
          </Text>
        </View>
        {state.inTiebreak && <Text className="mt-1 text-amber-600">Tiebreak</Text>}
      </View>

      <View className="flex-row items-center justify-center gap-6 py-4">
        <Text className="text-5xl font-bold">{state.points.a}</Text>
        <Text className="text-2xl text-gray-300">–</Text>
        <Text className="text-5xl font-bold">{state.points.b}</Text>
      </View>

      {isParticipant && !state.isComplete && (
        <View className="flex-row gap-3">
          {(['a', 'b'] as const).map((side) => (
            <Pressable
              key={side}
              className="flex-1 items-center rounded-xl bg-emerald-600 p-6 active:bg-emerald-700"
              onPress={() => award.mutate(side)}
            >
              <Text className="font-semibold text-white">Point</Text>
              <Text className="text-emerald-100" numberOfLines={1}>{names(side)}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {isParticipant && state.isComplete && (
        <Pressable className="rounded-xl bg-emerald-600 p-4" disabled={finish.isPending} onPress={onFinish}>
          <Text className="text-center font-semibold text-white">
            {finish.isPending ? 'Saving…' : `Finish — ${names(state.winner!)} wins`}
          </Text>
        </Pressable>
      )}

      {isParticipant && (
        <View className="flex-row gap-3">
          <Pressable
            className="flex-1 rounded-lg border border-gray-300 p-3"
            disabled={!hasPoints}
            onPress={() => undoPoint.mutate()}
          >
            <Text className={`text-center ${hasPoints ? 'text-gray-700' : 'text-gray-300'}`}>Undo</Text>
          </Pressable>
          <Pressable className="flex-1 rounded-lg border border-red-300 p-3" onPress={onAbandon}>
            <Text className="text-center text-red-500">Abandon</Text>
          </Pressable>
        </View>
      )}

      {!isParticipant && <Text className="text-center text-gray-400">Watching live</Text>}
    </ScrollView>
  );
}
