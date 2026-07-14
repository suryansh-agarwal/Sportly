import { useQuery } from '@tanstack/react-query';
import { supabase } from '../supabase';

export type RatingRow = {
  sport_id: string;
  rating: number;
  matches_played: number;
};

export function useRatings(profileId: string) {
  return useQuery({
    queryKey: ['ratings', profileId],
    enabled: !!profileId,
    queryFn: async (): Promise<RatingRow[]> => {
      const { data, error } = await supabase
        .from('ratings')
        .select('sport_id, rating, matches_played')
        .eq('profile_id', profileId);
      if (error) throw error;
      return data as RatingRow[];
    },
  });
}
