# Jane System Health Check

A living smoke test for the Jane stack. Run after container resets, large changes, or backup restore validation.

## Usage

```bash
chmod +x jane-system-health.sh
./jane-system-health.sh
```

Exit codes: `0` = all pass or warnings only, `1` = one or more failures.

## What It Checks

| Section | Details |
|---------|---------|
| PM2 Processes | kanban-api, canvas-api, canvas-web, stimulation-server, event-drainer, good-morning-scheduler |
| HTTP Health | :3000, :3001, :3102, :3103 |
| PostgreSQL | Connection + schemas: kanban, canvas, brain |
| NATS | life-system-nats:4222 |
| Critical Files | INNER_VOICE.md, vault, sessions, memory, lessons-learned.md |
| Scheduler | jobs.json present and parseable |

## Updating

See the `HOW TO UPDATE` comment at the top of the script. Update the relevant array and bump the `VERSION` line.

## Restore Validation Checklist

After restoring into a fresh container:

1. `./jane-system-health.sh` — should pass all checks
2. Verify a vault file is readable: `cat /agent/data/vault/Projects/jane-core/Voice-Profile.md`
3. Confirm sessions dir has content: `ls /agent/data/sessions/`
4. Check PM2 list: `pm2 list`
5. Hit the stimulation dashboard: `curl http://localhost:3102/health`
