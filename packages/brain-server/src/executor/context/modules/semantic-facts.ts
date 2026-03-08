/**
 * Semantic facts context module — retrieves long-term memory facts from Graphiti.
 *
 * Queries the Graphiti temporal knowledge graph by prompt content,
 * returns relevant facts for injection before conversation context.
 */

import type { ContextModule, ContextModuleParams, ContextFragment } from '../types.js';
import { estimateTokens } from '../tokens.js';

const GRAPHITI_URL = process.env.GRAPHITI_URL || 'http://localhost:8000';
const GRAPHITI_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 5;

interface MemoryFact {
  fact: string;
  uuid?: string;
  created_at?: string;
}

async function searchGraphiti(query: string, limit: number): Promise<MemoryFact[]> {
  const response = await fetch(`${GRAPHITI_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      num_results: limit,
      group_ids: ['jane'],
    }),
    signal: AbortSignal.timeout(GRAPHITI_TIMEOUT_MS),
  });

  if (!response.ok) return [];

  const data = await response.json() as { facts?: MemoryFact[] };
  return data.facts ?? [];
}

const semanticFactsModule: ContextModule = {
  name: 'semantic-facts',

  async assemble(params: ContextModuleParams): Promise<ContextFragment | null> {
    try {
      const facts = await searchGraphiti(params.prompt, DEFAULT_LIMIT);
      const validFacts = facts.filter(f => f.fact?.trim());

      if (validFacts.length === 0) return null;

      const lines = validFacts.map(f => `- ${f.fact}`);
      const text = `LONG-TERM MEMORY (relevant facts from past experience):\n${lines.join('\n')}`;

      return {
        source: 'semantic-facts',
        text,
        tokenEstimate: estimateTokens(text),
        meta: { factCount: validFacts.length },
      };
    } catch (err) {
      log('warn', 'Semantic facts module failed', { error: String(err) });
      return null;
    }
  },
};

export default semanticFactsModule;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.semantic-facts', ts: new Date().toISOString(), ...extra }));
}
