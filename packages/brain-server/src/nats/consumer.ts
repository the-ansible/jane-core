/**
 * NATS consumer — listens on `agent.jobs.request` and `memory.session.compacted`.
 *
 * Job request payload: JobRequest (see jobs/types.ts)
 * Compaction payload: { sessionId, messageCount, graphitiEpisodeId, ingestError, ts }
 */

import type { NatsConnection, Subscription } from 'nats';
import { StringCodec } from 'nats';
import { createJob } from '../jobs/registry.js';
import { spawnAgent } from '../jobs/spawner.js';
import { launchAgent } from '../executor/index.js';
import type { JobRequest } from '../jobs/types.js';
import type { RuntimeTool } from '../executor/types.js';
import { recordIngestion } from '../memory/ingestion-log.js';

const REQUEST_SUBJECT = 'agent.jobs.request';
const COMPACTION_SUBJECT = 'memory.session.compacted';
const sc = StringCodec();

let subscription: Subscription | null = null;
let compactionSubscription: Subscription | null = null;

export function startConsumer(nats: NatsConnection): void {
  subscription = nats.subscribe(REQUEST_SUBJECT);
  compactionSubscription = nats.subscribe(COMPACTION_SUBJECT);

  log('info', 'NATS consumer started', { subjects: [REQUEST_SUBJECT, COMPACTION_SUBJECT] });

  // Handle compaction events — record in ingestion log
  (async () => {
    for await (const msg of compactionSubscription!) {
      try {
        const raw = sc.decode(msg.data);
        const payload = JSON.parse(raw) as {
          sessionId: string;
          messageCount: number;
          graphitiEpisodeId: string | null;
          ingestError: string | null;
          ts: string;
        };

        await recordIngestion({
          sessionId: payload.sessionId,
          graphitiEpisodeId: payload.graphitiEpisodeId,
          messageCount: payload.messageCount,
          tsStart: null, // not provided in the event
          tsEnd: payload.ts,
          status: payload.ingestError ? 'failed' : 'success',
          error: payload.ingestError ?? undefined,
        });

        log('info', 'Session compaction recorded', {
          sessionId: payload.sessionId,
          messageCount: payload.messageCount,
          graphitiEpisodeId: payload.graphitiEpisodeId,
          status: payload.ingestError ? 'failed' : 'success',
        });
      } catch (err) {
        log('error', 'Error handling compaction event', { error: String(err) });
      }
    }
  })();

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

        // Route through executor if role or runtime specified, otherwise legacy path
        if (request.role || request.runtime) {
          const runtimeTool = (request.runtime?.tool as RuntimeTool) ?? 'claude-code';
          const runtimeModel = (request.runtime?.model as string) ?? 'sonnet';

          launchAgent({
            sessionId: request.sessionId,
            role: request.role ?? 'executor',
            prompt: request.prompt,
            runtime: { tool: runtimeTool, model: runtimeModel },
            jobType,
            replySubject,
            clientId: request.clientId,
            workdir: request.workdir,
            projectPath: request.projectPath,
            context: request.context ? [JSON.stringify(request.context)] : undefined,
            workspace: request.workspace,
            worktrees: request.worktrees,
          }).then(result => {
            log('info', 'Job launched via executor', { jobId: result.jobId, role: request.role, runtime: runtimeTool });
          }).catch(err => {
            log('error', 'Failed to launch via executor', { error: String(err) });
          });
        } else {
          // Legacy path: direct spawn without executor
          const requestWithReply: JobRequest = { ...request, replySubject };
          const jobId = await createJob({
            jobType,
            prompt: request.prompt,
            contextJson: request.context ?? {},
            natsReplySubject: replySubject,
          });

          log('info', 'Job queued (legacy)', { jobId, type: jobType, replySubject });

          spawnAgent({ jobId, request: requestWithReply, nats }).catch((err) => {
            log('error', 'Failed to spawn agent', { jobId, error: String(err) });
          });
        }
      } catch (err) {
        log('error', 'Error processing job request', { error: String(err) });
      }
    }
  })();
}

export function stopConsumer(): void {
  subscription?.unsubscribe();
  subscription = null;
  compactionSubscription?.unsubscribe();
  compactionSubscription = null;
  log('info', 'NATS consumer stopped');
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'brain-consumer', ts: new Date().toISOString(), ...extra }));
}
