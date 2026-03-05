#!/usr/bin/env node
/**
 * agent-job-wrapper.mjs
 *
 * Wraps the Claude CLI agent for job recovery support.
 * Spawned by the stimulation server instead of claude directly.
 *
 * Env vars required:
 *   JOB_ID          — UUID of the agent_job row
 *   OUTPUT_FILE     — path to write Claude's stdout JSON
 *   JANE_DATABASE_URL — postgres connection string
 *   NATS_URL        — nats server URL (default: nats://life-system-nats:4222)
 *
 * Reads prompt from stdin.
 * Writes Claude output JSON to OUTPUT_FILE.
 * Updates last_heartbeat_at in DB every 30s.
 * Publishes stimulation.agent_jobs.completed to NATS on exit.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { connect, StringCodec } from 'nats';
import { launchClaude } from '@jane-core/claude-launcher';

const { Pool } = pg;
const sc = StringCodec();

const JOB_ID = process.env.JOB_ID;
const OUTPUT_FILE = process.env.OUTPUT_FILE;
const NATS_URL = process.env.NATS_URL || 'nats://life-system-nats:4222';
const DB_URL = process.env.JANE_DATABASE_URL;

if (!JOB_ID || !OUTPUT_FILE || !DB_URL) {
  process.stderr.write('agent-job-wrapper: missing required env vars: JOB_ID, OUTPUT_FILE, JANE_DATABASE_URL\n');
  process.exit(1);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.once('end', () => {
  main(prompt).catch((err) => {
    process.stderr.write(`agent-job-wrapper fatal: ${err}\n`);
    process.exit(1);
  });
});

async function main(prompt) {
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });

  const pool = new Pool({ connectionString: DB_URL });

  // Mark running with our PID
  try {
    await pool.query(
      `UPDATE stimulation.agent_jobs
       SET pid = $1, status = 'running', last_heartbeat_at = now(), updated_at = now()
       WHERE id = $2`,
      [process.pid, JOB_ID]
    );
  } catch (err) {
    process.stderr.write(`agent-job-wrapper: DB update failed (continuing): ${err.message}\n`);
  }

  // Heartbeat every 30 seconds
  const heartbeat = setInterval(async () => {
    try {
      await pool.query(
        `UPDATE stimulation.agent_jobs SET last_heartbeat_at = now(), updated_at = now() WHERE id = $1`,
        [JOB_ID]
      );
    } catch (_) {}
  }, 30_000);

  // Spawn Claude CLI via shared launcher, stream output to file
  const fileStream = createWriteStream(OUTPUT_FILE, { flags: 'w' });

  const result = await launchClaude({
    prompt,
    timeout: 900_000,
    onStdout: (chunk) => {
      fileStream.write(chunk);
      try { process.stdout.write(chunk); } catch (_) {}
    },
    onStderr: (chunk) => {
      try { process.stderr.write(chunk); } catch (_) {}
    },
  });

  fileStream.end();
  const success = result.exitCode === 0;

  clearInterval(heartbeat);

  // Mark agent_done (agent ran, compose+publish still needed by main server)
  try {
    await pool.query(
      `UPDATE stimulation.agent_jobs
       SET status = 'agent_done', last_heartbeat_at = now(), updated_at = now()
       WHERE id = $1`,
      [JOB_ID]
    );
  } catch (err) {
    process.stderr.write(`agent-job-wrapper: DB agent_done update failed: ${err.message}\n`);
  }

  await pool.end().catch(() => {});

  // Publish NATS completion event
  try {
    const nc = await connect({ servers: NATS_URL, name: 'agent-job-wrapper' });
    nc.publish(
      'stimulation.agent_jobs.completed',
      sc.encode(JSON.stringify({ jobId: JOB_ID, outputFile: OUTPUT_FILE, success }))
    );
    await nc.drain();
  } catch (err) {
    // Non-fatal — main server will detect agent_done status on next check
    process.stderr.write(`agent-job-wrapper: NATS publish failed (non-fatal): ${err.message}\n`);
  }
}
