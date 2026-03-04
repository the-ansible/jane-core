/**
 * Graphiti System Event Ingestor
 *
 * Subscribes to NATS system events and ingests them into the Graphiti
 * knowledge graph as 5W1H-structured episodes.
 *
 * 5W1H litmus test for every event:
 *   - Who:  which actor (Jane subsystem, Chris, scheduler, etc.)
 *   - What: what happened (event type + summary)
 *   - Where: which component / channel
 *   - When: ISO timestamp
 *   - Why:  trigger / goal / reason
 *   - How:  method / model / process used
 *
 * Subscribed subjects:
 *   goals.cycle.status          — goal engine cycle completions
 *   agent.results.>             — brain job completions/failures
 *   layer.autonomic.alert       — health monitor alerts only (not heartbeats)
 *   layer.reflexive.>           — reflexive layer events
 *   layer.cognitive.>           — cognitive escalation results
 *   layer.strategic.>           — strategic evaluations / directives
 *   memory.session.compacted    — session compaction + graphiti ingestion
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import { getJob } from '../jobs/registry.js';

const sc = StringCodec();
const GRAPHITI_URL = process.env.GRAPHITI_SERVICE_URL || 'http://localhost:3200';
const INGEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startGraphitiIngestor(nats: NatsConnection): void {
  subscribeGoalCycle(nats);
  subscribeAgentResults(nats);
  subscribeAutonomicAlerts(nats);
  subscribeLayerEvents(nats, 'layer.reflexive.>', 'reflexive-layer');
  subscribeLayerEvents(nats, 'layer.cognitive.>', 'cognitive-layer');
  subscribeLayerEvents(nats, 'layer.strategic.>', 'strategic-layer');
  subscribeSessionCompacted(nats);
  subscribeOutbound(nats);

  log('info', 'Graphiti system event ingestor started');
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

function subscribeGoalCycle(nats: NatsConnection): void {
  const sub = nats.subscribe('goals.cycle.status');
  (async () => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          cycleId: string;
          status: string;
          notes: string;
          actionId: string | null;
          ts: string;
        };

        const outcome = payload.status === 'done' ? 'completed successfully' : 'failed';
        const action = payload.notes ? `Action selected: "${payload.notes}"` : 'No action selected.';

        const content = formatEpisode({
          who: 'Jane (goal-engine, brain-server)',
          what: `Goal cycle ${payload.cycleId} ${outcome}. ${action}`,
          where: 'brain-server / goal-engine component',
          when: payload.ts,
          why: 'Scheduled 4-hour proactive action loop: assess active goals → generate candidates via Ollama → score → select best action → spawn brain job',
          how: `Ollama gemma3:12b for candidate generation and scoring. ${payload.actionId ? `Selected action ID: ${payload.actionId}` : 'No action spawned.'}`,
        });

        await ingestSystemEpisode({
          name: `goal-cycle-${payload.cycleId}`,
          content,
          source_description: `Jane's goal engine completed a planning cycle (${payload.status})`,
          reference_time: payload.ts,
        });
      } catch (err) {
        log('warn', 'Failed to ingest goal.cycle.status', { error: String(err) });
      }
    }
  })();
}

function subscribeAgentResults(nats: NatsConnection): void {
  const sub = nats.subscribe('agent.results.>');
  (async () => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          jobId: string;
          status: string;
          result?: string;
          error?: string;
          durationMs: number;
        };

        // Look up job context from DB for Why/How enrichment
        let jobContext: Record<string, unknown> = {};
        let jobPrompt = '';
        try {
          const job = await getJob(payload.jobId);
          if (job) {
            jobContext = (job.context_json as Record<string, unknown>) ?? {};
            jobPrompt = job.prompt?.slice(0, 300) ?? '';
          }
        } catch { /* non-critical */ }

        const outcome = payload.status === 'done' ? 'completed' : 'failed';
        const resultSummary = payload.result
          ? payload.result.slice(0, 400)
          : payload.error?.slice(0, 400) ?? 'No output';

        const goalId = jobContext.goalId ? `goal ${jobContext.goalId}` : null;
        const cycleId = jobContext.cycleId ? `cycle ${jobContext.cycleId}` : null;
        const source = (jobContext.source as string) || 'unknown trigger';

        const content = formatEpisode({
          who: 'Jane (brain-server spawner)',
          what: `Agent job ${payload.jobId} ${outcome}. ${resultSummary}`,
          where: 'brain-server / Claude Sonnet CLI subprocess',
          when: new Date().toISOString(),
          why: [
            source !== 'unknown trigger' ? `Triggered by: ${source}` : null,
            goalId ? `Advancing ${goalId}` : null,
            cycleId ? `Part of ${cycleId}` : null,
            jobPrompt ? `Task: ${jobPrompt}` : null,
          ].filter(Boolean).join('. ') || 'Autonomous brain job execution',
          how: `Claude Sonnet CLI subprocess (claude --print --dangerously-skip-permissions). Duration: ${Math.round(payload.durationMs / 1000)}s`,
        });

        await ingestSystemEpisode({
          name: `agent-result-${payload.jobId}`,
          content,
          source_description: `Jane completed a brain agent job (${payload.status})`,
          reference_time: new Date().toISOString(),
        });
      } catch (err) {
        log('warn', 'Failed to ingest agent.results event', { error: String(err) });
      }
    }
  })();
}

