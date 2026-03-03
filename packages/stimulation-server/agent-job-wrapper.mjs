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

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { connect, StringCodec } from 'nats';

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

  // Spawn Claude CLI and pipe output to file
  const success = await spawnClaude(prompt, OUTPUT_FILE);

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

function spawnClaude(prompt, outputFile) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn('claude', [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', 'sonnet',
      '-p', '-',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/agent',
      env,
      timeout: 900_000,
    });

    const fileStream = createWriteStream(outputFile, { flags: 'w' });

    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();

    proc.stdout.pipe(fileStream);

    // Also mirror to wrapper's stdout so the parent process can read it
    proc.stdout.on('data', (chunk) => {
      try { process.stdout.write(chunk); } catch (_) {}
    });

    proc.stderr.on('data', (chunk) => {
      try { process.stderr.write(chunk); } catch (_) {}
    });

    proc.on('close', (code) => {
      fileStream.end(() => resolve(code === 0));
    });

    proc.on('error', (err) => {
      fileStream.end();
      process.stderr.write(`agent-job-wrapper: claude spawn error: ${err}\n`);
      resolve(false);
    });
  });
}
