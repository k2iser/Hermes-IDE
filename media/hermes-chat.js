(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const logo = app.dataset.logo;

  let state = {
    messages: [],
    sessions: [],
    currentSessionId: '',
    sessionTitle: 'Nueva conversación',
    running: false,
    autoMode: false,
    workspace: 'Workspace',
    cwd: '',
    executable: 'hermes',
    includeSelectionDefault: true,
    slashCommands: []
  };
  let attachments = [];
  let includeTouched = false;
  let autoTouched = false;

  function post(type, payload = {}) {
    vscode.postMessage({ type, ...payload });
  }

  function log(text, detail = '') {
    post('log', { text, detail: String(detail || '') });
  }

  function reportError(text, error) {
    post('error', { text, detail: String(error && (error.stack || error.message || error)) });
  }

  window.addEventListener('error', (event) => reportError(event.message || 'webview error', event.error));
  window.addEventListener('unhandledrejection', (event) => reportError('unhandled rejection', event.reason));

  function escapeText(text) {
    return String(text ?? '');
  }

  function render() {
    app.innerHTML = `
      <div class="appRoot app">
        <div class="dropHint">Suelta archivos de tu escritorio aquí<br/>Hermes los copiará al workspace</div>
        <header class="header">
          <div class="brand"><img src="${logo}" alt="Hermes"/><span>${escapeText(state.workspace || 'Hermes IDE')}</span></div>
          <div class="actions">
            <button class="iconBtn" data-action="terminal" title="Abrir Hermes en terminal">Terminal</button>
            <button class="iconBtn" data-action="sessions" title="Sesiones guardadas">Sesiones</button>
            <button class="iconBtn" data-action="model" title="Instalar/cambiar modelo">Modelos</button>
            <button class="iconBtn" data-action="clear" title="Nuevo chat">⊕</button>
            <button class="iconBtn" data-action="settings" title="Ajustes">⚙</button>
          </div>
        </header>
        <main class="messages" id="messages"><div class="inner" id="inner"></div></main>
        <div class="sessionPanel" id="sessionPanel"></div>
        <section class="composerWrap">
          <div class="composer" id="composer">
            <div class="slashMenu" id="slashMenu"></div>
            <textarea id="input" placeholder="Pide a Hermes que construya, revise, investigue o automatice… Escribe / para comandos"></textarea>
            <div class="attachments" id="attachments"></div>
            <div class="toolbar">
              <div class="left">
                <button class="toolBtn" data-action="attach" title="Adjuntar archivos locales">＋</button>
                <button class="toolBtn" data-action="mention" title="Insertar referencia @">@</button>
                <button class="toolBtn" data-action="slash" title="Comandos">/</button>
                <label title="Incluye el texto seleccionado en el editor"><input id="includeSelection" type="checkbox"/> <span>Selección</span></label>
              </div>
              <div class="right">
                <span class="running" id="running"></span>
                <label title="Pasa --yolo a Hermes para reducir aprobaciones rutinarias"><input id="autoMode" type="checkbox"/> <span>Auto</span></label>
                <button class="toolBtn" data-action="stop" id="stopBtn" style="display:none">Stop</button>
                <button class="send" data-action="send" id="sendBtn">↑</button>
              </div>
            </div>
            <input class="fileInput" id="fileInput" type="file" multiple />
          </div>
        </section>
      </div>`;

    renderMessages();
    renderSessionPanel();
    renderAttachments();
    bind();
  }

  function renderMessages() {
    const inner = document.getElementById('inner');
    if (!inner) return;
    inner.innerHTML = '';

    if (!state.messages.length) {
      const hero = document.createElement('div');
      hero.className = 'hero';
      hero.innerHTML = '';
      const img = document.createElement('img');
      img.src = logo;
      img.alt = 'Hermes';
      const h1 = document.createElement('h1');
      h1.textContent = 'Hermes IDE';
      const p = document.createElement('p');
      p.textContent = 'Chat propio de Hermes para VS Code/Cursor: sesiones, archivos locales, selección de código, slash commands y ejecución en el workspace.';
      const pills = document.createElement('div');
      pills.className = 'pills';
      for (const text of [`cwd: ${state.cwd || '-'}`, `cli: ${state.executable || 'hermes'}`, state.autoMode ? 'auto on' : 'auto off']) {
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = text;
        pills.appendChild(pill);
      }
      hero.append(img, h1, p, pills);
      inner.appendChild(hero);
    }

    const transcript = document.createElement('div');
    transcript.className = 'transcript';
    for (const message of state.messages) {
      const el = document.createElement('article');
      el.className = `turn ${message.role}`;
      const header = document.createElement('div');
      header.className = 'turnHeader';
      const label = document.createElement('span');
      label.className = 'turnLabel';
      label.textContent = message.role === 'assistant' ? 'Hermes' : message.role === 'user' ? 'Vicente' : message.role;
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      header.append(label, time);
      const body = document.createElement('div');
      body.className = 'turnBody';
      renderRichText(body, message.text || (message.role === 'assistant' && state.running ? 'Hermes está trabajando…' : ''));
      el.append(header, body);
      transcript.appendChild(el);
    }
    inner.appendChild(transcript);

    const messages = document.getElementById('messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  function renderRichText(container, text) {
    const parts = String(text || '').split(/```/g);
    parts.forEach((part, index) => {
      if (index % 2 === 1) {
        const firstNewline = part.indexOf('\n');
        const lang = firstNewline > -1 ? part.slice(0, firstNewline).trim() : '';
        const code = firstNewline > -1 ? part.slice(firstNewline + 1) : part;
        const block = document.createElement('div');
        block.className = 'codeBlock';
        const bar = document.createElement('div');
        bar.className = 'codeBar';
        const langEl = document.createElement('span');
        langEl.textContent = lang || 'code';
        const copy = document.createElement('button');
        copy.textContent = 'Copy';
        copy.addEventListener('click', () => navigator.clipboard?.writeText(code));
        bar.append(langEl, copy);
        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        codeEl.textContent = code.replace(/^\n|\n$/g, '');
        pre.appendChild(codeEl);
        block.append(bar, pre);
        container.appendChild(block);
        return;
      }
      renderParagraphs(container, part);
    });
  }

  function renderParagraphs(container, text) {
    const lines = String(text || '').split('\n');
    let list = null;
    let para = [];
    const flushPara = () => {
      if (!para.length) return;
      const p = document.createElement('p');
      p.textContent = para.join('\n').trim();
      if (p.textContent) container.appendChild(p);
      para = [];
    };
    const flushList = () => { list = null; };
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
      if (bullet) {
        flushPara();
        if (!list) {
          list = document.createElement('ul');
          container.appendChild(list);
        }
        const li = document.createElement('li');
        li.textContent = bullet[1];
        list.appendChild(li);
        continue;
      }
      if (!line.trim()) {
        flushPara();
        flushList();
        continue;
      }
      para.push(line);
    }
    flushPara();
  }

  function renderSessionPanel() {
    const panel = document.getElementById('sessionPanel');
    if (!panel) return;
    panel.innerHTML = '';
    const list = state.sessions || [];
    const title = document.createElement('div');
    title.className = 'sessionTitle';
    title.textContent = 'Sesiones recientes';
    panel.appendChild(title);
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'sessionEmpty';
      empty.textContent = 'Aún no hay conversaciones guardadas.';
      panel.appendChild(empty);
      return;
    }
    list.slice(0, 12).forEach((session) => {
      const row = document.createElement('button');
      row.className = `sessionRow ${session.id === state.currentSessionId ? 'active' : ''}`;
      row.addEventListener('click', () => {
        hideSessions();
        post('openSession', { sessionId: session.id });
      });
      const name = document.createElement('span');
      name.textContent = session.title || 'Sin título';
      const meta = document.createElement('small');
      meta.textContent = `${session.messageCount || 0} mensajes · ${new Date(session.updatedAt).toLocaleDateString()}`;
      row.append(name, meta);
      panel.appendChild(row);
    });
  }

  function renderAttachments() {
    const el = document.getElementById('attachments');
    if (!el) return;
    el.innerHTML = '';
    attachments.forEach((attachment, index) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.appendChild(document.createTextNode(`📎 ${attachment.name}`));
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        attachments.splice(index, 1);
        renderAttachments();
      });
      chip.appendChild(remove);
      el.appendChild(chip);
    });
  }

  function bind() {
    const input = document.getElementById('input');
    const include = document.getElementById('includeSelection');
    const auto = document.getElementById('autoMode');
    const fileInput = document.getElementById('fileInput');
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
    const running = document.getElementById('running');

    if (!includeTouched) include.checked = Boolean(state.includeSelectionDefault);
    if (!autoTouched) auto.checked = Boolean(state.autoMode);
    sendBtn.disabled = Boolean(state.running);
    running.textContent = state.running ? 'Trabajando…' : '';
    stopBtn.style.display = state.running ? 'inline-flex' : 'none';

    app.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => handleAction(button.dataset.action));
    });

    include.addEventListener('change', () => { includeTouched = true; });
    auto.addEventListener('change', () => {
      autoTouched = true;
      post('setAutoMode', { enabled: auto.checked });
    });
    fileInput.addEventListener('change', async () => {
      await addFiles(fileInput.files || []);
      fileInput.value = '';
    });
    input.addEventListener('input', () => showSlashMenu(false));
    input.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        send();
      }
      if (event.key === 'Escape') hideSlashMenu();
      if (event.key === '/' && !input.value.trim()) setTimeout(() => showSlashMenu(true), 0);
    });

    ['dragenter', 'dragover'].forEach((name) => document.addEventListener(name, (event) => {
      event.preventDefault();
      app.classList.add('drop');
    }));
    ['dragleave', 'drop'].forEach((name) => document.addEventListener(name, (event) => {
      if (name !== 'drop') event.preventDefault();
      app.classList.remove('drop');
    }));
    document.getElementById('composer').addEventListener('drop', async (event) => {
      event.preventDefault();
      await addFiles(event.dataTransfer.files || []);
    });
    document.addEventListener('paste', async (event) => {
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length) await addFiles(files);
    });
  }

  function handleAction(action) {
    try {
      if (action === 'send') send();
      if (action === 'stop') post('stop');
      if (action === 'clear') post('clear');
      if (action === 'settings') post('openSettings');
      if (action === 'model') post('pickModel');
      if (action === 'terminal') post('openTerminal');
      if (action === 'sessions') toggleSessions();
      if (action === 'mention') post('insertAtMention');
      if (action === 'attach') document.getElementById('fileInput').click();
      if (action === 'slash') {
        const input = document.getElementById('input');
        if (!input.value.trim()) input.value = '/';
        input.focus();
        showSlashMenu(true);
      }
    } catch (error) {
      reportError(`button failed: ${action}`, error);
    }
  }

  function send() {
    const input = document.getElementById('input');
    const include = document.getElementById('includeSelection');
    const text = input.value;
    if (!text.trim() && attachments.length === 0) return;
    post('send', { text, attachments, includeSelection: include.checked });
    input.value = '';
    attachments = [];
    renderAttachments();
    hideSlashMenu();
  }

  async function addFiles(fileList) {
    for (const file of Array.from(fileList)) {
      attachments.push(await fileToAttachment(file));
    }
    renderAttachments();
    document.getElementById('input').focus();
  }

  async function fileToAttachment(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return { name: file.name || 'local-file', mime: file.type || 'application/octet-stream', dataBase64: btoa(binary) };
  }

  function showSlashMenu(force) {
    const menu = document.getElementById('slashMenu');
    const input = document.getElementById('input');
    const query = force ? '/' : currentSlashToken(input);
    if (!query) return hideSlashMenu();
    const q = query.slice(1).toLowerCase();
    const matches = (state.slashCommands || []).filter((cmd) =>
      cmd.command.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q)
    );
    if (!matches.length) return hideSlashMenu();
    menu.innerHTML = '';
    matches.slice(0, 12).forEach((cmd) => {
      const button = document.createElement('button');
      button.className = 'slashItem';
      const b = document.createElement('b');
      b.textContent = cmd.command;
      const span = document.createElement('span');
      span.textContent = cmd.description;
      button.append(b, span);
      button.addEventListener('click', () => insertSlash(cmd.command));
      menu.appendChild(button);
    });
    menu.classList.add('visible');
  }

  function currentSlashToken(input) {
    const cursor = input.selectionStart || input.value.length;
    const before = input.value.slice(0, cursor);
    const idx = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'));
    const token = before.slice(idx + 1);
    return token.startsWith('/') ? token : null;
  }

  function insertSlash(command) {
    const input = document.getElementById('input');
    const cursor = input.selectionStart || input.value.length;
    const before = input.value.slice(0, cursor);
    const idx = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'));
    const prefix = before.slice(0, idx + 1);
    const after = input.value.slice(cursor);
    input.value = `${prefix}${command}${after ? ' ' + after : ''}`;
    hideSlashMenu();
    input.focus();
  }

  function hideSlashMenu() {
    const menu = document.getElementById('slashMenu');
    if (menu) menu.classList.remove('visible');
  }

  function toggleSessions() {
    document.getElementById('sessionPanel')?.classList.toggle('visible');
  }

  function hideSessions() {
    document.getElementById('sessionPanel')?.classList.remove('visible');
  }

  function insertTextAtCursor(text) {
    const input = document.getElementById('input');
    if (!input) return;
    const start = input.selectionStart || input.value.length;
    const end = input.selectionEnd || start;
    input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
    const next = start + text.length;
    input.focus();
    input.setSelectionRange(next, next);
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'state') {
      state = { ...state, ...event.data };
      render();
      return;
    }
    if (event.data?.type === 'focusInput') {
      document.getElementById('input')?.focus();
      return;
    }
    if (event.data?.type === 'insertText') {
      insertTextAtCursor(event.data.text || '');
    }
  });

  render();
  log('webview booted');
  post('ready');
})();
