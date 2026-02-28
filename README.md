# jane-core

Core infrastructure for [Jane](https://jane.the-ansible.com) — an autonomous AI personal assistant built on Claude.

This monorepo contains the communication pipeline, event processing, and safety systems that form Jane's nervous system.

## Packages

### [`stimulation-server`](./packages/stimulation-server/)

Always-on NATS JetStream consumer that receives inbound communication events, validates them, and (soon) classifies and responds. Named after the biological stimulus-response model — external stimuli arrive, get classified by urgency and type, and route to the appropriate response pathway.

**Features:**
- Durable pull consumer on NATS JetStream COMMUNICATION stream
- Event validation against shared Zod schema (`communicationEventSchema`)
- Safety layer: rate limits, circuit breakers, flood detection, LLM loop detection, memory pressure monitoring
- Manual pause/resume controls for human override
- Admin/debug HTTP endpoints for interactive testing
- 64 tests across 6 suites

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
│ Stimu-  │  │ Event    │
│ lation  │  │ Drainer  │
│ Server  │  │          │
│         │  │ → JSONL  │
│ Classify│  │   files  │
│ Respond │  └──────────┘
│ Safety  │
└─────────┘
```

## Safety Systems

The stimulation server includes comprehensive safety controls:

| Mechanism | Threshold | Action |
|-----------|-----------|--------|
| Outbound rate limit | 30/hour | Block sends |
| Local LLM rate limit | 100/hour | Degrade to rules-only |
| Claude API rate limit | 10/hour | Hard stop |
| Total event throughput | 500/hour | Stop actions, continue logging |
| Consecutive errors | 5 failures | Circuit breaker open (5 min cooldown) |
| Outbound flood | >10/minute | Hard stop (manual reset required) |
| LLM loop detection | >3 calls/event type | Block that event type |
| Memory pressure | RSS > 512MB | Shed non-critical load |
| Manual override | — | `POST /api/pause` / `POST /api/resume` |

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
cd packages/stimulation-server && pnpm test:run
cd packages/event-drainer && pnpm test:run

# Dev mode (requires NATS at nats://life-system-nats:4222)
cd packages/stimulation-server && pnpm dev   # HTTP on :3102
cd packages/event-drainer && pnpm dev
```

## About Jane

Jane is an autonomous AI assistant — not a chatbot, but a persistent agent with goals, memory, and the ability to act independently. She maintains a [public profile](https://jane.the-ansible.com) and writes about her experiences.

This repository is maintained by Jane herself. The code here was designed, implemented, tested, and deployed by Jane with architectural guidance from her human collaborator.

## License

MIT
