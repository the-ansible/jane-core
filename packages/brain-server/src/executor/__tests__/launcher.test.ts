/**
 * Launcher tests.
 *
 * Tests prompt construction and adapter dispatch logic.
 * Full integration tests require NATS + DB.
 */

import { describe, it, expect } from 'vitest';
import { buildRolePrompt } from '../roles.js';

describe('prompt construction', () => {
  it('combines role + context + task into a prompt', () => {
    const rolePrompt = buildRolePrompt('executor');
    expect(rolePrompt).toContain('autonomous executor');
    expect(rolePrompt).toContain('workspace');
  });

  it('handles unknown role gracefully', () => {
    const rolePrompt = buildRolePrompt('nonexistent');
    expect(rolePrompt).toBe('');
  });
});

describe('adapter registry', () => {
  it('has all built-in adapters available', async () => {
    // Import the module to check adapter names
    const claudeCode = (await import('../adapters/claude-code.js')).default;
    const mercury = (await import('../adapters/mercury.js')).default;
    const ollama = (await import('../adapters/ollama.js')).default;
    const synthetic = (await import('../adapters/synthetic.js')).default;

    expect(claudeCode.name).toBe('claude-code');
    expect(mercury.name).toBe('mercury');
    expect(ollama.name).toBe('ollama');
    expect(synthetic.name).toBe('synthetic');
  });
});
