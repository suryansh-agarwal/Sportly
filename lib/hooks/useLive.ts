import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import type { ScoreEvent, Side } from '../scoring/types';
import type { MatchType } from '../types';

export type LiveParticipant = { profile_id: string; side: Side; profile: { username: string } };

export type LiveMatchRow = {
  id: string;
  sport_id: string;
  match_type: MatchType;
  format: '1v1' | 'teams';
  status: 'live' | 'completed' | 'abandoned';
  created_by: string;
  finished_match_id: string | null;
  participants: LiveParticipant[];
};

export type LiveMatchData = { match: LiveMatchRow; events: ScoreEvent[] };

const LIVE_SELECT =
  'id, sport_id, match_type, format, status, created_by, finished_match_id, ' +
  'participants:live_participants(profile_id, side, profile:profiles(username))';

type EventRow = { id: number | string; event_type: 'point' | 'undo'; side: Side | null };
const toScoreEvent = (row: EventRow): ScoreEvent => ({
  id: Number(row.id),
  type: row.event_type,
  side: row.side,
});

export function useLiveMatch(id: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['live', id],
    enabled: !!id,
    queryFn: async (): Promise<LiveMatchData> => {
      const [m, e] = await Promise.all([
        supabase.from('live_matches').select(LIVE_SELECT).eq('id', id).single(),
        supabase.from('live_events').select('id, event_type, side').eq('live_match_id', id).order('id'),
      ]);
      if (m.error) throw m.error;
      if (e.error) throw e.error;
      return {
        match: m.data as unknown as LiveMatchRow,
        events: (e.data as EventRow[]).map(toScoreEvent),
      };
    },
  });

  useEffect(() => {
    if (!id) return;
    const channel = supabase
      .channel(`live-${id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'live_events', filter: `live_match_id=eq.${id}` },
        (payload) => {
          const ev = toScoreEvent(payload.new as EventRow);
          qc.setQueryData<LiveMatchData>(['live', id], (old) => {
            if (!old) return old;
            if (old.events.some((x) => x.id === ev.id)) return old;
            return { ...old, events: [...old.events, ev].sort((a, b) => a.id - b.id) };
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'live_matches', filter: `id=eq.${id}` },
        () => {
          qc.invalidateQueries({ queryKey: ['live', id] });
          qc.invalidateQueries({ queryKey: ['live-list'] });
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          qc.invalidateQueries({ queryKey: ['live', id] });
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, qc]);

  return query;
}

export function useLiveMatches() {
  return useQuery({
    queryKey: ['live-list'],
    queryFn: async (): Promise<LiveMatchRow[]> => {
      const { data, error } = await supabase
        .from('live_matches')
        .select(LIVE_SELECT)
        .eq('status', 'live')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as unknown as LiveMatchRow[];
    },
  });
}

export type StartLiveInput = {
  sportId: string;
  matchType: MatchType;
  format: '1v1' | 'teams';
  participants: { profile_id: string; side: Side }[];
};

export function useStartLiveMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: StartLiveInput): Promise<string> => {
      const { data, error } = await supabase.rpc('start_live_match', {
        p_sport_id: input.sportId,
        p_match_type: input.matchType,
        p_format: input.format,
        p_participants: input.participants,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-list'] }),
  });
}

let tempId = Number.MAX_SAFE_INTEGER - 1_000_000;

function useInsertEvent(liveMatchId: string, eventType: 'point' | 'undo') {
  const { session } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (side: Side | null) => {
      const { data, error } = await supabase
        .from('live_events')
        .insert({
          live_match_id: liveMatchId,
          event_type: eventType,
          side,
          created_by: session!.user.id,
        })
        .select('id, event_type, side')
        .single();
      if (error) throw error;
      return toScoreEvent(data as EventRow);
    },
    onMutate: async (side) => {
      const temp: ScoreEvent = { id: ++tempId, type: eventType, side };
      qc.setQueryData<LiveMatchData>(['live', liveMatchId], (old) =>
        old ? { ...old, events: [...old.events, temp] } : old
      );
      return { tempEventId: temp.id };
    },
    onSuccess: (real, _side, ctx) => {
      qc.setQueryData<LiveMatchData>(['live', liveMatchId], (old) => {
        if (!old) return old;
        const withoutTemp = old.events.filter((e) => e.id !== ctx.tempEventId && e.id !== real.id);
        return { ...old, events: [...withoutTemp, real].sort((a, b) => a.id - b.id) };
      });
    },
    onError: (_err, _side, ctx) => {
      qc.setQueryData<LiveMatchData>(['live', liveMatchId], (old) =>
        old ? { ...old, events: old.events.filter((e) => e.id !== ctx?.tempEventId) } : old
      );
    },
  });
}

export function useAwardPoint(liveMatchId: string) {
  return useInsertEvent(liveMatchId, 'point');
}

export function useUndoPoint(liveMatchId: string) {
  const mutation = useInsertEvent(liveMatchId, 'undo');
  return { ...mutation, mutate: () => mutation.mutate(null) };
}

export function useFinishLiveMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { liveMatchId: string; scoreA: number; scoreB: number }): Promise<string> => {
      const { data, error } = await supabase.rpc('finish_live_match', {
        p_live_match_id: input.liveMatchId,
        p_score_a: input.scoreA,
        p_score_b: input.scoreB,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_matchId, input) => {
      qc.invalidateQueries({ queryKey: ['matches'] });
      qc.invalidateQueries({ queryKey: ['live-list'] });
      qc.invalidateQueries({ queryKey: ['live', input.liveMatchId] });
      qc.invalidateQueries({ queryKey: ['ratings'] });
    },
  });
}

export function useAbandonLiveMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (liveMatchId: string) => {
      const { error } = await supabase.rpc('abandon_live_match', { p_live_match_id: liveMatchId });
      if (error) throw error;
    },
    onSuccess: (_void, liveMatchId) => {
      qc.invalidateQueries({ queryKey: ['live-list'] });
      qc.invalidateQueries({ queryKey: ['live', liveMatchId] });
    },
  });
}
