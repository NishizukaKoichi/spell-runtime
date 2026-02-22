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
    .status.failed, .status.timeout, .status.canceled { color: var(--err); }
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
        <div style="width:360px">
          <label>API token (optional; required when server auth is enabled)</label>
          <input id="apiToken" type="text" placeholder="paste token for Authorization: Bearer ..." />
        </div>
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
      <div class="hint">Shows queued/running/succeeded/failed/timeout/canceled, with API filters.</div>
      <div class="row" style="margin-bottom:10px">
        <div style="width:200px">
          <label>status filter</label>
          <select id="executionStatus" style="width:100%;background:#0b1220;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px">
            <option value="">all</option>
            <option value="queued">queued</option>
            <option value="running">running</option>
            <option value="succeeded">succeeded</option>
            <option value="failed">failed</option>
            <option value="timeout">timeout</option>
            <option value="canceled">canceled</option>
          </select>
        </div>
        <div style="width:120px">
          <label>limit</label>
          <input id="executionLimit" type="text" value="20" />
        </div>
        <div style="flex:1; min-width:220px">
          <label>button_id filter</label>
          <input id="executionButtonId" type="text" placeholder="publish_site_high_risk" />
        </div>
      </div>
      <div class="row" style="margin-bottom:10px">
        <div style="flex:1; min-width:220px">
          <label>spell_id filter</label>
          <input id="executionSpellId" type="text" placeholder="samples/publish-site" />
        </div>
        <div style="flex:1; min-width:180px">
          <label>tenant_id filter</label>
          <input id="executionTenantId" type="text" placeholder="team_a" />
        </div>
        <div style="flex:1; min-width:220px">
          <label>from (ISO-8601)</label>
          <input id="executionFrom" type="text" placeholder="2026-01-01T00:00:00.000Z" />
        </div>
        <div style="flex:1; min-width:220px">
          <label>to (ISO-8601)</label>
          <input id="executionTo" type="text" placeholder="2026-01-31T23:59:59.999Z" />
        </div>
      </div>
      <div id="executions"></div>
    </section>

    <section class="panel" id="formPanel">
      <h2>Run Button</h2>
      <div class="hint">Guard confirmations and signature policy are driven by button registry and server policy.</div>
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
        <div class="hint" id="guardHint" style="margin-top:8px">Select a button to see required confirmations.</div>
        <div class="hint" id="roleHint">Allowed roles: -</div>
        <div class="hint" id="tenantHint">Allowed tenants: -</div>

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
      <div class="hint" id="executionLinks">Retry links: none</div>
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
    "let executionStreamController = null;",
    "let executionStreamExecutionId = null;",
    "let listStreamController = null;",
    "let listStreamSignature = null;",
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
    '  executionDetail: document.getElementById("executionDetail"),',
    '  executionLinks: document.getElementById("executionLinks"),',
    '  guardHint: document.getElementById("guardHint"),',
    '  roleHint: document.getElementById("roleHint"),',
    '  tenantHint: document.getElementById("tenantHint"),',
    '  executionStatus: document.getElementById("executionStatus"),',
    '  executionLimit: document.getElementById("executionLimit"),',
    '  executionButtonId: document.getElementById("executionButtonId"),',
    '  executionSpellId: document.getElementById("executionSpellId"),',
    '  executionTenantId: document.getElementById("executionTenantId"),',
    '  executionFrom: document.getElementById("executionFrom"),',
    '  executionTo: document.getElementById("executionTo"),',
    '  apiToken: document.getElementById("apiToken")',
    "};",
    "",
    'document.getElementById("reloadButtons").addEventListener("click", loadButtons);',
    'document.getElementById("reloadExecutions").addEventListener("click", loadExecutions);',
    'document.getElementById("clearSelection").addEventListener("click", clearSelection);',
    "el.executionStatus.addEventListener('change', loadExecutions);",
    "el.executionLimit.addEventListener('change', loadExecutions);",
    "el.executionButtonId.addEventListener('change', loadExecutions);",
    "el.executionSpellId.addEventListener('change', loadExecutions);",
    "el.executionTenantId.addEventListener('change', loadExecutions);",
    "el.executionFrom.addEventListener('change', loadExecutions);",
    "el.executionTo.addEventListener('change', loadExecutions);",
    "el.apiToken.addEventListener('change', () => { stopExecutionStream(); stopListStream(); loadButtons(); loadExecutions(); });",
    "el.runForm.addEventListener('submit', submitExecution);",
    "",
    "async function loadButtons() {",
    "  const res = await fetch('/api/buttons', { headers: makeApiHeaders(false) });",
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
    "    const tenantHint = Array.isArray(button.allowed_tenants) && button.allowed_tenants.length > 0 ? button.allowed_tenants.join(',') : 'all';",
    "    const card = document.createElement('div');",
    "    card.className = 'card';",
    "    card.innerHTML = [",
    "      '<div><strong>' + escapeHtml(button.label || button.button_id) + '</strong></div>',",
    "      '<div class=\"hint\">button_id: ' + escapeHtml(button.button_id) + '</div>',",
    "      '<div class=\"hint\">spell: ' + escapeHtml(button.spell_id) + '@' + escapeHtml(button.version) + '</div>',",
    "      '<div class=\"hint\">allowed roles: ' + escapeHtml((button.allowed_roles || []).join(',')) + '</div>',",
    "      '<div class=\"hint\">allowed tenants: ' + escapeHtml(tenantHint) + '</div>',",
    "      '<div><span class=\"pill\">risk:' + String(button.required_confirmations.risk) + '</span><span class=\"pill\">billing:' + String(button.required_confirmations.billing) + '</span><span class=\"pill\">signature:' + String(Boolean(button.require_signature)) + '</span></div>',",
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
    "  updateGuardHints();",
    "}",
    "",
    "function clearSelection() {",
    "  state.selectedButton = null;",
    "  el.buttonId.value = '';",
    "  el.inputJson.value = '{}';",
    "  el.riskAck.checked = false;",
    "  el.billingAck.checked = false;",
    "  stopExecutionStream();",
    "  state.selectedExecutionId = null;",
    "  el.executionDetail.textContent = '{}';",
    "  renderExecutionLinks({});",
    "  updateGuardHints();",
    "}",
    "",
    "function updateGuardHints() {",
    "  if (!state.selectedButton) {",
    "    el.guardHint.textContent = 'Select a button to see required confirmations.';",
    "    el.roleHint.textContent = 'Allowed roles: -';",
    "    el.tenantHint.textContent = 'Allowed tenants: -';",
    "    el.riskAck.checked = false;",
    "    el.billingAck.checked = false;",
    "    el.riskAck.disabled = true;",
    "    el.billingAck.disabled = true;",
    "    return;",
    "  }",
    "",
    "  const requiredRisk = Boolean(state.selectedButton.required_confirmations && state.selectedButton.required_confirmations.risk);",
    "  const requiredBilling = Boolean(state.selectedButton.required_confirmations && state.selectedButton.required_confirmations.billing);",
    "  const requiredSignature = Boolean(state.selectedButton.require_signature);",
    "  el.riskAck.disabled = !requiredRisk;",
    "  el.billingAck.disabled = !requiredBilling;",
    "  if (!requiredRisk) el.riskAck.checked = false;",
    "  if (!requiredBilling) el.billingAck.checked = false;",
    "",
    "  el.guardHint.textContent = 'Required checks: risk=' + String(requiredRisk) + ', billing=' + String(requiredBilling) + ', signature=' + String(requiredSignature);",
    "  el.roleHint.textContent = 'Allowed roles: ' + (state.selectedButton.allowed_roles || []).join(', ');",
    "  const allowedTenants = Array.isArray(state.selectedButton.allowed_tenants) && state.selectedButton.allowed_tenants.length > 0",
    "    ? state.selectedButton.allowed_tenants.join(', ')",
    "    : 'all';",
    "  el.tenantHint.textContent = 'Allowed tenants: ' + allowedTenants;",
    "}",
    "",
    "async function submitExecution(event) {",
    "  event.preventDefault();",
    "  if (!state.selectedButton) {",
    "    setLastResponse({ ok: false, message: 'Select a button first' });",
    "    return;",
    "  }",
    "",
    "  const requiredRisk = Boolean(state.selectedButton.required_confirmations && state.selectedButton.required_confirmations.risk);",
    "  const requiredBilling = Boolean(state.selectedButton.required_confirmations && state.selectedButton.required_confirmations.billing);",
    "  const actorRole = el.actorRole.value || 'anonymous';",
    "",
    "  if (requiredRisk && !el.riskAck.checked) {",
    "    setLastResponse({ ok: false, message: 'risk confirmation is required for this button' });",
    "    return;",
    "  }",
    "",
    "  if (requiredBilling && !el.billingAck.checked) {",
    "    setLastResponse({ ok: false, message: 'billing confirmation is required for this button' });",
    "    return;",
    "  }",
    "",
    "  if (!state.selectedButton.allowed_roles.includes(actorRole)) {",
    "    setLastResponse({ ok: false, message: 'actor role not allowed for selected button: ' + actorRole });",
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
    "    actor_role: actorRole,",
    "    input,",
    "    confirmation: {",
    "      risk_acknowledged: el.riskAck.checked,",
    "      billing_acknowledged: el.billingAck.checked",
    "    }",
    "  };",
    "",
    "  const res = await fetch('/api/spell-executions', {",
    "    method: 'POST',",
    "    headers: makeApiHeaders(true),",
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
    "  const params = new URLSearchParams();",
    "  const selectedStatus = String(el.executionStatus.value || '').trim();",
    "  if (selectedStatus !== '') {",
    "    params.set('status', selectedStatus);",
    "  }",
    "",
    "  const buttonIdFilter = String(el.executionButtonId.value || '').trim();",
    "  if (buttonIdFilter !== '') {",
    "    params.set('button_id', buttonIdFilter);",
    "  }",
    "",
    "  const spellIdFilter = String(el.executionSpellId.value || '').trim();",
    "  if (spellIdFilter !== '') {",
    "    params.set('spell_id', spellIdFilter);",
    "  }",
    "",
    "  const tenantIdFilter = String(el.executionTenantId.value || '').trim();",
    "  if (tenantIdFilter !== '') {",
    "    params.set('tenant_id', tenantIdFilter);",
    "  }",
    "",
    "  const fromFilter = String(el.executionFrom.value || '').trim();",
    "  if (fromFilter !== '') {",
    "    params.set('from', fromFilter);",
    "  }",
    "",
    "  const toFilter = String(el.executionTo.value || '').trim();",
    "  if (toFilter !== '') {",
    "    params.set('to', toFilter);",
    "  }",
    "",
    "  const parsedLimit = Number.parseInt(String(el.executionLimit.value || '').trim(), 10);",
    "  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;",
    "  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {",
    "    el.executionLimit.value = String(limit);",
    "  }",
    "  params.set('limit', String(limit));",
    "",
    "  const query = params.toString();",
    "  const res = await fetch('/api/spell-executions' + (query ? '?' + query : ''), { headers: makeApiHeaders(false) });",
    "  const payload = await res.json();",
    "  if (!payload.ok) {",
    "    stopListStream();",
    "    setLastResponse(payload);",
    "    return;",
    "  }",
    "  state.executions = payload.executions || [];",
    "  renderExecutions();",
    "  startListStream(query);",
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
    "      '<div class=\"hint\">retry_of: ' + escapeHtml(execution.retry_of || '-') + ' | retried_by: ' + escapeHtml(execution.retried_by || '-') + '</div>',",
    "      '<div>' +",
    "        '<button data-exec-id=\"' + escapeHtml(execution.execution_id) + '\">View</button>' +",
    "        (canCancelExecution(execution.status) ? ' <button class=\"secondary\" data-cancel-id=\"' + escapeHtml(execution.execution_id) + '\">Cancel</button>' : '') +",
    "        (canRetryExecution(execution.status) ? ' <button class=\"secondary\" data-retry-id=\"' + escapeHtml(execution.execution_id) + '\">Retry</button>' : '') +",
    "      '</div>'",
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
    "",
    "  for (const button of el.executions.querySelectorAll('button[data-cancel-id]')) {",
    "    button.addEventListener('click', async () => {",
    "      const id = button.getAttribute('data-cancel-id');",
    "      if (!id) return;",
    "      await cancelExecution(id);",
    "    });",
    "  }",
    "",
    "  for (const button of el.executions.querySelectorAll('button[data-retry-id]')) {",
    "    button.addEventListener('click', async () => {",
    "      const id = button.getAttribute('data-retry-id');",
    "      if (!id) return;",
    "      await retryExecution(id);",
    "    });",
    "  }",
    "}",
    "",
    "function canCancelExecution(status) {",
    "  return status === 'queued' || status === 'running';",
    "}",
    "",
    "function canRetryExecution(status) {",
    "  return status === 'failed' || status === 'timeout' || status === 'canceled';",
    "}",
    "",
    "async function cancelExecution(executionId) {",
    "  const res = await fetch('/api/spell-executions/' + encodeURIComponent(executionId) + '/cancel', {",
    "    method: 'POST',",
    "    headers: makeApiHeaders(false)",
    "  });",
    "  const payload = await res.json();",
    "  setLastResponse(payload);",
    "  state.selectedExecutionId = executionId;",
    "  await loadExecutions();",
    "}",
    "",
    "async function retryExecution(executionId) {",
    "  const res = await fetch('/api/spell-executions/' + encodeURIComponent(executionId) + '/retry', {",
    "    method: 'POST',",
    "    headers: makeApiHeaders(false)",
    "  });",
    "  const payload = await res.json();",
    "  setLastResponse(payload);",
    "  if (payload.execution_id) {",
    "    state.selectedExecutionId = payload.execution_id;",
    "  } else {",
    "    state.selectedExecutionId = executionId;",
    "  }",
    "  await loadExecutions();",
    "}",
    "",
    "async function loadExecutionDetail(executionId) {",
    "  const res = await fetch('/api/spell-executions/' + encodeURIComponent(executionId), { headers: makeApiHeaders(false) });",
    "  const payload = await res.json();",
    "  state.selectedExecutionId = executionId;",
    "  el.executionDetail.textContent = JSON.stringify(payload, null, 2);",
    "  renderExecutionLinks(payload.execution || {});",
    "  if (!payload.ok) {",
    "    stopExecutionStream();",
    "    return;",
    "  }",
    "  upsertExecutionInState(payload.execution || {});",
    "  renderExecutions();",
    "  const status = String((payload.execution || {}).status || '');",
    "  if (status === 'queued' || status === 'running') {",
    "    startExecutionStream(executionId);",
    "  } else if (executionStreamExecutionId === executionId) {",
    "    stopExecutionStream();",
    "  }",
    "}",
    "",
    "function upsertExecutionInState(execution) {",
    "  if (!execution || typeof execution !== 'object') return;",
    "  const executionId = String(execution.execution_id || '');",
    "  if (!executionId) return;",
    "  const index = state.executions.findIndex((item) => item.execution_id === executionId);",
    "  if (index >= 0) {",
    "    state.executions[index] = execution;",
    "  } else {",
    "    state.executions.unshift(execution);",
    "  }",
    "  const selectedStatus = String(el.executionStatus.value || '').trim();",
    "  if (selectedStatus !== '') {",
    "    state.executions = state.executions.filter((item) => String(item.status || '') === selectedStatus);",
    "  }",
    "  const parsedLimit = Number.parseInt(String(el.executionLimit.value || '').trim(), 10);",
    "  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;",
    "  if (state.executions.length > limit) {",
    "    state.executions = state.executions.slice(0, limit);",
    "  }",
    "}",
    "",
    "function stopExecutionStream() {",
    "  if (executionStreamController) {",
    "    executionStreamController.abort();",
    "  }",
    "  executionStreamController = null;",
    "  executionStreamExecutionId = null;",
    "}",
    "",
    "function stopListStream() {",
    "  if (listStreamController) {",
    "    listStreamController.abort();",
    "  }",
    "  listStreamController = null;",
    "  listStreamSignature = null;",
    "}",
    "",
    "async function startListStream(queryString) {",
    "  const token = String(el.apiToken.value || '').trim();",
    "  const signature = String(queryString || '') + '|' + token;",
    "  if (listStreamController && listStreamSignature === signature) {",
    "    return;",
    "  }",
    "",
    "  stopListStream();",
    "  const controller = new AbortController();",
    "  listStreamController = controller;",
    "  listStreamSignature = signature;",
    "",
    "  const url = '/api/spell-executions/events' + (queryString ? '?' + queryString : '');",
    "  try {",
    "    const streamRes = await fetch(url, {",
    "      headers: makeApiHeaders(false),",
    "      signal: controller.signal",
    "    });",
    "    if (!streamRes.ok || !streamRes.body) {",
    "      if (!controller.signal.aborted) {",
    "        const payload = await streamRes.json().catch(() => ({ ok: false, message: 'failed to open execution list stream' }));",
    "        setLastResponse(payload);",
    "      }",
    "      return;",
    "    }",
    "",
    "    const reader = streamRes.body.getReader();",
    "    const decoder = new TextDecoder();",
    "    let buffer = '';",
    "",
    "    while (true) {",
    "      const next = await reader.read();",
    "      if (next.done) break;",
    "      buffer += decoder.decode(next.value, { stream: true }).replaceAll('\\r\\n', '\\n');",
    "      let splitIndex = buffer.indexOf('\\n\\n');",
    "      while (splitIndex >= 0) {",
    "        const block = buffer.slice(0, splitIndex).trim();",
    "        buffer = buffer.slice(splitIndex + 2);",
    "        if (block !== '') {",
    "          const parsed = parseSseBlock(block);",
    "          if (parsed) {",
    "            applyExecutionListStreamEvent(parsed);",
    "          }",
    "        }",
    "        splitIndex = buffer.indexOf('\\n\\n');",
    "      }",
    "    }",
    "  } catch (error) {",
    "    if (!controller.signal.aborted) {",
    "      setLastResponse({ ok: false, message: 'execution list stream error: ' + String(error && error.message ? error.message : error) });",
    "    }",
    "  } finally {",
    "    if (listStreamController === controller) {",
    "      listStreamController = null;",
    "      listStreamSignature = null;",
    "    }",
    "  }",
    "}",
    "",
    "async function startExecutionStream(executionId) {",
    "  if (!executionId) return;",
    "  if (executionStreamExecutionId === executionId && executionStreamController) return;",
    "  stopExecutionStream();",
    "  const controller = new AbortController();",
    "  executionStreamController = controller;",
    "  executionStreamExecutionId = executionId;",
    "  try {",
    "    const streamRes = await fetch('/api/spell-executions/' + encodeURIComponent(executionId) + '/events', {",
    "      headers: makeApiHeaders(false),",
    "      signal: controller.signal",
    "    });",
    "    if (!streamRes.ok || !streamRes.body) {",
    "      if (!controller.signal.aborted) {",
    "        const payload = await streamRes.json().catch(() => ({ ok: false, message: 'failed to open execution stream' }));",
    "        setLastResponse(payload);",
    "      }",
    "      return;",
    "    }",
    "",
    "    const reader = streamRes.body.getReader();",
    "    const decoder = new TextDecoder();",
    "    let buffer = '';",
    "",
    "    while (true) {",
    "      const next = await reader.read();",
    "      if (next.done) break;",
    "      buffer += decoder.decode(next.value, { stream: true }).replaceAll('\\r\\n', '\\n');",
    "      let splitIndex = buffer.indexOf('\\n\\n');",
    "      while (splitIndex >= 0) {",
    "        const block = buffer.slice(0, splitIndex).trim();",
    "        buffer = buffer.slice(splitIndex + 2);",
    "        if (block !== '') {",
    "          const parsed = parseSseBlock(block);",
    "          if (parsed) {",
    "            applyExecutionStreamEvent(parsed, executionId);",
    "          }",
    "        }",
    "        splitIndex = buffer.indexOf('\\n\\n');",
    "      }",
    "    }",
    "  } catch (error) {",
    "    if (!controller.signal.aborted) {",
    "      setLastResponse({ ok: false, message: 'execution stream error: ' + String(error && error.message ? error.message : error) });",
    "    }",
    "  } finally {",
    "    if (executionStreamController === controller) {",
    "      executionStreamController = null;",
    "      executionStreamExecutionId = null;",
    "    }",
    "  }",
    "}",
    "",
    "function parseSseBlock(block) {",
    "  const lines = block.split('\\n');",
    "  let event = 'message';",
    "  const dataLines = [];",
    "  for (const line of lines) {",
    "    if (line.startsWith(':')) continue;",
    "    if (line.startsWith('event:')) {",
    "      event = line.slice('event:'.length).trim();",
    "      continue;",
    "    }",
    "    if (line.startsWith('data:')) {",
    "      dataLines.push(line.slice('data:'.length).trimStart());",
    "    }",
    "  }",
    "  if (dataLines.length === 0) return null;",
    "  const dataRaw = dataLines.join('\\n');",
    "  try {",
    "    return { event, data: JSON.parse(dataRaw) };",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
    "",
    "function applyExecutionStreamEvent(eventPayload, expectedExecutionId) {",
    "  if (!eventPayload || typeof eventPayload !== 'object') return;",
    "  const data = eventPayload.data;",
    "  if (!data || typeof data !== 'object') return;",
    "  const execution = data.execution;",
    "  if (!execution || typeof execution !== 'object') return;",
    "  const executionId = String(execution.execution_id || '');",
    "  if (executionId === '' || executionId !== String(expectedExecutionId)) return;",
    "",
    "  upsertExecutionInState(execution);",
    "  renderExecutions();",
    "",
    "  if (state.selectedExecutionId === executionId) {",
    "    el.executionDetail.textContent = JSON.stringify({ ok: true, execution, receipt: data.receipt ?? null }, null, 2);",
    "    renderExecutionLinks(execution);",
    "  }",
    "",
    "  const status = String(execution.status || '');",
    "  if (status === 'succeeded' || status === 'failed' || status === 'timeout' || status === 'canceled') {",
    "    if (executionStreamExecutionId === executionId) {",
    "      stopExecutionStream();",
    "    }",
    "    loadExecutions();",
    "  }",
    "}",
    "",
    "function applyExecutionListStreamEvent(eventPayload) {",
    "  if (!eventPayload || typeof eventPayload !== 'object') return;",
    "  if (eventPayload.event !== 'snapshot' && eventPayload.event !== 'executions') return;",
    "  const data = eventPayload.data;",
    "  if (!data || typeof data !== 'object') return;",
    "  if (!Array.isArray(data.executions)) return;",
    "  state.executions = data.executions;",
    "  renderExecutions();",
    "}",
    "",
    "function renderExecutionLinks(execution) {",
    "  el.executionLinks.innerHTML = '';",
    "  const links = [];",
    "  if (execution.retry_of) {",
    "    links.push({ label: 'retry_of', execution_id: String(execution.retry_of) });",
    "  }",
    "  if (execution.retried_by) {",
    "    links.push({ label: 'retried_by', execution_id: String(execution.retried_by) });",
    "  }",
    "  if (links.length === 0) {",
    "    el.executionLinks.textContent = 'Retry links: none';",
    "    return;",
    "  }",
    "",
    "  const lead = document.createElement('span');",
    "  lead.textContent = 'Retry links: ';",
    "  el.executionLinks.appendChild(lead);",
    "",
    "  for (let i = 0; i < links.length; i += 1) {",
    "    const link = links[i];",
    "    if (i > 0) {",
    "      const sep = document.createElement('span');",
    "      sep.textContent = ' | ';",
    "      el.executionLinks.appendChild(sep);",
    "    }",
    "    const button = document.createElement('button');",
    "    button.className = 'secondary';",
    "    button.textContent = link.label + ' ' + link.execution_id;",
    "    button.addEventListener('click', () => {",
    "      state.selectedExecutionId = link.execution_id;",
    "      loadExecutionDetail(link.execution_id);",
    "    });",
    "    el.executionLinks.appendChild(button);",
    "  }",
    "}",
    "",
    "function setLastResponse(payload) {",
    "  el.lastResponse.textContent = JSON.stringify(payload, null, 2);",
    "}",
    "",
    "function makeApiHeaders(includeJson) {",
    "  const headers = {};",
    "  if (includeJson) {",
    "    headers['content-type'] = 'application/json';",
    "  }",
    "  const token = String(el.apiToken.value || '').trim();",
    "  if (token !== '') {",
    "    headers.authorization = 'Bearer ' + token;",
    "  }",
    "  return headers;",
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
    "updateGuardHints();",
    "loadButtons();",
    "loadExecutions();",
    "window.addEventListener('beforeunload', () => { stopExecutionStream(); stopListStream(); });",
    "setInterval(() => { if (!listStreamController) { loadExecutions(); } }, 5000);",
    ""
  ].join("\n");
}
