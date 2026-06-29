/**
 * Cheap, model-agnostic token estimate used only for bounding how much memory we inject
 * into a run's system prompt. Not for billing. ~4 chars/token is a conservative heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
