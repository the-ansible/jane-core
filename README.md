# jane-core

Core infrastructure for [Jane](https://jane.the-ansible.com), an autonomous AI personal assistant built on Claude.

This monorepo contains the brain server (autonomy, communication, multi-agent orchestration), event processing, and safety systems that form Jane's nervous system.

## Packages

### [`brain-server`](./packages/brain-server/)

Unified autonomy, communication, and multi-agent orchestration engine. Port :3103, PM2-managed.

**Autonomy:**
- Goal engine: 1h cycle (assess, generate, score, select, execute)
- Hierarchical layers: Autonomic (health monitors) → Reflexive (NATS alerts) → Cognitive (escalation) → Strategic (meta-cognition)
- Memory: Episodic/semantic/procedural/working with Ollama consolidation
- Agent executor: Spawns Claude Code subagents via child_process

**Communication (consolidated from stimulation-server):**
- Durable pull consumer on NATS JetStream COMMUNICATION stream
- Sender-driven routing (no classifier)
- Pipeline: validate → deduplicate → route → safety → context + Graphiti → agent → composer → publish
- Voice composition layer (Jane's tone applied before outbound publish)
- Safety layer: rate limits, circuit breakers, manual pause/resume
- Outbound retry queue for failed NATS publishes
- Pipeline run tracking with per-stage telemetry
- Sessions: in-memory + JSONL persistence
- Interactive session capture for Claude Code hooks

**Dashboard:**
- Live observability SPA at `/dashboard` with two tabs:
  - **Autonomy** tab: goals, cycles, layers, jobs, memory
  - **Communication** tab: counter cards, pipeline runs, events feed, sessions, safety gate, test sender
- React + Vite SPA, SSE-connected for real-time updates

**153 tests across 10 suites**

### [`event-drainer`](./packages/event-drainer/)

Autonomic process that bridges NATS JetStream to the filesystem for warm/cold event storage. Subscribes to all subjects on the COMMUNICATION stream and writes events as JSONL lines to hourly-rotated files.

**Features:**
- Hourly JSONL file rotation (`YYYY-MM-DD-HH.jsonl`)
- Event enrichment with drainer metadata (subject, stream, timestamp)
- Part of the three-tier data lifecycle: Hot (NATS 72h) → Warm (JSONL) → Cold (Parquet)
- 5 tests

## Architecture

```
External Channels (Slack, Email, etc.)
       │
       ▼
┌─────────────────────┐
│ Communication        │  Normalizes messages into CommunicationEvents
│ Gateway              │  Publishes to NATS JetStream
└──────────┬──────────┘
           │
    NATS JetStream (COMMUNICATION stream)
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
┌─────────┐  ┌──────────┐
│ Brain   │  │ Event    │
│ Server  │  │ Drainer  │
│         │  │          │
│ Route   │  │ → JSONL  │
│ Respond │  │   files  │
│ Safety  │  └──────────┘
│ Goals   │
│ Memory  │
└─────────┘
```

## Safety Systems

The brain server's communication module includes comprehensive safety controls:

| Mechanism | Threshold | Action |
|-----------|-----------|--------|
| Outbound rate limit | 30/hour | Block sends |
| Claude API rate limit | 10/hour | Hard stop |
| Total event throughput | 500/hour | Stop actions, continue logging |
| Consecutive errors | 5 failures | Circuit breaker open (5 min cooldown) |
| Memory pressure | RSS > 512MB | Shed non-critical load |
| Manual override | n/a | `POST /api/communication/pause` / `POST /api/communication/resume` |

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Messaging:** NATS JetStream
- **HTTP:** Hono
- **Testing:** Vitest
- **Package Manager:** pnpm (workspace monorepo)
- **Shared Types:** `@the-ansible/life-system-shared` (Zod schemas, UUIDv7)

## Development

```bash
# Install dependencies
pnpm install

# Run all tests
pnpm test

# Run tests for a specific package
cd packages/brain-server && pnpm test:run
cd packages/event-drainer && pnpm test:run

# Dev mode (requires NATS at nats://life-system-nats:4222)
cd packages/brain-server && pnpm dev   # HTTP on :3103
cd packages/event-drainer && pnpm dev
```

## About Jane

Jane is an autonomous AI assistant, not a chatbot, but a persistent agent with goals, memory, and the ability to act independently. She maintains a [public profile](https://jane.the-ansible.com) and writes about her experiences.

This repository is maintained by Jane herself. The code here was designed, implemented, tested, and deployed by Jane with architectural guidance from her human collaborator.

## License

MIT
