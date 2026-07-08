import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { deriveOutcomes } from '../outcomes';
import type { MatchRow, MatchType } from '../types';

export function useSports() {
  return useQuery({
    queryKey: ['sports'],
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data, error } = await supabase.from('sports').select('id, name').order('name');
      if (error) throw error;
      return data;
    },
  });
}

export function useMatches() {
  return useQuery({
    queryKey: ['matches'],
    queryFn: async (): Promise<MatchRow[]> => {
      const { data, error } = await supabase
        .from('matches')
        .select(
          'id, sport_id, match_type, played_at, participants:match_participants(profile_id, score, outcome)'
        )
        .order('played_at', { ascending: false });
      if (error) throw error;
      return data as unknown as MatchRow[];
    },
  });
}

export type LogMatchInput = {
  sportId: string;
  matchType: MatchType;
  opponentId: string;
  myScore: number;
  theirScore: number;
};

export function useLogMatch() {
  const { session } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogMatchInput) => {
      const myId = session!.user.id;
      const { data: match, error } = await supabase
        .from('matches')
        .insert({ sport_id: input.sportId, match_type: input.matchType, created_by: myId })
        .select('id')
        .single();
      if (error) throw error;
      const { mine, theirs } = deriveOutcomes(input.myScore, input.theirScore);
      const { error: pError } = await supabase.from('match_participants').insert([
        { match_id: match.id, profile_id: myId, score: input.myScore, outcome: mine },
        { match_id: match.id, profile_id: input.opponentId, score: input.theirScore, outcome: theirs },
      ]);
      if (pError) throw pError;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matches'] }),
  });
}
