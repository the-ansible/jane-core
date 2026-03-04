/**
 * NATS consumer — listens on `agent.jobs.request` and dispatches jobs.
 *
 * Job request payload: JobRequest (see jobs/types.ts)
 */

import type { NatsConnection, Subscription } from 'nats';
import { StringCodec } from 'nats';
import { createJob } from '../jobs/registry.js';
import { spawnAgent } from '../jobs/spawner.js';
import type { JobRequest } from '../jobs/types.js';

const REQUEST_SUBJECT = 'agent.jobs.request';
const sc = StringCodec();

let subscription: Subscription | null = null;

export function startConsumer(nats: NatsConnection): void {
  subscription = nats.subscribe(REQUEST_SUBJECT);

  log('info', 'NATS consumer started', { subject: REQUEST_SUBJECT });

  (async () => {
    for await (const msg of subscription!) {
      try {
        const raw = sc.decode(msg.data);
        const request: JobRequest = JSON.parse(raw);

        // Validate required fields
        if (!request.prompt || typeof request.prompt !== 'string') {
          log('warn', 'Invalid job request — missing prompt', { raw: raw.slice(0, 200) });
          continue;
        }

        const jobType = request.type ?? 'task';

        // Fall back to msg.reply (NATS request/reply inbox) if no explicit replySubject
        const replySubject = request.replySubject ?? msg.reply;
        const requestWithReply: JobRequest = { ...request, replySubject };

        // Create the DB record
        const jobId = await createJob({
          jobType,
          prompt: request.prompt,
          contextJson: request.context ?? {},
          natsReplySubject: replySubject,
        });

        log('info', 'Job queued', { jobId, type: jobType, replySubject });

        // Spawn — don't await, it's async
        spawnAgent({ jobId, request: requestWithReply, nats }).catch((err) => {
          log('error', 'Failed to spawn agent', { jobId, error: String(err) });
        });
      } catch (err) {
        log('error', 'Error processing job request', { error: String(err) });
      }
    }
  })();
}

export function stopConsumer(): void {
  subscription?.unsubscribe();
  subscription = null;
  log('info', 'NATS consumer stopped');
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'brain-consumer', ts: new Date().toISOString(), ...extra }));
}
