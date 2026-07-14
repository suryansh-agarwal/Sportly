import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useMatch, type MatchDetailParticipant } from '../../../lib/hooks/useMatches';
import { getSport } from '../../../lib/sports';
import { formatDelta } from '../../../lib/ratings/display';

function StatTable({ participants, sportId }: { participants: MatchDetailParticipant[]; sportId: string }) {
  const sport = getSport(sportId);
  if (!sport) return null;
  const fields = sport.statFields.filter((f) => participants.some((p) => p.stats?.[f.key] != null));
  const derived = sport.derivedStats.filter((d) => participants.some((p) => p.stats && d.compute(p.stats) != null));
  if (fields.length === 0 && derived.length === 0) {
    return <Text className="text-gray-400">No stats recorded</Text>;
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        <View className="flex-row border-b border-gray-200 pb-1">
          <Text className="w-24 font-semibold text-gray-500">Player</Text>
          {fields.map((f) => (
            <Text key={f.key} className="w-14 text-center font-semibold text-gray-500">{f.shortLabel}</Text>
          ))}
          {derived.map((d) => (
            <Text key={d.key} className="w-14 text-center font-semibold text-emerald-700">{d.shortLabel}</Text>
          ))}
        </View>
        {participants.map((p) => (
          <View key={p.profile_id} className="flex-row border-b border-gray-100 py-1">
            <Text className="w-24" numberOfLines={1}>{p.profile.username}</Text>
            {fields.map((f) => (
              <Text key={f.key} className="w-14 text-center">
                {p.stats?.[f.key] != null ? String(p.stats[f.key]) : '–'}
              </Text>
            ))}
            {derived.map((d) => {
              const v = p.stats ? d.compute(p.stats) : null;
              return (
                <Text key={d.key} className="w-14 text-center text-emerald-700">
                  {v != null ? v.toFixed(d.decimals) : '–'}
                </Text>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export default function MatchDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: match, isLoading } = useMatch(id ?? '');

  if (isLoading) return <View className="flex-1 bg-white" />;
  if (!match) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Text className="text-gray-400">Match not found</Text>
      </View>
    );
  }

  const sport = getSport(match.sport_id);
  const sideA = match.participants.filter((p) => p.side === 'a');
  const sideB = match.participants.filter((p) => p.side === 'b');
  const ranked = [...match.participants].sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
  const aWon = match.score_a != null && match.score_b != null && match.score_a > match.score_b;
  const bWon = match.score_a != null && match.score_b != null && match.score_b > match.score_a;

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16" contentContainerClassName="gap-4 pb-12">
      <Text className="text-2xl font-bold">{sport?.name ?? match.sport_id}</Text>
      <View className="flex-row items-center gap-2">
        <Text className="text-gray-500">{match.played_at}</Text>
        <View className={`rounded-full px-2 py-0.5 ${match.match_type === 'official' ? 'bg-emerald-100' : 'bg-amber-100'}`}>
          <Text className={match.match_type === 'official' ? 'text-emerald-700' : 'text-amber-700'}>
            {match.match_type}
          </Text>
        </View>
        <Text className="text-gray-400">{match.format === 'ffa' ? 'free-for-all' : match.format}</Text>
      </View>

      {match.format !== 'ffa' ? (
        <>
          <View className="flex-row items-center justify-between rounded-xl border border-gray-200 p-4">
            <View className="flex-1">
              <Text className={`text-lg ${aWon ? 'font-bold text-emerald-700' : ''}`} numberOfLines={2}>
                {sideA.map((p) => p.profile.username).join(', ')}
              </Text>
            </View>
            <Text className="px-3 text-2xl font-bold">
              {match.score_a} – {match.score_b}
            </Text>
            <View className="flex-1">
              <Text className={`text-right text-lg ${bWon ? 'font-bold text-emerald-700' : ''}`} numberOfLines={2}>
                {sideB.map((p) => p.profile.username).join(', ')}
              </Text>
            </View>
          </View>
          <Text className="font-semibold">Stats</Text>
          <StatTable participants={[...sideA, ...sideB]} sportId={match.sport_id} />
        </>
      ) : (
        <>
          <Text className="font-semibold">Final ranking</Text>
          {ranked.map((p) => (
            <View key={p.profile_id} className="flex-row justify-between rounded-lg border border-gray-200 p-3">
              <Text className={p.rank === 1 ? 'font-bold text-emerald-700' : ''}>
                #{p.rank} {p.profile.username}
              </Text>
              {p.score != null && <Text className="text-gray-500">{p.score} pts</Text>}
            </View>
          ))}
          <Text className="font-semibold">Stats</Text>
          <StatTable participants={ranked} sportId={match.sport_id} />
        </>
      )}

      {match.match_type === 'official' &&
        match.participants.some((p) => p.rating_delta != null) && (
          <>
            <Text className="font-semibold">Rating changes</Text>
            <View className="gap-2">
              {match.participants
                .filter((p) => p.rating_delta != null && p.rating_after != null)
                .map((p) => {
                  const label = formatDelta(p.rating_delta!, p.rating_after!);
                  const color = label.startsWith('+')
                    ? 'text-emerald-600'
                    : label.startsWith('−')
                      ? 'text-red-500'
                      : 'text-gray-500';
                  return (
                    <View key={p.profile_id} className="flex-row justify-between rounded-lg border border-gray-200 p-3">
                      <Text numberOfLines={1}>{p.profile.username}</Text>
                      <Text className={`font-semibold ${color}`}>{label}</Text>
                    </View>
                  );
                })}
            </View>
          </>
        )}
    </ScrollView>
  );
}
