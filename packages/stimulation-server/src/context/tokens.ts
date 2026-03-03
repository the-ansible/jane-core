/**
 * Token estimation — simple heuristic for budget management.
 * English text averages ~4 characters per token.
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
