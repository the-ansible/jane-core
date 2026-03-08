/**
 * Parent session context module — stub for sub-session support.
 *
 * When a session has a parent_session_id, this module retrieves
 * a summary of the parent session's context. This gives sub-sessions
 * awareness of the broader context they were spawned from.
 *
 * Currently a stub. Will be implemented when the session infrastructure
 * supports sub-sessions (brain.sessions table with parent_id).
 */

import type { ContextModule, ContextModuleParams, ContextFragment } from '../types.js';

const parentSessionModule: ContextModule = {
  name: 'parent-session',

  async assemble(_params: ContextModuleParams): Promise<ContextFragment | null> {
    // Stub: sub-session support is a future enhancement.
    // When implemented, this will:
    // 1. Look up the session's parent_id in brain.sessions
    // 2. If parent exists, load the parent's context summaries
    // 3. Return a condensed fragment of the parent context
    return null;
  },
};

export default parentSessionModule;
