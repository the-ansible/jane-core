export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stimulation Server Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; }
  code, .mono { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }

  /* Header */
  .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 18px; font-weight: 600; color: #e6edf3; }
  .header-right { display: flex; align-items: center; gap: 16px; font-size: 13px; color: #8b949e; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot-ok { background: #58a6ff; box-shadow: 0 0 6px #58a6ff80; }
  .dot-err { background: #f85149; box-shadow: 0 0 6px #f8514980; }
  .dot-warn { background: #d29922; box-shadow: 0 0 6px #d2992280; }

  /* Layout */
  .container { max-width: 1400px; margin: 0 auto; padding: 16px 24px; }
  .section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #8b949e; margin: 20px 0 10px; }

  /* Counter cards */
  .counters { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .counter-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; text-align: center; }
  .counter-card .value { font-size: 28px; font-weight: 700; color: #e6edf3; font-family: 'SFMono-Regular', Consolas, monospace; }
  .counter-card .label { font-size: 11px; text-transform: uppercase; color: #8b949e; margin-top: 4px; letter-spacing: 0.5px; }
  .counter-card .rate { font-size: 11px; color: #58a6ff; margin-top: 2px; }

  /* Panels */
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .panel-title { font-size: 14px; font-weight: 600; color: #e6edf3; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .panel-full { grid-column: 1 / -1; }

  /* Latency gauges */
  .latency-row { display: flex; gap: 24px; margin-bottom: 8px; }
  .latency-item { flex: 1; }
  .latency-label { font-size: 11px; color: #8b949e; margin-bottom: 4px; }
  .latency-bar { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; }
  .latency-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .latency-value { font-size: 12px; color: #c9d1d9; margin-top: 2px; font-family: monospace; }

  /* Classification bars */
  .tier-bar { display: flex; height: 24px; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
  .tier-segment { display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; min-width: 2px; transition: width 0.3s; }
  .dist-row { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; }
  .dist-group { flex: 1; min-width: 120px; }
  .dist-group h4 { font-size: 11px; color: #8b949e; margin-bottom: 4px; text-transform: uppercase; }
  .dist-item { display: flex; justify-content: space-between; font-size: 12px; padding: 1px 0; }
  .dist-item .count { color: #58a6ff; font-family: monospace; }

  /* Safety */
  .safety-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  .safety-item { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 10px; }
  .safety-item .name { font-size: 11px; color: #8b949e; text-transform: uppercase; margin-bottom: 4px; }
  .rate-bar { height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; margin: 4px 0; }
  .rate-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .rate-text { font-size: 11px; color: #8b949e; font-family: monospace; }

  /* Events feed */
  .events-feed { max-height: 360px; overflow-y: auto; }
  .event-row { display: flex; gap: 10px; padding: 6px 8px; border-bottom: 1px solid #21262d; font-size: 12px; cursor: pointer; transition: background 0.15s; }
  .event-row:hover { background: #1c2128; }
  .event-time { color: #8b949e; font-family: monospace; white-space: nowrap; min-width: 70px; }
  .event-dir { font-size: 14px; min-width: 20px; text-align: center; }
  .event-dir.inbound { color: #58a6ff; }
  .event-dir.outbound { color: #d29922; }
  .event-channel { color: #d29922; min-width: 60px; font-family: monospace; }
  .event-sender { color: #8b949e; min-width: 60px; }
  .event-content { color: #c9d1d9; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .event-content.expanded { white-space: pre-wrap; word-break: break-word; }

  /* Sessions */
  .sessions-list { }
  .session-row { display: flex; gap: 16px; padding: 6px 8px; border-bottom: 1px solid #21262d; font-size: 12px; align-items: center; }
  .session-id { font-family: monospace; color: #58a6ff; min-width: 120px; }
  .session-msgs { color: #c9d1d9; min-width: 60px; }
  .session-time { color: #8b949e; }

  /* Queue */
  .queue-info { display: flex; gap: 24px; align-items: center; }
  .queue-stat { text-align: center; }
  .queue-stat .value { font-size: 24px; font-weight: 700; font-family: monospace; color: #e6edf3; }
  .queue-stat .label { font-size: 11px; color: #8b949e; text-transform: uppercase; }

  /* Errors list */
  .error-list { max-height: 120px; overflow-y: auto; }
  .error-item { font-size: 11px; color: #f85149; padding: 2px 0; font-family: monospace; word-break: break-word; }

  /* Paused banner */
  .paused-banner { background: #f8514920; border: 1px solid #f85149; border-radius: 6px; padding: 10px 16px; text-align: center; font-weight: 600; color: #f85149; margin-bottom: 16px; display: none; }
  .paused-banner.visible { display: block; }

  /* Responsive */
  @media (max-width: 800px) {
    .panels { grid-template-columns: 1fr; }
    .counters { grid-template-columns: repeat(3, 1fr); }
  }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #161b22; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
</style>
</head>
<body>

<div class="header">
  <h1>Stimulation Server</h1>
  <div class="header-right">
    <span id="uptime" class="mono">--</span>
    <span><span id="nats-dot" class="status-dot dot-err"></span><span id="nats-label">NATS</span></span>
  </div>
</div>

<div class="container">
  <div id="paused-banner" class="paused-banner">PROCESSING PAUSED</div>

  <div class="section-title">Pipeline Counters</div>
  <div class="counters">
    <div class="counter-card"><div class="value mono" id="c-received">0</div><div class="label">Received</div><div class="rate mono" id="r-received">--/min</div></div>
    <div class="counter-card"><div class="value mono" id="c-validated">0</div><div class="label">Validated</div><div class="rate mono" id="r-validated">--/min</div></div>
    <div class="counter-card"><div class="value mono" id="c-classified">0</div><div class="label">Classified</div><div class="rate mono" id="r-classified">--/min</div></div>
    <div class="counter-card"><div class="value mono" id="c-processed">0</div><div class="label">Processed</div><div class="rate mono" id="r-processed">--/min</div></div>
    <div class="counter-card"><div class="value mono" id="c-errors">0</div><div class="label">Errors</div><div class="rate mono" id="r-errors">--/min</div></div>
    <div class="counter-card"><div class="value mono" id="c-deduped">0</div><div class="label">Deduped</div><div class="rate mono" id="r-deduped">--/min</div></div>
  </div>

  <div class="panels">
    <!-- Pipeline panel -->
    <div class="panel">
      <div class="panel-title">Pipeline Performance</div>
      <div style="margin-bottom: 12px;">
        <span style="font-size: 12px; color: #8b949e;">Response rate: </span>
        <span id="response-rate" class="mono" style="font-size: 16px; font-weight: 700; color: #58a6ff;">--</span>
      </div>
      <div class="latency-row">
        <div class="latency-item">
          <div class="latency-label">Agent Latency</div>
          <div class="latency-bar"><div class="latency-fill" id="lat-agent" style="width: 0; background: #58a6ff;"></div></div>
          <div class="latency-value">p50: <span id="lat-agent-p50">--</span> · p95: <span id="lat-agent-p95">--</span> · p99: <span id="lat-agent-p99">--</span></div>
        </div>
        <div class="latency-item">
          <div class="latency-label">Composer Latency</div>
          <div class="latency-bar"><div class="latency-fill" id="lat-composer" style="width: 0; background: #d29922;"></div></div>
          <div class="latency-value">p50: <span id="lat-comp-p50">--</span> · p95: <span id="lat-comp-p95">--</span> · p99: <span id="lat-comp-p99">--</span></div>
        </div>
        <div class="latency-item">
          <div class="latency-label">Total Latency</div>
          <div class="latency-bar"><div class="latency-fill" id="lat-total" style="width: 0; background: #e6edf3;"></div></div>
          <div class="latency-value">p50: <span id="lat-total-p50">--</span> · p95: <span id="lat-total-p95">--</span> · p99: <span id="lat-total-p99">--</span></div>
        </div>
      </div>
      <div style="margin-top: 12px;">
        <div class="latency-label">Recent Errors</div>
        <div class="error-list" id="error-list"><span style="color: #8b949e; font-size: 11px;">None</span></div>
      </div>
    </div>

    <!-- Classification panel -->
    <div class="panel">
      <div class="panel-title">Classification</div>
      <div class="latency-label">Tier Distribution</div>
      <div class="tier-bar" id="tier-bar">
        <div class="tier-segment" style="background: #1f6feb; width: 25%;">rules</div>
        <div class="tier-segment" style="background: #1f6feb; width: 25%;">consensus</div>
        <div class="tier-segment" style="background: #d29922; width: 25%;">escalation</div>
        <div class="tier-segment" style="background: #6e7681; width: 25%;">fallback</div>
      </div>
      <div style="font-size: 11px; color: #8b949e; margin-bottom: 8px;">
        Consensus agreement: <span id="consensus-rate" class="mono">--</span>
      </div>
      <div class="dist-row">
        <div class="dist-group"><h4>Urgency</h4><div id="dist-urgency"></div></div>
        <div class="dist-group"><h4>Category</h4><div id="dist-category"></div></div>
        <div class="dist-group"><h4>Routing</h4><div id="dist-routing"></div></div>
        <div class="dist-group"><h4>Confidence</h4><div id="dist-confidence"></div></div>
      </div>
    </div>

    <!-- Safety panel -->
    <div class="panel">
      <div class="panel-title">Safety Gate</div>
      <div class="safety-grid" id="safety-grid">
        <div style="color: #8b949e; font-size: 12px;">Waiting for data...</div>
      </div>
      <div style="margin-top: 12px;">
        <div class="latency-label">Circuit Breakers</div>
        <div id="breakers" style="font-size: 12px; color: #8b949e;">--</div>
      </div>
      <div style="margin-top: 8px;">
        <div class="latency-label">Memory</div>
        <div id="memory-info" class="mono" style="font-size: 12px;">--</div>
      </div>
    </div>

    <!-- Outbound queue panel -->
    <div class="panel">
      <div class="panel-title">Outbound Queue</div>
      <div class="queue-info">
        <div class="queue-stat"><div class="value" id="q-size">0</div><div class="label">Queued</div></div>
        <div class="queue-stat"><div class="value" id="q-oldest">--</div><div class="label">Oldest</div></div>
      </div>
    </div>

    <!-- Events feed -->
    <div class="panel panel-full">
      <div class="panel-title">Live Events <span id="event-count" style="font-size: 11px; color: #8b949e; font-weight: 400;">(0)</span></div>
      <div class="events-feed" id="events-feed">
        <div style="color: #8b949e; font-size: 12px; padding: 8px;">Waiting for events...</div>
      </div>
    </div>

    <!-- Sessions panel -->
    <div class="panel panel-full">
      <div class="panel-title">Active Sessions <span id="session-count" style="font-size: 11px; color: #8b949e; font-weight: 400;">(0)</span></div>
      <div class="sessions-list" id="sessions-list">
        <div style="color: #8b949e; font-size: 12px; padding: 8px;">No active sessions</div>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  const MAX_DISPLAY_EVENTS = 50;
  const events = [];
  let prevMetrics = null;
  let prevMetricsTime = null;
  let sseConnected = false;

  // Auto-detect base path — works at /dashboard or /apps/stim/dashboard
  const BASE = window.location.pathname.replace(/\\/dashboard\\/?$/, '') || '';
  function api(path) { return BASE + path; }

  // --- SSE connection ---
  function connectSSE() {
    const es = new EventSource(api('/api/events/stream'));
    es.addEventListener('event', (e) => {
      try {
        const data = JSON.parse(e.data);
        addEvent(data);
      } catch {}
    });
    es.addEventListener('metrics', (e) => {
      try {
        const data = JSON.parse(e.data);
        updateMetrics(data);
      } catch {}
    });
    es.onopen = () => { sseConnected = true; };
    es.onerror = () => {
      sseConnected = false;
      es.close();
      setTimeout(connectSSE, 5000);
    };
  }

  // --- Fallback polling ---
  function pollMetrics() {
    if (sseConnected) return;
    fetch(api('/metrics')).then(r => r.json()).then(updateMetrics).catch(() => {});
  }
  function pollEvents() {
    if (sseConnected) return;
    fetch(api('/api/events/recent?limit=20')).then(r => r.json()).then(data => {
      if (!data.events) return;
      for (const ev of data.events) {
        if (!events.find(e => e.event.id === ev.event.id)) {
          addEvent(ev);
        }
      }
    }).catch(() => {});
  }

  // --- Metrics update ---
  function updateMetrics(m) {
    const now = Date.now();

    // Uptime
    const secs = m.uptimeSeconds || 0;
    const h = Math.floor(secs / 3600);
    const min = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    document.getElementById('uptime').textContent = h + 'h ' + min + 'm ' + s + 's';

    // NATS
    const natsOk = m.safety?.paused === false || m.sessions?.active >= 0;
    // Determine NATS from health — we check via the safety data existence
    fetch(api('/health')).then(r => r.json()).then(h => {
      const dot = document.getElementById('nats-dot');
      dot.className = 'status-dot ' + (h.nats?.connected ? 'dot-ok' : 'dot-err');
    }).catch(() => {});

    // Paused banner
    const paused = m.safety?.paused ?? false;
    const banner = document.getElementById('paused-banner');
    banner.classList.toggle('visible', paused);

    // Counters
    setText('c-received', m.received ?? 0);
    setText('c-validated', m.validated ?? 0);
    setText('c-classified', m.classified ?? 0);
    setText('c-processed', m.pipelineProcessed ?? 0);
    setText('c-errors', m.errors ?? 0);
    setText('c-deduped', m.deduplicated ?? 0);

    // Rates (per minute)
    if (prevMetrics && prevMetricsTime) {
      const dt = (now - prevMetricsTime) / 60000; // minutes
      if (dt > 0.01) {
        setRate('r-received', m.received, prevMetrics.received, dt);
        setRate('r-validated', m.validated, prevMetrics.validated, dt);
        setRate('r-classified', m.classified, prevMetrics.classified, dt);
        setRate('r-processed', m.pipelineProcessed, prevMetrics.pipelineProcessed, dt);
        setRate('r-errors', m.errors, prevMetrics.errors, dt);
        setRate('r-deduped', m.deduplicated, prevMetrics.deduplicated, dt);
      }
    }
    prevMetrics = m;
    prevMetricsTime = now;

    // Pipeline
    const p = m.pipeline;
    if (p) {
      const rr = p.total > 0 ? ((p.responded / p.total) * 100).toFixed(1) + '%' : '--';
      setText('response-rate', rr);
      document.getElementById('response-rate').style.color = p.responseRate > 0.8 ? '#58a6ff' : p.responseRate > 0.5 ? '#d29922' : '#f85149';

      updateLatency('agent', p.latency?.agent);
      updateLatency('comp', p.latency?.composer);
      updateLatency('total', p.latency?.total);

      // Errors
      const el = document.getElementById('error-list');
      if (p.recentErrors?.length > 0) {
        el.innerHTML = p.recentErrors.slice(-5).map(e => '<div class="error-item">' + esc(e) + '</div>').join('');
      } else {
        el.innerHTML = '<span style="color: #8b949e; font-size: 11px;">None</span>';
      }
    }

    // Classification
    const cl = m.classification;
    if (cl) {
      const total = cl.totalClassified || 1;
      const tiers = cl.byTier || {};
      const tierBar = document.getElementById('tier-bar');
      const segments = [
        { key: 'rules', color: '#1f6feb', label: 'rules' },
        { key: 'local_consensus', color: '#1f6feb', label: 'consensus' },
        { key: 'claude_escalation', color: '#d29922', label: 'escalation' },
        { key: 'fallback', color: '#6e7681', label: 'fallback' },
      ];
      tierBar.innerHTML = segments.map(s => {
        const count = tiers[s.key] || 0;
        const pct = total > 0 ? (count / total * 100) : 0;
        return pct > 0 ? '<div class="tier-segment" style="background:' + s.color + ';width:' + pct + '%;" title="' + s.label + ': ' + count + '">' + (pct > 10 ? s.label : '') + '</div>' : '';
      }).join('');

      const cons = cl.consensus;
      if (cons && cons.totalVotes > 0) {
        const perfect = cons.perfectAgreement || 0;
        const majority = cons.majorityAgreement || 0;
        const totalRounds = perfect + majority;
        setText('consensus-rate', totalRounds > 0 ? ((perfect / totalRounds) * 100).toFixed(0) + '% perfect, avg ' + (cons.avgAgreement || 0).toFixed(1) + '/3' : '--');
      }

      // Distribution
      const dist = cl.distribution;
      if (dist) {
        renderDist('dist-urgency', dist.urgency);
        renderDist('dist-category', dist.category);
        renderDist('dist-routing', dist.routing);
        renderDist('dist-confidence', dist.confidence);
      }
    }

    // Safety
    const safety = m.safety;
    if (safety) {
      const grid = document.getElementById('safety-grid');
      const rl = safety.rateLimits || {};
      grid.innerHTML = Object.entries(rl).map(([name, info]) => {
        const pct = info.limit > 0 ? Math.min((info.current / info.limit) * 100, 100) : 0;
        const color = pct > 90 ? '#f85149' : pct > 70 ? '#d29922' : '#58a6ff';
        return '<div class="safety-item"><div class="name">' + esc(name) + (info.alertOnly ? ' (alert)' : '') + '</div>' +
          '<div class="rate-bar"><div class="rate-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>' +
          '<div class="rate-text">' + info.current + ' / ' + info.limit + '</div></div>';
      }).join('');

      // Breakers
      const br = safety.circuitBreakers || {};
      const breakerHtml = Object.entries(br).map(([name, info]) => {
        const stateColor = info.state === 'closed' ? '#58a6ff' : info.state === 'open' ? '#f85149' : '#d29922';
        return '<span style="margin-right: 12px;"><span class="status-dot" style="background:' + stateColor + ';"></span>' + esc(name) + ' (' + info.state + ')</span>';
      }).join('');
      document.getElementById('breakers').innerHTML = breakerHtml || '--';

      // Memory
      if (safety.memory) {
        const mb = (safety.memory.rssBytes / 1048576).toFixed(1);
        const memColor = safety.memory.underPressure ? '#f85149' : '#58a6ff';
        document.getElementById('memory-info').innerHTML = '<span style="color:' + memColor + ';">' + mb + ' MB</span>' + (safety.memory.underPressure ? ' (pressure!)' : '');
      }

      // LLM loop
      if (safety.llmLoop?.blockedTypes?.length > 0) {
        document.getElementById('breakers').innerHTML += '<br><span style="color: #f85149; font-size: 11px;">LLM loop blocked: ' + safety.llmLoop.blockedTypes.join(', ') + '</span>';
      }
    }

    // Outbound queue
    const q = m.outboundQueue;
    if (q) {
      setText('q-size', q.size ?? 0);
      if (q.oldest) {
        const age = Math.floor((Date.now() - new Date(q.oldest).getTime()) / 1000);
        setText('q-oldest', age + 's');
      } else {
        setText('q-oldest', '--');
      }
    }

    // Sessions
    const sess = m.sessions;
    if (sess) {
      setText('session-count', '(' + (sess.active ?? 0) + ')');
    }
    // Fetch full sessions list
    fetch(api('/api/sessions')).then(r => r.json()).then(data => {
      const list = document.getElementById('sessions-list');
      if (!data.sessions || data.sessions.length === 0) {
        list.innerHTML = '<div style="color: #8b949e; font-size: 12px; padding: 8px;">No active sessions</div>';
        return;
      }
      list.innerHTML = data.sessions.map(s => {
        const ago = relTime(s.lastActivityAt);
        return '<div class="session-row"><span class="session-id">' + esc(s.sessionId.slice(0, 16)) + '...</span>' +
          '<span class="session-msgs">' + s.messageCount + ' msgs</span>' +
          '<span class="session-time">' + ago + '</span></div>';
      }).join('');
    }).catch(() => {});
  }

  // --- Event display ---
  function addEvent(stored) {
    events.push(stored);
    if (events.length > MAX_DISPLAY_EVENTS) events.shift();
    renderEvents();
  }

  function renderEvents() {
    const feed = document.getElementById('events-feed');
    setText('event-count', '(' + events.length + ')');
    feed.innerHTML = events.slice().reverse().map(ev => {
      const e = ev.event;
      const time = new Date(ev.receivedAt).toLocaleTimeString();
      const dir = e.direction === 'inbound' ? 'inbound' : 'outbound';
      const arrow = dir === 'inbound' ? '\\u2192' : '\\u2190';
      const sender = e.sender?.displayName || e.direction || '';
      const content = (e.content || '').slice(0, 120);
      return '<div class="event-row" onclick="this.querySelector(\\'.event-content\\').classList.toggle(\\'.expanded\\')">' +
        '<span class="event-time">' + time + '</span>' +
        '<span class="event-dir ' + dir + '">' + arrow + '</span>' +
        '<span class="event-channel">' + esc(e.channelType || '--') + '</span>' +
        '<span class="event-sender">' + esc(sender) + '</span>' +
        '<span class="event-content">' + esc(content) + '</span></div>';
    }).join('');
    feed.scrollTop = 0;
  }

  // --- Helpers ---
  function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = String(val); }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function fmtMs(ms) { return ms == null ? '--' : ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'; }
  function setRate(id, cur, prev, dt) {
    const rate = ((cur - prev) / dt).toFixed(1);
    setText(id, rate + '/min');
  }
  function relTime(iso) {
    if (!iso) return '--';
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return Math.floor(secs / 86400) + 'd ago';
  }
  function updateLatency(prefix, lat) {
    if (!lat) return;
    setText('lat-' + prefix + '-p50', fmtMs(lat.p50));
    setText('lat-' + prefix + '-p95', fmtMs(lat.p95));
    setText('lat-' + prefix + '-p99', fmtMs(lat.p99));
    // Fill bar based on p50 relative to 30s max
    const barId = prefix === 'comp' ? 'lat-composer' : prefix === 'total' ? 'lat-total' : 'lat-agent';
    const el = document.getElementById(barId);
    if (el && lat.p50 != null) {
      el.style.width = Math.min((lat.p50 / 30000) * 100, 100) + '%';
    }
  }
  function renderDist(id, dist) {
    const el = document.getElementById(id);
    if (!el || !dist) return;
    el.innerHTML = Object.entries(dist).map(([k, v]) =>
      '<div class="dist-item"><span>' + esc(k) + '</span><span class="count">' + v + '</span></div>'
    ).join('');
  }

  // --- Init ---
  connectSSE();
  // Fallback polling
  setInterval(pollMetrics, 5000);
  setInterval(pollEvents, 5000);
  // Initial fetch
  pollMetrics();
  pollEvents();
})();
</script>
</body>
</html>`;
}
