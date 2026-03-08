/**
 * Memory context module — retrieves relevant memories from brain.memories.
 *
 * Blends keyword search + recency + importance scoring.
 * Delegates to the existing memory retriever.
 */

import type { ContextModule, ContextModuleParams, ContextFragment } from '../types.js';
import { getRelevantMemories, formatMemoriesForContext } from '../../../memory/retriever.js';
import { estimateTokens } from '../tokens.js';

const memoryModule: ContextModule = {
  name: 'memory',

  async assemble(params: ContextModuleParams): Promise<ContextFragment | null> {
    try {
      const memories = await getRelevantMemories({
        query: params.prompt,
        limit: 8,
        minImportance: 0.4,
      });

      if (memories.length === 0) return null;

      const text = `BRAIN MEMORIES (relevant past experience):\n${formatMemoriesForContext(memories)}`;

      return {
        source: 'memory',
        text,
        tokenEstimate: estimateTokens(text),
        meta: { memoryCount: memories.length },
      };
    } catch (err) {
      log('warn', 'Memory module failed', { error: String(err) });
      return null;
    }
  },
};

export default memoryModule;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.memory', ts: new Date().toISOString(), ...extra }));
}
