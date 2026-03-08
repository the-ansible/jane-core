/**
 * Context orchestrator — composes context modules into a unified prompt prefix.
 *
 * Given a session, role, and prompt, runs the appropriate context modules
 * and assembles their fragments into a single context block.
 */

import type {
  ContextModule,
  ContextModuleParams,
  ContextFragment,
  AssembledContext,
  ResolvedContextPlan,
} from './types.js';
import { getActivePlan, resolvePlan } from './plans.js';

// Module registry — all available modules
import conversationModule from './modules/conversation.js';
import semanticFactsModule from './modules/semantic-facts.js';
import systemStateModule from './modules/system-state.js';
import memoryModule from './modules/memory.js';
import parentSessionModule from './modules/parent-session.js';

const MODULE_REGISTRY = new Map<string, ContextModule>([
  ['conversation', conversationModule],
  ['semantic-facts', semanticFactsModule],
  ['system-state', systemStateModule],
  ['memory', memoryModule],
  ['parent-session', parentSessionModule],
]);

/**
 * Register a custom context module.
 * Allows extensions without modifying this file.
 */
export function registerModule(module: ContextModule): void {
  MODULE_REGISTRY.set(module.name, module);
}

/**
 * Assemble context for an agent invocation.
 *
 * Runs the specified modules (or role defaults) and combines their output
 * into a single text block for prompt injection.
 */
export async function assembleContext(params: {
  sessionId?: string;
  role: string;
  prompt: string;
  /** Override which modules to run */
  modules?: string[];
  /** Override the resolved plan */
  plan?: ResolvedContextPlan;
}): Promise<AssembledContext> {
  const start = Date.now();

  // Resolve the context plan
  const { name: planName, config } = await getActivePlan();
  const plan = params.plan ?? resolvePlan(config, params.role);

  // Determine which modules to run
  const moduleNames = params.modules ?? plan.modules;

  // Run modules in parallel
  const moduleParams: ContextModuleParams = {
    sessionId: params.sessionId,
    role: params.role,
    prompt: params.prompt,
    plan,
  };

  const modulePromises = moduleNames
    .map(name => {
      const mod = MODULE_REGISTRY.get(name);
      if (!mod) {
        log('warn', `Unknown context module: ${name}`);
        return null;
      }
      return mod.assemble(moduleParams).catch(err => {
        log('warn', `Module ${name} threw`, { error: String(err) });
        return null;
      });
    })
    .filter((p): p is Promise<ContextFragment | null> => p !== null);

  const results = await Promise.all(modulePromises);
  const fragments = results.filter((f): f is ContextFragment => f !== null);

  // Combine fragments in a stable order
  const orderedFragments = orderFragments(fragments, moduleNames);

  const text = orderedFragments.map(f => f.text).join('\n\n');
  const totalTokens = orderedFragments.reduce((sum, f) => sum + f.tokenEstimate, 0);

  const assemblyMs = Date.now() - start;

  log('info', 'Context assembled', {
    sessionId: params.sessionId,
    role: params.role,
    modulesRun: moduleNames,
    fragmentCount: orderedFragments.length,
    totalTokens,
    assemblyMs,
  });

  return {
    fragments: orderedFragments,
    text,
    totalTokens,
    meta: {
      planName,
      modulesRun: moduleNames,
      assemblyMs,
    },
  };
}

/**
 * Order fragments to match the module order specified in the plan.
 * This gives a predictable prompt structure.
 */
function orderFragments(fragments: ContextFragment[], moduleOrder: string[]): ContextFragment[] {
  const bySource = new Map(fragments.map(f => [f.source, f]));
  const ordered: ContextFragment[] = [];

  // First, add in specified order
  for (const name of moduleOrder) {
    const f = bySource.get(name);
    if (f) {
      ordered.push(f);
      bySource.delete(name);
    }
  }

  // Then any remaining (shouldn't happen, but safe)
  for (const f of bySource.values()) {
    ordered.push(f);
  }

  return ordered;
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.orchestrator', ts: new Date().toISOString(), ...extra }));
}

// Re-exports
export { getActivePlan, resolvePlan, initContextSchema } from './plans.js';
export { registerModule as addModule };
export type { AssembledContext, ContextModule, ContextFragment, ResolvedContextPlan } from './types.js';
