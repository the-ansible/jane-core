/**
 * TimeoutOverflowWarning Monitor
 *
 * Node.js emits a TimeoutOverflowWarning (or TimeoutNaNWarning) when setTimeout
 * is called with a delay that exceeds 2^31-1 ms (~24.8 days) or is NaN/negative.
 * The timer fires immediately in that case, which can cause runaway scheduler loops.
 *
 * This module:
 *   - Hooks process.on('warning') to capture these warnings
 *   - Maintains a rolling count and a recent-events log
 *   - Sends a Slack alert via NATS when the count exceeds ALERT_THRESHOLD
 *   - Rate-limits alerts to one per ALERT_COOLDOWN_MS
 *
 * Usage:
 *   startTimeoutOverflowMonitor(nats);
 *   const stats = getTimeoutOverflowStats();
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';

const sc = StringCodec();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ALERT_THRESHOLD = 5;         // Alert after this many occurrences
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;  // 1 hour between alerts
const MAX_RECENT_EVENTS = 50;      // Keep last N event details in memory

// Warning names Node.js uses for timeout overflow
const TIMEOUT_WARNING_NAMES = new Set([
  'TimeoutOverflowWarning',
  'TimeoutNaNWarning',
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let natsConn: NatsConnection | null = null;
let totalCount = 0;
let lastAlertAt: number | null = null;
let started = false;

const recentEvents: Array<{
  name: string;
  message: string;
  ts: string;
}> = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TimeoutOverflowStats {
  totalCount: number;
  recentEvents: typeof recentEvents;
  alertThreshold: number;
  alertCooldownMs: number;
  lastAlertAt: string | null;
}

export function startTimeoutOverflowMonitor(nats: NatsConnection): void {
  if (started) return;
  started = true;
  natsConn = nats;

  process.on('warning', handleWarning);
  log('info', 'TimeoutOverflow monitor started', { threshold: ALERT_THRESHOLD });
}

export function getTimeoutOverflowStats(): TimeoutOverflowStats {
  return {
    totalCount,
    recentEvents: [...recentEvents],
    alertThreshold: ALERT_THRESHOLD,
    alertCooldownMs: ALERT_COOLDOWN_MS,
    lastAlertAt: lastAlertAt ? new Date(lastAlertAt).toISOString() : null,
  };
}

export function resetTimeoutOverflowCount(): void {
  totalCount = 0;
  recentEvents.length = 0;
  lastAlertAt = null;
  log('info', 'TimeoutOverflow counter reset');
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function handleWarning(warning: Error): void {
  if (!TIMEOUT_WARNING_NAMES.has(warning.name)) return;

  totalCount += 1;

  const event = {
    name: warning.name,
    message: warning.message,
    ts: new Date().toISOString(),
  };

  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.shift();
  }

  log('warn', 'TimeoutOverflowWarning detected', {
    warningName: warning.name,
    warningMessage: warning.message,
    totalCount,
  });

  maybeSendAlert();
}

function maybeSendAlert(): void {
  if (totalCount < ALERT_THRESHOLD) return;

  const now = Date.now();
  if (lastAlertAt !== null && now - lastAlertAt < ALERT_COOLDOWN_MS) return;

  lastAlertAt = now;

  const message = [
    `⚠️ **TimeoutOverflowWarning alert** — ${totalCount} occurrences detected.`,
    '',
    'Node.js is calling `setTimeout` with an invalid delay (NaN, negative, or > 2^31-1 ms).',
    'Affected schedulers will fire immediately, potentially causing runaway goal cycles.',
    '',
    `Recent event: \`${recentEvents[recentEvents.length - 1]?.message ?? 'unknown'}\``,
    '',
    'Check engine.ts, autonomic.ts, strategic.ts, heartbeat.ts, and consolidator.ts for unguarded setTimeout calls.',
  ].join('\n');

  sendAlertViaNats(message);
}

function sendAlertViaNats(message: string): void {
  if (!natsConn) {
    log('warn', 'Cannot send timeout overflow alert — NATS not connected');
    return;
  }

  try {
    const event = {
      v: 2,
      id: crypto.randomUUID(),
      sessionId: 'brain-server',
      channelType: 'realtime',
      direction: 'outbound',
      contentType: 'markdown',
      content: message,
      sender: { id: 'jane-brain', displayName: 'Jane (Brain)', type: 'agent' },
      metadata: { alertType: 'timeout-overflow', totalCount },
      timestamp: new Date().toISOString(),
    };
    natsConn.publish('communication.outbound.jane', sc.encode(JSON.stringify(event)));
    log('info', 'TimeoutOverflow alert sent via NATS', { totalCount });
  } catch (err) {
    log('warn', 'Failed to send timeout overflow alert via NATS', { error: String(err) });
  }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level,
    msg,
    component: 'timeout-overflow-monitor',
    ts: new Date().toISOString(),
    ...extra,
  }));
}
