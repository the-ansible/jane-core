/**
 * Role system tests.
 */

import { describe, it, expect } from 'vitest';
import { getRole, listRoles, registerRole, buildRolePrompt } from '../roles.js';

describe('role system', () => {
  it('lists all built-in roles', () => {
    const roles = listRoles();
    expect(roles).toContain('executor');
    expect(roles).toContain('reviewer');
    expect(roles).toContain('communicator');
    expect(roles).toContain('composer');
    expect(roles).toContain('scorer');
    expect(roles).toContain('analyst');
    expect(roles).toContain('investigator');
    expect(roles).toContain('generator');
    expect(roles).toContain('architect');
    expect(roles).toContain('implementer');
    expect(roles).toContain('release-manager');
  });

  it('gets a role by name', () => {
    const role = getRole('executor');
    expect(role).toBeDefined();
    expect(role!.name).toBe('executor');
    expect(role!.systemPrompt).toContain('autonomous executor');
    expect(role!.defaultModules).toContain('memory');
    expect(role!.defaultRuntime?.tool).toBe('claude-code');
  });

  it('returns undefined for unknown role', () => {
    expect(getRole('nonexistent')).toBeUndefined();
  });

  it('registers a custom role', () => {
    registerRole({
      name: 'test-role',
      systemPrompt: 'You are a test agent.',
      defaultModules: ['system-state'],
    });

    const role = getRole('test-role');
    expect(role).toBeDefined();
    expect(role!.systemPrompt).toBe('You are a test agent.');
  });

  it('builds role prompt with context', () => {
    const prompt = buildRolePrompt('executor', 'Additional context here');
    expect(prompt).toContain('autonomous executor');
    expect(prompt).toContain('Additional context here');
  });

  it('builds role prompt without context', () => {
    const prompt = buildRolePrompt('executor');
    expect(prompt).toContain('autonomous executor');
  });

  it('returns empty string for unknown role without context', () => {
    expect(buildRolePrompt('nonexistent')).toBe('');
  });

  it('returns context for unknown role with context', () => {
    expect(buildRolePrompt('nonexistent', 'fallback')).toBe('fallback');
  });

  it('reviewer role mentions sandbox validation', () => {
    const role = getRole('reviewer');
    expect(role!.systemPrompt).toContain('sandbox_violation');
  });

  it('composer role defaults to mercury', () => {
    const role = getRole('composer');
    expect(role!.defaultRuntime?.tool).toBe('mercury');
    expect(role!.defaultRuntime?.model).toBe('mercury-2');
  });

  it('architect role defaults to opus', () => {
    const role = getRole('architect');
    expect(role!.defaultRuntime?.model).toBe('opus');
  });
});