function subscribeAutonomicAlerts(nats: NatsConnection): void {
  // Only subscribe to alerts — heartbeats are too noisy for the graph
  const sub = nats.subscribe('layer.autonomic.alert');
  (async () => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          monitor: string;
          severity: string;
          message: string;
          data?: Record<string, unknown>;
          ts: string;
        };

        const content = formatEpisode({
          who: 'Jane (autonomic-layer, brain-server)',
          what: `Health monitor alert — ${payload.monitor} is ${payload.severity}. ${payload.message}`,
          where: `brain-server / autonomic layer / ${payload.monitor} monitor`,
          when: payload.ts,
          why: 'Automated health monitoring: periodic checks every 60 seconds detect anomalies in services, database, NATS, memory, and disk',
          how: `HTTP endpoint check / resource measurement. Threshold exceeded. Data: ${JSON.stringify(payload.data ?? {})}`,
        });

        await ingestSystemEpisode({
          name: `autonomic-alert-${payload.monitor}-${payload.ts}`,
          content,
          source_description: `Jane's autonomic layer detected a ${payload.severity} alert on ${payload.monitor}`,
          reference_time: payload.ts,
        });
      } catch (err) {
        log('warn', 'Failed to ingest layer.autonomic.alert', { error: String(err) });
      }
    }
  })();
}

function subscribeLayerEvents(nats: NatsConnection, subject: string, layerName: string): void {
  const sub = nats.subscribe(subject);
  (async () => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as Record<string, unknown>;
        const ts = (payload.ts as string) ?? new Date().toISOString();
        const eventType = msg.subject.split('.').pop() ?? 'event';

        // Skip if this looks like a heartbeat
        if (eventType === 'heartbeat') continue;

        const summary = buildLayerSummary(layerName, eventType, payload);

        const content = formatEpisode({
          who: `Jane (${layerName}, brain-server)`,
          what: summary,
          where: `brain-server / ${layerName}`,
          when: ts,
          why: `Hierarchical control system: ${getLayerPurpose(layerName)}`,
          how: getLayerMethod(layerName, payload),
        });

        await ingestSystemEpisode({
          name: `${layerName}-${eventType}-${ts}`,
          content,
          source_description: `Jane's ${layerName} triggered a ${eventType} event`,
          reference_time: ts,
        });
      } catch (err) {
        log('warn', `Failed to ingest ${subject} event`, { error: String(err) });
      }
    }
  })();
}

function subscribeSessionCompacted(nats: NatsConnection): void {
  const sub = nats.subscribe('memory.session.compacted');
  (async () => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          sessionId: string;
          messageCount: number;
          graphitiEpisodeId: string | null;
          ingestError: string | null;
          ts: string;
        };

        const status = payload.ingestError ? `failed (${payload.ingestError})` : 'succeeded';
        const content = formatEpisode({
          who: 'Jane (stimulation-server / graphiti-compactor)',
          what: `Session ${payload.sessionId} compacted. ${payload.messageCount} messages archived. Graphiti ingestion ${status}.`,
          where: 'stimulation-server / session store + Graphiti knowledge graph',
          when: payload.ts,
          why: 'Session exceeded 40 messages — compaction preserves memory by summarizing old messages and indexing them in the knowledge graph before discarding',
          how: `Ollama gemma3:12b for summarization. Graphiti episode ingestion via FalkorDB. Episode ID: ${payload.graphitiEpisodeId ?? 'none'}`,
        });

        await ingestSystemEpisode({
          name: `session-compacted-${payload.sessionId}-${payload.ts}`,
          content,
          source_description: `Jane compacted session ${payload.sessionId} and indexed it in Graphiti`,
          reference_time: payload.ts,
        });
      } catch (err) {
        log('warn', 'Failed to ingest memory.session.compacted', { error: String(err) });
      }
    }
  })();
}

