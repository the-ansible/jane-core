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
 *   - Sends a Slack alert via NATS when the cumulative count exceeds ALERT_THRESHOLD
 *   - Rate-limits alerts to one per ALERT_COOLDOWN_MS
 *   - Sends a Slack alert AND triggers a graceful PM2 reload when the rolling
 *     5-minute window count exceeds WINDOW_THRESHOLD (10 events in 5 minutes)
 *   - Rate-limits auto-restarts to one per RESTART_COOLDOWN_MS
 *
 * Usage:
 *   startTimeoutOverflowMonitor(nats);
 *   const stats = getTimeoutOverflowStats();
 */

import { exec } from 'node:child_process';
import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';

const sc = StringCodec();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ALERT_THRESHOLD = 5;                     // Cumulative alert threshold
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;      // 1 hour between cumulative alerts
const MAX_RECENT_EVENTS = 50;                  // Keep last N event details in memory

// Rolling window: if WINDOW_THRESHOLD events occur within WINDOW_MS, alert + restart
const WINDOW_MS = 5 * 60 * 1000;              // 5-minute sliding window
const WINDOW_THRESHOLD = 10;                  // 10 events in the window triggers restart
const RESTART_COOLDOWN_MS = 10 * 60 * 1000;  // 10 minutes between auto-restarts

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
let lastRestartAt: number | null = null;
let started = false;

const recentEvents: Array<{
  name: string;
  message: string;
  ts: string;
}> = [];

// Timestamps (ms) of events in the rolling window
const windowTimestamps: number[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TimeoutOverflowStats {
  totalCount: number;
  recentEvents: typeof recentEvents;
  alertThreshold: number;
  alertCooldownMs: number;
  lastAlertAt: string | null;
  windowCount: number;
  windowThreshold: number;
  windowMs: number;
  lastRestartAt: string | null;
}

export function startTimeoutOverflowMonitor(nats: NatsConnection): void {
  if (started) return;
  started = true;
  natsConn = nats;

  process.on('warning', handleWarning);
  log('info', 'TimeoutOverflow monitor started', {
    threshold: ALERT_THRESHOLD,
    windowThreshold: WINDOW_THRESHOLD,
    windowMs: WINDOW_MS,
  });
}

export function getTimeoutOverflowStats(): TimeoutOverflowStats {
  const now = Date.now();
  const windowCount = windowTimestamps.filter((t) => now - t <= WINDOW_MS).length;
  return {
    totalCount,
    recentEvents: [...recentEvents],
    alertThreshold: ALERT_THRESHOLD,
    alertCooldownMs: ALERT_COOLDOWN_MS,
    lastAlertAt: lastAlertAt ? new Date(lastAlertAt).toISOString() : null,
    windowCount,
    windowThreshold: WINDOW_THRESHOLD,
    windowMs: WINDOW_MS,
    lastRestartAt: lastRestartAt ? new Date(lastRestartAt).toISOString() : null,
  };
}

export function resetTimeoutOverflowCount(): void {
  totalCount = 0;
  recentEvents.length = 0;
  windowTimestamps.length = 0;
  lastAlertAt = null;
  lastRestartAt = null;
  log('info', 'TimeoutOverflow counter reset');
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function handleWarning(warning: Error): void {
  if (!TIMEOUT_WARNING_NAMES.has(warning.name)) return;

  const now = Date.now();
  totalCount += 1;

  const event = {
    name: warning.name,
    message: warning.message,
    ts: new Date(now).toISOString(),
  };

  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.shift();
  }

  // Track rolling window
  windowTimestamps.push(now);
  // Evict entries older than WINDOW_MS
  const cutoff = now - WINDOW_MS;
  while (windowTimestamps.length > 0 && windowTimestamps[0]! < cutoff) {
    windowTimestamps.shift();
  }
  const windowCount = windowTimestamps.length;

  log('warn', 'TimeoutOverflowWarning detected', {
    warningName: warning.name,
    warningMessage: warning.message,
    totalCount,
    windowCount,
  });

  maybeSendAlert();
  maybeTriggerRestart(windowCount, now);
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

function maybeTriggerRestart(windowCount: number, now: number): void {
  if (windowCount < WINDOW_THRESHOLD) return;

  if (lastRestartAt !== null && now - lastRestartAt < RESTART_COOLDOWN_MS) {
    log('info', 'Auto-restart suppressed — within cooldown', {
      lastRestartAt: new Date(lastRestartAt).toISOString(),
      cooldownMs: RESTART_COOLDOWN_MS,
    });
    return;
  }

  lastRestartAt = now;

  const alertMessage = [
    `🚨 **TimeoutOverflowWarning auto-restart triggered** — ${windowCount} events in the last 5 minutes (threshold: ${WINDOW_THRESHOLD}).`,
    '',
    'Initiating graceful PM2 reload of `brain-server` to clear runaway scheduler state.',
    '',
    `Recent event: \`${recentEvents[recentEvents.length - 1]?.message ?? 'unknown'}\``,
  ].join('\n');

  sendAlertViaNats(alertMessage);
  triggerGracefulRestart();
}

function triggerGracefulRestart(): void {
  log('warn', 'Triggering graceful PM2 reload of brain-server', {
    windowThreshold: WINDOW_THRESHOLD,
    windowMs: WINDOW_MS,
  });

  exec('pm2 reload brain-server --update-env', (err, stdout, stderr) => {
    if (err) {
      log('error', 'PM2 graceful reload failed', {
        error: String(err),
        stderr: stderr?.trim(),
      });
    } else {
      log('info', 'PM2 graceful reload completed', {
        stdout: stdout?.trim(),
      });
    }
  });
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
