import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn() };
});
const mockReadFileSync = vi.mocked(readFileSync);

import { extractAndDispatchTask, type TaskExtractorInput } from '../composer/task-extractor.js';

// ---- Fetch mock helpers ----

type FetchCall = { url: string; options: RequestInit };
let capturedFetchCalls: FetchCall[] = [];

function setupMockFetch(responseJson: unknown) {
  capturedFetchCalls = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    capturedFetchCalls.push({ url, options });
    return {
      ok: true,
      json: async () => responseJson,
      text: async () => JSON.stringify(responseJson),
    };
  }));
}

function setupMockFetchError(status = 500) {
  capturedFetchCalls = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    capturedFetchCalls.push({ url, options });
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => 'Internal server error',
    };
  }));
}

function makeMercuryResponse(decision: { needed: boolean; description?: string; type?: string }) {
  return {
    choices: [{ message: { content: JSON.stringify(decision) } }],
  };
}

// ---- Test helpers ----

function makeInput(overrides: Partial<TaskExtractorInput> = {}): TaskExtractorInput {
  return {
    composedMessage: 'Sure, I\'ll implement that feature for you.',
    inboundMessage: 'Can you add a dark mode toggle to the settings page?',
    senderName: 'Chris',
    sessionId: 'test-session',
    eventId: 'test-event-id',
    ...overrides,
  };
}

function makeNats() {
  const ncPublish = vi.fn();
  return {
    nc: { publish: ncPublish },
    publish: vi.fn(),
    isConnected: () => true,
    ncPublish,
  } as any;
}

describe('Task Extractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MERCURY_API_KEY = 'test-mercury-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MERCURY_API_KEY;
  });

  describe('when Mercury says task is needed', () => {
    it('publishes job to agent.jobs.request via nc.publish', async () => {
      setupMockFetch(makeMercuryResponse({
        needed: true,
        description: 'Add a dark mode toggle to /agent/projects/canvas-web-app/src/Settings.tsx',
        type: 'task',
      }));
      const nats = makeNats();

      await extractAndDispatchTask(makeInput(), nats);

      expect(nats.nc.publish).toHaveBeenCalledOnce();
      const [subject, encoded] = nats.nc.publish.mock.calls[0];
      expect(subject).toBe('agent.jobs.request');

      const payload = JSON.parse(new TextDecoder().decode(encoded));
      expect(payload.type).toBe('task');
      expect(payload.prompt).toBe('Add a dark mode toggle to /agent/projects/canvas-web-app/src/Settings.tsx');
      expect(payload.role).toBe('executor');
      expect(payload.runtime).toEqual({ tool: 'claude-code', model: 'sonnet' });
      expect(payload.context.triggeredBy).toBe('conversation');
      expect(payload.context.extractedFrom).toBe('mercury_task_extractor');
      expect(payload.context.eventId).toBe('test-event-id');
      expect(payload.context.sessionId).toBe('test-session');
    });

    it('uses the task type from Mercury response', async () => {
      setupMockFetch(makeMercuryResponse({
        needed: true,
        description: 'Research the best React table library for resizable columns',
        type: 'research',
      }));
      const nats = makeNats();

      await extractAndDispatchTask(makeInput(), nats);

      const [, encoded] = nats.nc.publish.mock.calls[0];
      const payload = JSON.parse(new TextDecoder().decode(encoded));
      expect(payload.type).toBe('research');
    });

    it('defaults to "task" type when Mercury returns invalid type', async () => {
      setupMockFetch(makeMercuryResponse({
        needed: true,
        description: 'Do some work',
        type: 'invalid-type',
      }));
      const nats = makeNats();

      await extractAndDispatchTask(makeInput(), nats);

      const [, encoded] = nats.nc.publish.mock.calls[0];
      const payload = JSON.parse(new TextDecoder().decode(encoded));
      expect(payload.type).toBe('task');
    });

    it('calls Mercury API with correct auth and model', async () => {
      setupMockFetch(makeMercuryResponse({ needed: true, description: 'Do something', type: 'task' }));
      const nats = makeNats();

      await extractAndDispatchTask(makeInput(), nats);

      expect(capturedFetchCalls).toHaveLength(1);
      expect(capturedFetchCalls[0].url).toContain('inceptionlabs.ai');
      const headers = capturedFetchCalls[0].options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-mercury-key');
      const body = JSON.parse(capturedFetchCalls[0].options.body as string);
      expect(body.model).toBe('mercury-2');
    });

    it('includes both messages in the prompt', async () => {
      setupMockFetch(makeMercuryResponse({ needed: true, description: 'Work', type: 'task' }));
      const nats = makeNats();

      await extractAndDispatchTask(makeInput({
        inboundMessage: 'Please fix the login bug',
        composedMessage: 'On it, I\'ll patch the auth handler now.',
        senderName: 'Chris',
      }), nats);

      const body = JSON.parse(capturedFetchCalls[0].options.body as string);
      const prompt = body.messages[0].content;
      expect(prompt).toContain('Please fix the login bug');
      expect(prompt).toContain('On it');
      expect(prompt).toContain('Chris');
    });
  });

  describe('when Mercury says no task is needed', () => {
    it('does not publish to NATS', async () => {
      setupMockFetch(makeMercuryResponse({ needed: false }));
      const nats = makeNats();

      await extractAndDispatchTask(makeInput({
        composedMessage: 'Hey, doing well thanks!',
        inboundMessage: 'How are you?',
      }), nats);

      expect(nats.nc.publish).not.toHaveBeenCalled();
    });

    it('does not publish when needed is true but description is missing', async () => {
      setupMockFetch(makeMercuryResponse({ needed: true }));
      const nats = makeNats();

      await extractAndDispatchTask(makeInput(), nats);

      expect(nats.nc.publish).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('does not throw when Mercury API returns an error', async () => {
      setupMockFetchError(500);
      const nats = makeNats();

      await expect(extractAndDispatchTask(makeInput(), nats)).resolves.toBeUndefined();
      expect(nats.nc.publish).not.toHaveBeenCalled();
    });

    it('does not throw when fetch rejects', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
      const nats = makeNats();

      await expect(extractAndDispatchTask(makeInput(), nats)).resolves.toBeUndefined();
      expect(nats.nc.publish).not.toHaveBeenCalled();
    });

    it('does not throw when MERCURY_API_KEY is not set', async () => {
      delete process.env.MERCURY_API_KEY;
      mockReadFileSync.mockReturnValue(Buffer.from(''));
      vi.stubGlobal('fetch', vi.fn());
      const nats = makeNats();

      await expect(extractAndDispatchTask(makeInput(), nats)).resolves.toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(nats.nc.publish).not.toHaveBeenCalled();
    });

    it('does not throw when Mercury returns invalid JSON', async () => {
      capturedFetchCalls = [];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
        text: async () => 'not json at all',
      }));
      const nats = makeNats();

      await expect(extractAndDispatchTask(makeInput(), nats)).resolves.toBeUndefined();
      expect(nats.nc.publish).not.toHaveBeenCalled();
    });

    it('reads MERCURY_API_KEY from /proc/1/environ when env not set', async () => {
      delete process.env.MERCURY_API_KEY;
      mockReadFileSync.mockReturnValue(
        Buffer.from('OTHER_VAR=foo\0MERCURY_API_KEY=proc-key\0ANOTHER=bar')
      );
      setupMockFetch(makeMercuryResponse({ needed: false }));
      const nats = makeNats();

      await extractAndDispatchTask(makeInput(), nats);

      expect(capturedFetchCalls).toHaveLength(1);
      const headers = capturedFetchCalls[0].options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer proc-key');
    });
  });
});