function subscribeOutbound(nats: NatsConnection): void {
  const sub = nats.subscribe('communication.outbound.>');
  (async () => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          id: string;
          sessionId: string;
          channelType: string;
          content: string;
          sender?: { id: string; displayName?: string; type: string };
          recipients?: Array<{ id: string; displayName?: string; type: string }>;
          metadata?: Record<string, unknown>;
          timestamp: string;
        };

        const recipient = payload.recipients?.[0];
        const recipientLabel = recipient ? (recipient.displayName || recipient.id) : 'recipient';
        const intentType = payload.metadata?.intentType ?? 'response';
        const classificationTier = payload.metadata?.classificationTier ?? 'unknown';
        const contentPreview = payload.content.slice(0, 400);

        const content = formatEpisode({
          who: 'Jane (stimulation-server)',
          what: `Jane sent a ${intentType} to ${recipientLabel} via ${payload.channelType}. Message: ${contentPreview}`,
          where: `stimulation-server / ${payload.channelType} channel`,
          when: payload.timestamp,
          why: `Responding to ${recipientLabel} on session ${payload.sessionId}`,
          how: `Pipeline classified as "${intentType}" (tier: ${classificationTier}). Event ID: ${payload.id}`,
        });

        await ingestSystemEpisode({
          name: `outbound-${payload.id}`,
          content,
          source_description: `Jane sent a response to ${recipientLabel}`,
          reference_time: payload.timestamp,
        });
      } catch (err) {
        log('warn', 'Failed to ingest communication.outbound event', { error: String(err) });
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatEpisode(fields: {
  who: string;
  what: string;
  where: string;
  when: string;
  why?: string;
  how?: string;
}): string {
  return [
    `Who: ${fields.who}`,
    `What: ${fields.what}`,
    `Where: ${fields.where}`,
    `When: ${fields.when}`,
    fields.why ? `Why: ${fields.why}` : null,
    fields.how ? `How: ${fields.how}` : null,
  ].filter(Boolean).join('\n');
}

function buildLayerSummary(layer: string, eventType: string, payload: Record<string, unknown>): string {
  const parts: string[] = [`${layer} event: ${eventType}`];
  if (payload.message) parts.push(String(payload.message));
  if (payload.severity) parts.push(`Severity: ${payload.severity}`);
  if (payload.directive) parts.push(`Directive: ${JSON.stringify(payload.directive)}`);
  if (payload.result) parts.push(`Result: ${String(payload.result).slice(0, 200)}`);
  if (payload.action) parts.push(`Action: ${String(payload.action)}`);
  return parts.join('. ');
}

function getLayerPurpose(layer: string): string {
  const purposes: Record<string, string> = {
    'reflexive-layer': 'rapid response to autonomic alerts — triages alerts and escalates if needed',
    'cognitive-layer': 'deeper reasoning about system state — interprets escalated issues and decides corrective action',
    'strategic-layer': 'long-term meta-cognition — evaluates patterns, updates directives, guides overall system behavior',
  };
  return purposes[layer] ?? 'hierarchical control processing';
}

function getLayerMethod(layer: string, payload: Record<string, unknown>): string {
  const methods: Record<string, string> = {
    'reflexive-layer': 'Rule-based fast triage. May escalate to cognitive layer.',
    'cognitive-layer': 'Ollama LLM reasoning on alert context.',
    'strategic-layer': 'Claude Opus meta-cognition every 24h. Evaluates system patterns and updates directives.',
  };
  const base = methods[layer] ?? 'Automated processing';
  const extras = [
    payload.model ? `Model: ${payload.model}` : null,
    payload.durationMs ? `Duration: ${Math.round(Number(payload.durationMs) / 1000)}s` : null,
  ].filter(Boolean).join('. ');
  return extras ? `${base} ${extras}` : base;
}

// ---------------------------------------------------------------------------
// Graphiti HTTP client
// ---------------------------------------------------------------------------

async function ingestSystemEpisode(params: {
  name: string;
  content: string;
  source_description: string;
  reference_time: string;
}): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);

    const res = await fetch(`${GRAPHITI_URL}/episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: params.name,
        content: params.content,
        source_description: params.source_description,
        reference_time: params.reference_time,
        group_id: 'jane',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('warn', 'System episode ingest failed', { name: params.name, status: res.status, body: body.slice(0, 200) });
      return;
    }

    const data = (await res.json()) as { episode_uuid: string; nodes_created: number; edges_created: number };
    log('info', 'System episode ingested', {
      name: params.name,
      episodeId: data.episode_uuid,
      nodes: data.nodes_created,
      edges: data.edges_created,
    });
  } catch (err) {
    log('warn', 'System episode ingest error', { name: params.name, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ level, msg, component: 'graphiti-ingestor', ts: new Date().toISOString(), ...extra })
  );
}
