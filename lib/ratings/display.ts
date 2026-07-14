// Mirrors the server constants in supabase/migrations/0010_ratings_and_hardening.sql.
// Internal Elo starts at 1000; display(R) = round(100 / (1 + 10^((1000 - R) / 400))).

export function displayRating(internal: number): number {
  return Math.round(100 / (1 + Math.pow(10, (1000 - internal) / 400)));
}

export function formatDelta(internalDelta: number, internalAfter: number): string {
  const diff = displayRating(internalAfter) - displayRating(internalAfter - internalDelta);
  if (diff > 0) return `+${diff}`;
  if (diff < 0) return `−${Math.abs(diff)}`;
  return '±0';
}
