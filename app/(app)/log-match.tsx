import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { useFriends } from '../../lib/hooks/useFriends';
import { useLogMatch, useSports, type LogMatchParticipant } from '../../lib/hooks/useMatches';
import { useStartLiveMatch } from '../../lib/hooks/useLive';
import { useRecordFixtureResult } from '../../lib/hooks/useTournaments';
import { SCORING_CONFIGS } from '../../lib/scoring/configs';
import { getSport } from '../../lib/sports';
import type { MatchFormat, MatchType, Side } from '../../lib/types';

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

function SectionLabel({ children }: { children: string }) {
  return <Text className="font-semibold">{children}</Text>;
}

const FORMAT_LABELS: Record<MatchFormat, string> = { '1v1': '1 v 1', teams: 'Teams', ffa: 'Free-for-all' };

export default function LogMatch() {
  const { session } = useAuth();
  const myId = session!.user.id;
  const { data: sports } = useSports();
  const { data: friendData } = useFriends();
  const logMatch = useLogMatch();
  const startLive = useStartLiveMatch();
  const params = useLocalSearchParams<{
    fixtureId?: string; tournamentId?: string; sportId?: string; opponentId?: string;
  }>();
  const fixtureMode = !!params.fixtureId;
  const recordResult = useRecordFixtureResult();

  const [step, setStep] = useState(0);
  const [sportId, setSportId] = useState('');
  const [format, setFormat] = useState<MatchFormat>('1v1');
  const [sideA, setSideA] = useState<string[]>([myId]);
  const [sideB, setSideB] = useState<string[]>([]);
  const [ffaIds, setFfaIds] = useState<string[]>([myId]);
  const [ranks, setRanks] = useState<Record<string, string>>({});
  const [scoreA, setScoreA] = useState('');
  const [scoreB, setScoreB] = useState('');
  const [matchType, setMatchType] = useState<MatchType>('official');
  const [statsFor, setStatsFor] = useState<string | null>(null);
  const [statInputs, setStatInputs] = useState<Record<string, Record<string, string>>>({});
  const [fixtureInit, setFixtureInit] = useState(false);
  if (fixtureMode && !fixtureInit && params.sportId && params.opponentId) {
    setFixtureInit(true);
    setSportId(params.sportId);
    setFormat('1v1');
    setSideA([myId]);
    setSideB([params.opponentId]);
    setMatchType('official');
    setStep(3); // straight to scores; sport/format/players are locked by the fixture
  }

  const sport = sportId ? getSport(sportId) : undefined;
  const friends = friendData?.friends ?? [];
  const everyone = [{ id: myId, username: 'me' }, ...friends.map((f) => ({ id: f.id, username: f.username }))];
  const nameOf = (id: string) => everyone.find((e) => e.id === id)?.username ?? '?';
  const participants = format === 'ffa' ? ffaIds : [...sideA, ...sideB];

  function resetPlayers(nextFormat: MatchFormat) {
    setFormat(nextFormat);
    setSideA([myId]);
    setSideB([]);
    setFfaIds([myId]);
    setRanks({});
    setScoreA('');
    setScoreB('');
  }

  function toggleSide(id: string, side: Side) {
    const [mine, other, setMine, setOther] =
      side === 'a' ? [sideA, sideB, setSideA, setSideB] : [sideB, sideA, setSideB, setSideA];
    if (mine.includes(id)) setMine(mine.filter((x) => x !== id));
    else {
      setMine([...mine, id]);
      setOther(other.filter((x) => x !== id));
    }
  }

  function toggleFfa(id: string) {
    setFfaIds(ffaIds.includes(id) ? ffaIds.filter((x) => x !== id) : [...ffaIds, id]);
  }

  function stepValid(): string | null {
    switch (step) {
      case 0: return sportId ? null : 'Pick a sport';
      case 1: return null;
      case 2:
        if (format === '1v1') return sideA.length === 1 && sideB.length === 1 ? null : 'Pick exactly one opponent';
        if (format === 'teams') return sideA.length >= 1 && sideB.length >= 1 ? null : 'Both sides need players';
        return ffaIds.length >= 2 ? null : 'Pick at least 2 players';
      case 3:
        if (format === 'ffa') {
          const parsed = ffaIds.map((id) => Number(ranks[id]));
          if (parsed.some((r) => !Number.isInteger(r) || r < 1)) return 'Every player needs a rank (1 or higher)';
          if (Math.min(...parsed) !== 1) return 'Someone must be ranked 1st';
          return null;
        }
        const a = Number(scoreA), b = Number(scoreB);
        if (scoreA.trim() === '' || scoreB.trim() === '') return 'Enter both scores';
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return 'Scores must be whole numbers';
        return null;
      default: return null;
    }
  }

  function next() {
    const err = stepValid();
    if (err) { Alert.alert('Hold on', err); return; }
    // skip format step when the sport only supports 1v1
    if (step === 0 && sport && sport.formats.length === 1) { setFormat(sport.formats[0]); setStep(2); return; }
    setStep(step + 1);
  }

  function back() {
    if (step === 2 && sport && sport.formats.length === 1) { setStep(0); return; }
    setStep(step - 1);
  }

  function buildStats(id: string): Record<string, number> | null {
    const raw = statInputs[id];
    if (!raw) return null;
    const entries = Object.entries(raw).filter(([, v]) => v.trim() !== '');
    if (entries.length === 0) return null;
    return Object.fromEntries(entries.map(([k, v]) => [k, Number(v)]));
  }

  function onSubmit() {
    if (!sport) return;
    const parts: LogMatchParticipant[] =
      format === 'ffa'
        ? ffaIds.map((id) => ({ profile_id: id, side: null, rank: Number(ranks[id]), score: null, stats: buildStats(id) }))
        : [
            ...sideA.map((id) => ({ profile_id: id, side: 'a' as Side, rank: null, score: null, stats: buildStats(id) })),
            ...sideB.map((id) => ({ profile_id: id, side: 'b' as Side, rank: null, score: null, stats: buildStats(id) })),
          ];
    for (const p of parts) {
      if (p.stats) {
        const result = sport.statSchema.safeParse(p.stats);
        if (!result.success) {
          Alert.alert(`Invalid stats for ${nameOf(p.profile_id)}`, result.error.issues[0].message);
          return;
        }
      }
    }
    logMatch.mutate(
      {
        sportId, matchType, format,
        scoreA: format === 'ffa' ? null : Number(scoreA),
        scoreB: format === 'ffa' ? null : Number(scoreB),
        participants: parts,
      },
      {
        onSuccess: (matchId) => {
          const done = () => {
            setStep(0); setSportId(''); resetPlayers('1v1'); setStatInputs({}); setStatsFor(null); setFixtureInit(false);
            router.push(fixtureMode && params.tournamentId ? `/tournament/${params.tournamentId}` : '/');
          };
          if (fixtureMode && params.fixtureId && params.tournamentId) {
            recordResult.mutate(
              { fixtureId: params.fixtureId, matchId, tournamentId: params.tournamentId },
              {
                onSuccess: done,
                onError: (e) => Alert.alert('Match logged, but fixture link failed', e.message),
              }
            );
          } else {
            done();
          }
        },
        onError: (e) => Alert.alert('Failed to log match', e.message),
      }
    );
  }

  function onScoreLive() {
    const err = stepValid();
    if (err) { Alert.alert('Hold on', err); return; }
    startLive.mutate(
      {
        sportId,
        matchType,
        format: format as '1v1' | 'teams',
        participants: [
          ...sideA.map((pid) => ({ profile_id: pid, side: 'a' as const })),
          ...sideB.map((pid) => ({ profile_id: pid, side: 'b' as const })),
        ],
      },
      {
        onSuccess: (liveId) => {
          setStep(0); setSportId(''); resetPlayers('1v1'); setStatInputs({}); setStatsFor(null);
          router.push(`/live/${liveId}`);
        },
        onError: (e) => Alert.alert('Could not start live match', e.message),
      }
    );
  }

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16" contentContainerClassName="gap-4 pb-12">
      <Text className="text-2xl font-bold">Log a match</Text>
      <Text className="text-gray-400">Step {step + 1} of 5</Text>

      {step === 0 && (
        <>
          <SectionLabel>Sport</SectionLabel>
          <View className="flex-row flex-wrap gap-2">
            {(sports ?? []).filter((s) => getSport(s.id)).map((s) => (
              <Chip key={s.id} label={s.name} selected={sportId === s.id}
                onPress={() => { setSportId(s.id); resetPlayers('1v1'); }} />
            ))}
          </View>
        </>
      )}

      {step === 1 && sport && (
        <>
          <SectionLabel>Format</SectionLabel>
          <View className="flex-row gap-2">
            {sport.formats.map((f) => (
              <Chip key={f} label={FORMAT_LABELS[f]} selected={format === f} onPress={() => resetPlayers(f)} />
            ))}
          </View>
        </>
      )}

      {step === 2 && format !== 'ffa' && (
        <>
          <SectionLabel>{format === '1v1' ? 'You (side A)' : 'Side A'}</SectionLabel>
          <View className="flex-row flex-wrap gap-2">
            {everyone.map((p) => (
              <Chip key={p.id} label={p.username} selected={sideA.includes(p.id)}
                onPress={() => toggleSide(p.id, 'a')} />
            ))}
          </View>
          <SectionLabel>{format === '1v1' ? 'Opponent (side B)' : 'Side B'}</SectionLabel>
          <View className="flex-row flex-wrap gap-2">
            {everyone.map((p) => (
              <Chip key={p.id} label={p.username} selected={sideB.includes(p.id)}
                onPress={() => toggleSide(p.id, 'b')} />
            ))}
          </View>
          {friends.length === 0 && <Text className="text-gray-400">Add a friend first</Text>}
          {!fixtureMode && SCORING_CONFIGS[sportId] && (
            <Pressable
              className="mt-2 rounded-lg border border-red-400 p-4"
              disabled={startLive.isPending}
              onPress={onScoreLive}
            >
              <Text className="text-center font-semibold text-red-500">
                {startLive.isPending ? 'Starting…' : '● Score live instead'}
              </Text>
            </Pressable>
          )}
        </>
      )}

      {step === 2 && format === 'ffa' && (
        <>
          <SectionLabel>Players</SectionLabel>
          <View className="flex-row flex-wrap gap-2">
            {everyone.map((p) => (
              <Chip key={p.id} label={p.username} selected={ffaIds.includes(p.id)} onPress={() => toggleFfa(p.id)} />
            ))}
          </View>
        </>
      )}

      {step === 3 && format !== 'ffa' && sport && (
        <>
          <SectionLabel>{`${sport.scoreLabel} — side A (${sideA.map(nameOf).join(', ')})`}</SectionLabel>
          <TextInput className="rounded-lg border border-gray-300 p-3" keyboardType="number-pad"
            value={scoreA} onChangeText={setScoreA} />
          <SectionLabel>{`${sport.scoreLabel} — side B (${sideB.map(nameOf).join(', ')})`}</SectionLabel>
          <TextInput className="rounded-lg border border-gray-300 p-3" keyboardType="number-pad"
            value={scoreB} onChangeText={setScoreB} />
        </>
      )}

      {step === 3 && format === 'ffa' && (
        <>
          <SectionLabel>Final ranking</SectionLabel>
          {ffaIds.map((id) => (
            <View key={id} className="flex-row items-center gap-3">
              <Text className="flex-1">{nameOf(id)}</Text>
              <TextInput className="w-16 rounded-lg border border-gray-300 p-2 text-center" keyboardType="number-pad"
                placeholder="#" value={ranks[id] ?? ''}
                onChangeText={(v) => setRanks({ ...ranks, [id]: v })} />
            </View>
          ))}
        </>
      )}

      {step === 4 && sport && (
        <>
          <SectionLabel>Type</SectionLabel>
          <View className="flex-row gap-2">
            <Chip label="Official" selected={matchType === 'official'} onPress={() => setMatchType('official')} />
            <Chip label="Friendly" selected={matchType === 'friendly'} onPress={() => setMatchType('friendly')} />
          </View>
          <SectionLabel>Player stats (optional)</SectionLabel>
          {participants.map((id) => (
            <View key={id} className="rounded-lg border border-gray-200">
              <Pressable className="flex-row justify-between p-3" onPress={() => setStatsFor(statsFor === id ? null : id)}>
                <Text className="font-semibold">{nameOf(id)}</Text>
                <Text className="text-emerald-700">{statsFor === id ? 'Hide' : 'Add stats'}</Text>
              </Pressable>
              {statsFor === id && (
                <View className="gap-2 border-t border-gray-200 p-3">
                  {sport.statFields.map((f) => (
                    <View key={f.key} className="flex-row items-center gap-3">
                      <Text className="flex-1 text-gray-700">{f.label}</Text>
                      <TextInput className="w-20 rounded-lg border border-gray-300 p-2 text-center"
                        keyboardType="numeric" value={statInputs[id]?.[f.key] ?? ''}
                        onChangeText={(v) =>
                          setStatInputs({ ...statInputs, [id]: { ...statInputs[id], [f.key]: v } })
                        } />
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
        </>
      )}

      <View className="mt-2 flex-row gap-3">
        {step > (fixtureMode ? 3 : 0) && (
          <Pressable className="flex-1 rounded-lg border border-emerald-600 p-4" onPress={back}>
            <Text className="text-center font-semibold text-emerald-700">Back</Text>
          </Pressable>
        )}
        {step < 4 ? (
          <Pressable className="flex-1 rounded-lg bg-emerald-600 p-4" onPress={next}>
            <Text className="text-center font-semibold text-white">Next</Text>
          </Pressable>
        ) : (
          <Pressable className="flex-1 rounded-lg bg-emerald-600 p-4" disabled={logMatch.isPending} onPress={onSubmit}>
            <Text className="text-center font-semibold text-white">
              {logMatch.isPending ? 'Saving…' : 'Save match'}
            </Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}
