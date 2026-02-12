export function renderReceiptsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Spell Receipts UI</title>
  <style>
    :root {
      --bg: #0d1b2a;
      --panel: #1b263b;
      --panel-2: #23344f;
      --text: #e0e7ff;
      --muted: #94a3b8;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
      --accent: #38bdf8;
      --border: #334155;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--text);
      background: radial-gradient(circle at top right, #0b2e4f, #0d1b2a 40%);
      min-height: 100vh;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .panel {
      background: linear-gradient(180deg, var(--panel), var(--panel-2));
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      overflow: auto;
      min-height: 320px;
    }
    h1 { margin: 0 0 12px 0; font-size: 24px; }
    h2 { margin: 0 0 10px 0; font-size: 18px; }
    .hint { color: var(--muted); font-size: 13px; margin-bottom: 12px; }
    .card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      margin-bottom: 10px;
      background: rgba(2, 6, 23, 0.4);
    }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    label { font-size: 13px; color: var(--muted); }
    input[type="text"], textarea {
      width: 100%;
      background: #0b1220;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      padding: 8px;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
    }
    textarea { min-height: 120px; }
    button {
      border: 1px solid var(--accent);
      background: #0c4a6e;
      color: #e0f2fe;
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-weight: 600;
    }
    button.secondary {
      background: #1e293b;
      border-color: var(--border);
      color: var(--text);
    }
    .status { font-weight: 700; }
    .status.succeeded { color: var(--ok); }
    .status.failed, .status.timeout { color: var(--err); }
    .status.running, .status.queued { color: var(--warn); }
    .pill {
      display: inline-block;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      color: var(--muted);
      margin-right: 6px;
    }
    pre {
      background: #020617;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      overflow: auto;
      font-size: 12px;
      margin: 0;
    }
    .full { grid-column: 1 / -1; }
    @media (max-width: 960px) {
      .container { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <section class="panel full">
      <h1>Spell Receipts UI</h1>
      <div class="hint">Button registry drives execution. Client sends button_id only.</div>
      <div class="row">
        <button id="reloadButtons" class="secondary">Reload Buttons</button>
        <button id="reloadExecutions" class="secondary">Reload Executions</button>
      </div>
    </section>

    <section class="panel" id="buttonsPanel">
      <h2>Buttons</h2>
      <div class="hint">Generated from /api/buttons.</div>
      <div id="buttons"></div>
    </section>

    <section class="panel" id="executionsPanel">
      <h2>Executions</h2>
      <div class="hint">Shows queued/running/succeeded/failed.</div>
      <div id="executions"></div>
    </section>

    <section class="panel" id="formPanel">
      <h2>Run Button</h2>
      <div class="hint">Guard confirmations are required only when configured by button registry.</div>
      <form id="runForm">
        <div class="row">
          <div style="flex:1">
            <label>button_id</label>
            <input id="buttonId" type="text" readonly />
          </div>
          <div style="width:160px">
            <label>actor_role</label>
            <input id="actorRole" type="text" value="admin" />
          </div>
        </div>

        <div class="row" style="margin-top:8px">
          <label><input id="dryRun" type="checkbox" /> dry_run</label>
          <label><input id="riskAck" type="checkbox" /> risk_acknowledged</label>
          <label><input id="billingAck" type="checkbox" /> billing_acknowledged</label>
        </div>

        <div style="margin-top:8px">
          <label>input JSON (merged over defaults)</label>
          <textarea id="inputJson">{}</textarea>
        </div>

        <div class="row" style="margin-top:10px">
          <button type="submit">POST /api/spell-executions</button>
          <button id="clearSelection" type="button" class="secondary">Clear</button>
        </div>
      </form>
      <div style="margin-top:10px">
        <label>Last API response</label>
        <pre id="lastResponse">{}</pre>
      </div>
    </section>

    <section class="panel" id="detailPanel">
      <h2>Execution Detail</h2>
      <div class="hint">Sanitized receipt only. Raw stdout/stderr is not exposed.</div>
      <pre id="executionDetail">{}</pre>
    </section>
  </div>
  <script type="module" src="/ui/app.js"></script>
</body>
</html>`;
}

export function renderReceiptsClientJs(): string {
  return [
    "const state = {",
    "  buttons: [],",
    "  executions: [],",
    "  selectedButton: null,",
    "  selectedExecutionId: null",
    "};",
    "",
    "const el = {",
    '  buttons: document.getElementById("buttons"),',
    '  executions: document.getElementById("executions"),',
    '  buttonId: document.getElementById("buttonId"),',
    '  actorRole: document.getElementById("actorRole"),',
    '  dryRun: document.getElementById("dryRun"),',
    '  riskAck: document.getElementById("riskAck"),',
    '  billingAck: document.getElementById("billingAck"),',
    '  inputJson: document.getElementById("inputJson"),',
    '  runForm: document.getElementById("runForm"),',
    '  lastResponse: document.getElementById("lastResponse"),',
    '  executionDetail: document.getElementById("executionDetail")',
    "};",
    "",
    'document.getElementById("reloadButtons").addEventListener("click", loadButtons);',
    'document.getElementById("reloadExecutions").addEventListener("click", loadExecutions);',
    'document.getElementById("clearSelection").addEventListener("click", clearSelection);',
    "el.runForm.addEventListener('submit', submitExecution);",
    "",
    "async function loadButtons() {",
    "  const res = await fetch('/api/buttons');",
    "  const payload = await res.json();",
    "  state.buttons = payload.buttons || [];",
    "  renderButtons();",
    "}",
    "",
    "function renderButtons() {",
    "  el.buttons.innerHTML = '';",
    "  if (state.buttons.length === 0) {",
    "    el.buttons.textContent = 'No buttons';",
    "    return;",
    "  }",
    "",
    "  for (const button of state.buttons) {",
    "    const card = document.createElement('div');",
    "    card.className = 'card';",
    "    card.innerHTML = [",
    "      '<div><strong>' + escapeHtml(button.label || button.button_id) + '</strong></div>',",
    "      '<div class=\"hint\">button_id: ' + escapeHtml(button.button_id) + '</div>',",
    "      '<div class=\"hint\">spell: ' + escapeHtml(button.spell_id) + '@' + escapeHtml(button.version) + '</div>',",
    "      '<div><span class=\"pill\">risk:' + String(button.required_confirmations.risk) + '</span><span class=\"pill\">billing:' + String(button.required_confirmations.billing) + '</span></div>',",
    "      '<div style=\"margin-top:8px\"><button data-button-id=\"' + escapeHtml(button.button_id) + '\">Select</button></div>'",
    "    ].join('');",
    "    el.buttons.appendChild(card);",
    "  }",
    "",
    "  for (const button of el.buttons.querySelectorAll('button[data-button-id]')) {",
    "    button.addEventListener('click', () => selectButton(button.getAttribute('data-button-id')));",
    "  }",
    "}",
    "",
    "function selectButton(buttonId) {",
    "  const found = state.buttons.find((b) => b.button_id === buttonId);",
    "  if (!found) return;",
    "  state.selectedButton = found;",
    "  el.buttonId.value = found.button_id;",
    "  el.riskAck.checked = false;",
    "  el.billingAck.checked = false;",
    "  el.inputJson.value = JSON.stringify({}, null, 2);",
    "}",
    "",
    "function clearSelection() {",
    "  state.selectedButton = null;",
    "  el.buttonId.value = '';",
    "  el.inputJson.value = '{}';",
    "  el.riskAck.checked = false;",
    "  el.billingAck.checked = false;",
    "}",
    "",
    "async function submitExecution(event) {",
    "  event.preventDefault();",
    "  if (!state.selectedButton) {",
    "    setLastResponse({ ok: false, message: 'Select a button first' });",
    "    return;",
    "  }",
    "",
    "  let input;",
    "  try {",
    "    input = JSON.parse(el.inputJson.value || '{}');",
    "  } catch {",
    "    setLastResponse({ ok: false, message: 'input JSON is invalid' });",
    "    return;",
    "  }",
    "",
    "  const body = {",
    "    button_id: state.selectedButton.button_id,",
    "    dry_run: el.dryRun.checked,",
    "    actor_role: el.actorRole.value || 'anonymous',",
    "    input,",
    "    confirmation: {",
    "      risk_acknowledged: el.riskAck.checked,",
    "      billing_acknowledged: el.billingAck.checked",
    "    }",
    "  };",
    "",
    "  const res = await fetch('/api/spell-executions', {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    "    body: JSON.stringify(body)",
    "  });",
    "  const payload = await res.json();",
    "  setLastResponse(payload);",
    "",
    "  if (payload.execution_id) {",
    "    state.selectedExecutionId = payload.execution_id;",
    "  }",
    "",
    "  await loadExecutions();",
    "}",
    "",
    "async function loadExecutions() {",
    "  const res = await fetch('/api/spell-executions');",
    "  const payload = await res.json();",
    "  state.executions = payload.executions || [];",
    "  renderExecutions();",
    "",
    "  if (state.selectedExecutionId) {",
    "    await loadExecutionDetail(state.selectedExecutionId);",
    "  }",
    "}",
    "",
    "function renderExecutions() {",
    "  el.executions.innerHTML = '';",
    "  if (state.executions.length === 0) {",
    "    el.executions.textContent = 'No executions';",
    "    return;",
    "  }",
    "",
    "  for (const execution of state.executions) {",
    "    const card = document.createElement('div');",
    "    card.className = 'card';",
    "    card.innerHTML = [",
    "      '<div class=\"status ' + escapeHtml(execution.status) + '\">' + escapeHtml(execution.status) + '</div>',",
    "      '<div class=\"hint\">' + escapeHtml(execution.execution_id) + '</div>',",
    "      '<div class=\"hint\">' + escapeHtml(execution.button_id) + ' -> ' + escapeHtml(execution.spell_id) + '@' + escapeHtml(execution.version) + '</div>',",
    "      '<div><button data-exec-id=\"' + escapeHtml(execution.execution_id) + '\">View</button></div>'",
    "    ].join('');",
    "    el.executions.appendChild(card);",
    "  }",
    "",
    "  for (const button of el.executions.querySelectorAll('button[data-exec-id]')) {",
    "    button.addEventListener('click', () => {",
    "      const id = button.getAttribute('data-exec-id');",
    "      state.selectedExecutionId = id;",
    "      loadExecutionDetail(id);",
    "    });",
    "  }",
    "}",
    "",
    "async function loadExecutionDetail(executionId) {",
    "  const res = await fetch('/api/spell-executions/' + encodeURIComponent(executionId));",
    "  const payload = await res.json();",
    "  el.executionDetail.textContent = JSON.stringify(payload, null, 2);",
    "}",
    "",
    "function setLastResponse(payload) {",
    "  el.lastResponse.textContent = JSON.stringify(payload, null, 2);",
    "}",
    "",
    "function escapeHtml(value) {",
    "  return String(value)",
    "    .replaceAll('&', '&amp;')",
    "    .replaceAll('<', '&lt;')",
    "    .replaceAll('>', '&gt;')",
    "    .replaceAll('\"', '&quot;')",
    "    .replaceAll(\"'\", '&#039;');",
    "}",
    "",
    "loadButtons();",
    "loadExecutions();",
    "setInterval(loadExecutions, 2000);",
    ""
  ].join("\n");
}
