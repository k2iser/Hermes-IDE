import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

const CHAT_VIEW_ID = 'hermesIde.chatView';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  text: string;
  createdAt: number;
}

interface AttachmentPayload {
  name: string;
  mime: string;
  dataBase64: string;
}

interface WebviewInboundMessage {
  type: 'ready' | 'send' | 'clear';
  text?: string;
  attachments?: AttachmentPayload[];
  includeSelection?: boolean;
}

interface WebviewHost {
  webview: vscode.Webview;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new HermesChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hermesChat.open', async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    })
  );
}

export function deactivate(): void {}

class HermesChatViewProvider implements vscode.WebviewViewProvider {
  private session: HermesChatSession | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    this.session = new HermesChatSession(webviewView, this.extensionUri);
  }
}

class HermesChatSession {
  private messages: ChatMessage[] = [];
  private running = false;

  constructor(
    private readonly host: WebviewHost,
    private readonly extensionUri: vscode.Uri
  ) {
    this.host.webview.html = this.getHtml();
    this.host.webview.onDidReceiveMessage(async (message: WebviewInboundMessage) => this.handleMessage(message));
  }

  private async handleMessage(message: WebviewInboundMessage): Promise<void> {
    if (message.type === 'ready') {
      this.postState();
      return;
    }

    if (message.type === 'clear') {
      this.messages = [];
      this.postState();
      return;
    }

    if (message.type === 'send') {
      const text = (message.text ?? '').trim();
      const attachments = message.attachments ?? [];
      if (!text && attachments.length === 0) {
        return;
      }
      await this.sendToHermes(text, attachments, message.includeSelection ?? true);
    }
  }

  private async sendToHermes(text: string, attachments: AttachmentPayload[], includeSelection: boolean): Promise<void> {
    if (this.running) {
      vscode.window.showWarningMessage('Hermes is still working. Wait for the current response to finish.');
      return;
    }

    this.running = true;
    const userMessage = this.formatUserMessage(text, attachments);
    this.messages.push({ id: randomId(), role: 'user', text: userMessage, createdAt: Date.now() });
    this.postState();

    try {
      const savedAttachments = await this.saveAttachments(attachments);
      const prompt = await this.buildPrompt(text, savedAttachments, includeSelection);
      const answer = await runHermes(prompt, getWorkspaceCwd());
      this.messages.push({ id: randomId(), role: 'assistant', text: answer.trim() || '(Hermes returned an empty response)', createdAt: Date.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.messages.push({ id: randomId(), role: 'error', text: message, createdAt: Date.now() });
      vscode.window.showErrorMessage(`Hermes IDE failed: ${message}`);
    } finally {
      this.running = false;
      this.postState();
    }
  }

  private formatUserMessage(text: string, attachments: AttachmentPayload[]): string {
    const lines = [text];
    if (attachments.length) {
      lines.push('', `Attachments: ${attachments.map((a) => a.name).join(', ')}`);
    }
    return lines.join('\n').trim();
  }

  private async saveAttachments(attachments: AttachmentPayload[]): Promise<string[]> {
    if (!attachments.length) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('hermesChat');
    const maxFileBytes = config.get<number>('maxFileBytes', 5 * 1024 * 1024);
    const root = getWorkspaceCwd();
    const attachDir = path.join(root, '.hermes-chat', 'attachments');
    await fs.mkdir(attachDir, { recursive: true });

    const saved: string[] = [];
    for (const attachment of attachments) {
      const buffer = Buffer.from(attachment.dataBase64, 'base64');
      if (buffer.byteLength > maxFileBytes) {
        throw new Error(`Attachment '${attachment.name}' is ${buffer.byteLength} bytes, above hermesChat.maxFileBytes (${maxFileBytes}).`);
      }
      const safeName = sanitizeFilename(attachment.name || 'attachment.bin');
      const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;
      const fullPath = path.join(attachDir, filename);
      await fs.writeFile(fullPath, buffer);
      saved.push(fullPath);
    }
    return saved;
  }

  private async buildPrompt(text: string, attachmentPaths: string[], includeSelection: boolean): Promise<string> {
    const workspace = getWorkspaceCwd();
    const active = vscode.window.activeTextEditor;
    const lines: string[] = [];

    lines.push('You are Hermes Agent being used from the Hermes IDE VS Code/Cursor extension.');
    lines.push(`Workspace: ${workspace}`);
    lines.push('Answer in the user language unless they ask otherwise. If files are attached, inspect or reason about the paths below.');
    lines.push('');

    if (active) {
      lines.push(`Active file: ${active.document.uri.fsPath}`);
      if (includeSelection && !active.selection.isEmpty) {
        lines.push('Selected code/text:');
        lines.push('```');
        lines.push(active.document.getText(active.selection));
        lines.push('```');
        lines.push('');
      }
    }

    if (attachmentPaths.length) {
      lines.push('Attached files saved by the extension:');
      for (const filePath of attachmentPaths) {
        lines.push(`- ${filePath}`);
      }
      lines.push('');
    }

    lines.push('User request:');
    lines.push(text || '(The user only attached files.)');
    return lines.join('\n');
  }

  private postState(): void {
    this.host.webview.postMessage({ type: 'state', messages: this.messages, running: this.running });
  }

  private getHtml(): string {
    const nonce = randomId();
    const logoUri = this.host.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'hermes-h.svg'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.host.webview.cspSource} data:; style-src 'unsafe-inline' ${this.host.webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hermes IDE</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
    .app { display: flex; flex-direction: column; height: 100vh; min-width: 0; }
    header { padding: 10px 10px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .brand img { width: 20px; height: 20px; filter: var(--vscode-icon-foreground); }
    header strong { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 10px; border-radius: 3px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: wait; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    main { flex: 1; overflow-y: auto; padding: 10px; }
    .empty { opacity: .72; border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 12px; line-height: 1.45; }
    .message { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 9px; margin-bottom: 9px; white-space: pre-wrap; line-height: 1.45; overflow-wrap: anywhere; }
    .user { background: color-mix(in srgb, var(--vscode-button-background) 14%, transparent); }
    .assistant { background: color-mix(in srgb, var(--vscode-editorWidget-background) 75%, transparent); }
    .error { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
    .role { font-weight: 700; margin-bottom: 6px; opacity: .9; }
    footer { border-top: 1px solid var(--vscode-panel-border); padding: 10px; }
    textarea { width: 100%; min-height: 92px; resize: vertical; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; border-radius: 4px; }
    .toolbar { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
    .attachments { font-size: 12px; opacity: .8; margin-top: 6px; }
    .drop { border: 1px dashed var(--vscode-panel-border); border-radius: 6px; padding: 7px; font-size: 12px; opacity: .75; margin-bottom: 7px; }
    .running { opacity: .75; font-style: italic; }
    label { display: flex; gap: 5px; align-items: center; font-size: 12px; }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="brand"><img src="${logoUri}" alt="H" /><strong>Hermes IDE</strong></div>
      <button class="secondary" id="clear" title="Clear chat">Clear</button>
    </header>
    <main id="messages"></main>
    <footer>
      <div class="drop" id="drop">Drop files/images here or paste screenshots/files.</div>
      <div class="attachments" id="attachments"></div>
      <textarea id="input" placeholder="Ask Hermes... Ctrl/Cmd+Enter to send"></textarea>
      <div class="toolbar">
        <button id="send">Send</button>
        <label><input type="checkbox" id="includeSelection" checked /> selection</label>
        <span class="running" id="running"></span>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendEl = document.getElementById('send');
    const clearEl = document.getElementById('clear');
    const runningEl = document.getElementById('running');
    const attachmentsEl = document.getElementById('attachments');
    const includeSelectionEl = document.getElementById('includeSelection');
    const dropEl = document.getElementById('drop');
    let attachments = [];

    function render(state) {
      messagesEl.innerHTML = '';
      if (!state.messages.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Hermes IDE está listo. Escribe una petición, selecciona código si quieres, o pega/arrastra imágenes y archivos.';
        messagesEl.appendChild(empty);
      }
      for (const msg of state.messages) {
        const div = document.createElement('div');
        div.className = 'message ' + msg.role;
        const role = document.createElement('div');
        role.className = 'role';
        role.textContent = msg.role === 'assistant' ? 'Hermes' : msg.role;
        const text = document.createElement('div');
        text.textContent = msg.text;
        div.appendChild(role);
        div.appendChild(text);
        messagesEl.appendChild(div);
      }
      runningEl.textContent = state.running ? 'thinking...' : '';
      sendEl.disabled = state.running;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderAttachments() {
      attachmentsEl.textContent = attachments.length ? 'Attached: ' + attachments.map(a => a.name).join(', ') : '';
    }

    async function fileToAttachment(file) {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return { name: file.name || 'pasted-file', mime: file.type || 'application/octet-stream', dataBase64: btoa(binary) };
    }

    async function addFiles(fileList) {
      for (const file of fileList) {
        attachments.push(await fileToAttachment(file));
      }
      renderAttachments();
    }

    function send() {
      const text = inputEl.value;
      if (!text.trim() && attachments.length === 0) return;
      vscode.postMessage({ type: 'send', text, attachments, includeSelection: includeSelectionEl.checked });
      inputEl.value = '';
      attachments = [];
      renderAttachments();
    }

    sendEl.addEventListener('click', send);
    clearEl.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
    inputEl.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); }
    });
    dropEl.addEventListener('dragover', (event) => { event.preventDefault(); });
    dropEl.addEventListener('drop', async (event) => { event.preventDefault(); await addFiles(event.dataTransfer.files); });
    document.addEventListener('paste', async (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) { await addFiles(files); }
    });
    window.addEventListener('message', (event) => { if (event.data.type === 'state') render(event.data); });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function runHermes(prompt: string, cwd: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('hermesChat');
  const executable = config.get<string>('executable', 'hermes');
  const extraArgs = config.get<string[]>('extraArgs', []);
  const args = [...extraArgs, 'chat', '-q', prompt];

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Hermes exited with code ${code}.\n${stderr || stdout}`));
      }
    });
  });
}

function getWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? process.env.HOME ?? process.cwd();
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}

function randomId(): string {
  return crypto.randomBytes(8).toString('hex');
}
