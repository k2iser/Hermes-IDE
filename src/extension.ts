import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

const PRIMARY_VIEW_ID = 'hermesIde.chatView';
const SECONDARY_VIEW_ID = 'hermesIde.secondaryChatView';
const PRIMARY_CONTAINER = 'workbench.view.extension.hermesIde';
const SECONDARY_CONTAINER = 'workbench.view.extension.hermesIdeSecondary';
const PANEL_VIEW_TYPE = 'hermesIde.panel';

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

interface InboundMessage {
  type: 'ready' | 'send' | 'clear' | 'stop' | 'pickModel' | 'openSettings' | 'setAutoMode' | 'log' | 'error';
  text?: string;
  detail?: string;
  attachments?: AttachmentPayload[];
  includeSelection?: boolean;
  enabled?: boolean;
}

interface WebviewHost {
  webview: vscode.Webview;
}

interface ModelOption extends vscode.QuickPickItem {
  provider?: string;
  model?: string;
  wizard?: boolean;
}

const SLASH_COMMANDS = [
  { command: '/help', description: 'Muestra ayuda y comandos disponibles' },
  { command: '/model', description: 'Ver o cambiar modelo' },
  { command: '/status', description: 'Estado de Hermes' },
  { command: '/tools', description: 'Herramientas disponibles' },
  { command: '/skills', description: 'Skills disponibles' },
  { command: '/yolo', description: 'Modo sin aprobaciones rutinarias' },
  { command: '/clear', description: 'Limpiar conversación' },
  { command: '/config', description: 'Ver configuración' },
  { command: '/usage', description: 'Uso/tokens' }
];

const MODEL_OPTIONS: ModelOption[] = [
  { label: 'Abrir selector oficial de Hermes', description: 'Ejecuta hermes model en una terminal integrada', wizard: true },
  { label: 'OpenRouter · Claude Sonnet 4', description: 'anthropic/claude-sonnet-4', provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
  { label: 'OpenRouter · GPT-4.1', description: 'openai/gpt-4.1', provider: 'openrouter', model: 'openai/gpt-4.1' },
  { label: 'OpenRouter · Gemini 2.5 Pro', description: 'google/gemini-2.5-pro', provider: 'openrouter', model: 'google/gemini-2.5-pro' },
  { label: 'Anthropic · Claude Sonnet 4', description: 'claude-sonnet-4', provider: 'anthropic', model: 'claude-sonnet-4' },
  { label: 'Google · Gemini 2.5 Pro', description: 'gemini-2.5-pro', provider: 'google', model: 'gemini-2.5-pro' },
  { label: 'DeepSeek · Chat', description: 'deepseek-chat', provider: 'deepseek', model: 'deepseek-chat' },
  { label: 'xAI · Grok', description: 'grok-3', provider: 'xai', model: 'grok-3' },
  { label: 'Qwen OAuth · Qwen Coder', description: 'qwen-coder', provider: 'qwen-oauth', model: 'qwen-coder' }
];

let activeSession: HermesSession | undefined;
let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Hermes IDE');
  output.appendLine(`Hermes IDE activate: ${new Date().toISOString()}`);
  output.appendLine(`extensionUri=${context.extensionUri.toString()}`);
  output.appendLine(`extensionKind=workspace expected; remoteName=${vscode.env.remoteName ?? 'local'}`);

  const provider = new HermesViewProvider(context, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(PRIMARY_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(SECONDARY_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('hermesChat.open', () => openPanel(context, output)),
    vscode.commands.registerCommand('hermesChat.openSidebar', async () => {
      await vscode.commands.executeCommand(PRIMARY_CONTAINER);
      await vscode.commands.executeCommand(`${PRIMARY_VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('hermesChat.openSecondarySidebar', async () => {
      await vscode.commands.executeCommand(SECONDARY_CONTAINER);
      await vscode.commands.executeCommand(`${SECONDARY_VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('hermesChat.newChat', () => activeSession?.clear()),
    vscode.commands.registerCommand('hermesChat.stop', () => activeSession?.stop()),
    vscode.commands.registerCommand('hermesChat.showLogs', () => output.show()),
    vscode.commands.registerCommand('hermesChat.pickModel', () => activeSession?.pickModel())
  );

  output.appendLine('Hermes IDE providers registered');
}

export function deactivate(): void {
  activeSession?.stop();
}

function openPanel(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    PANEL_VIEW_TYPE,
    'Hermes IDE',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      enableForms: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri]
    }
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'hermes-h.svg');
  activeSession = new HermesSession(panel, context, output, 'panel');
  panel.onDidDispose(() => {
    panel = undefined;
    activeSession = undefined;
  });
}

class HermesViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.output.appendLine(`resolveWebviewView id=${view.viewType}`);
    view.webview.options = {
      enableScripts: true,
      enableForms: true,
      localResourceRoots: [this.context.extensionUri]
    };
    activeSession = new HermesSession(view, this.context, this.output, view.viewType);
  }
}

class HermesSession {
  private readonly messages: ChatMessage[] = [];
  private running = false;
  private autoMode = false;
  private process: ChildProcessWithoutNullStreams | undefined;

  constructor(
    private readonly host: WebviewHost,
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly surface: string
  ) {
    this.host.webview.html = this.html();
    this.host.webview.onDidReceiveMessage((message: InboundMessage) => {
      this.handle(message).catch((error) => this.fail('handle message failed', error));
    });
  }

  clear(): void {
    this.messages.length = 0;
    this.postState();
  }

  stop(): void {
    if (!this.running || !this.process) {
      return;
    }
    this.output.appendLine('Stopping Hermes process');
    this.process.kill('SIGTERM');
    this.messages.push({ id: randomId(), role: 'system', text: 'Hermes detenido.', createdAt: Date.now() });
    this.running = false;
    this.process = undefined;
    this.postState();
  }

  async pickModel(): Promise<void> {
    const selected = await vscode.window.showQuickPick(MODEL_OPTIONS, {
      title: 'Hermes IDE · instalar/cambiar modelo',
      placeHolder: 'Elige un modelo o abre el selector oficial de Hermes'
    });
    if (!selected) {
      return;
    }

    const executable = getConfig().get<string>('executable', 'hermes');
    if (selected.wizard) {
      const terminal = vscode.window.createTerminal({ name: 'Hermes Model Setup', cwd: getWorkspaceCwd() });
      terminal.show();
      terminal.sendText(`${executable} model`);
      this.system('Abierto `hermes model` en la terminal integrada.');
      return;
    }

    if (!selected.provider || !selected.model) {
      return;
    }

    await runCommand(executable, ['config', 'set', 'model.provider', selected.provider], getWorkspaceCwd());
    await runCommand(executable, ['config', 'set', 'model.default', selected.model], getWorkspaceCwd());
    this.system(`Modelo configurado:\nprovider: ${selected.provider}\nmodel: ${selected.model}\n\nSi faltan credenciales, ejecuta \`hermes auth add ${selected.provider}\`.`);
  }

  private async handle(message: InboundMessage): Promise<void> {
    if (message.type === 'ready') {
      this.output.appendLine(`webview ready surface=${this.surface}`);
      this.postState();
      return;
    }
    if (message.type === 'log' || message.type === 'error') {
      this.output.appendLine(`[webview:${message.type}] ${message.text ?? ''} ${message.detail ?? ''}`);
      return;
    }
    if (message.type === 'clear') {
      this.clear();
      return;
    }
    if (message.type === 'stop') {
      this.stop();
      return;
    }
    if (message.type === 'openSettings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'hermesChat');
      return;
    }
    if (message.type === 'pickModel') {
      await this.pickModel();
      return;
    }
    if (message.type === 'setAutoMode') {
      this.autoMode = Boolean(message.enabled);
      this.postState();
      return;
    }
    if (message.type === 'send') {
      await this.send(message.text ?? '', message.attachments ?? [], message.includeSelection ?? true);
    }
  }

  private async send(text: string, attachments: AttachmentPayload[], includeSelection: boolean): Promise<void> {
    if (this.running) {
      vscode.window.showWarningMessage('Hermes ya está trabajando. Pulsa Stop o espera.');
      return;
    }
    if (!text.trim() && attachments.length === 0) {
      return;
    }

    this.running = true;
    this.messages.push({ id: randomId(), role: 'user', text: this.userText(text, attachments), createdAt: Date.now() });
    const assistant: ChatMessage = { id: randomId(), role: 'assistant', text: '', createdAt: Date.now() };
    this.messages.push(assistant);
    this.postState();

    try {
      const saved = await this.saveAttachments(attachments);
      const prompt = await this.buildPrompt(text, saved, includeSelection);
      await this.runHermes(prompt, (chunk) => {
        assistant.text += chunk;
        this.postState();
      });
      if (!assistant.text.trim()) {
        assistant.text = '(Hermes no devolvió salida)';
      }
    } catch (error) {
      assistant.role = 'error';
      assistant.text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`send failed: ${assistant.text}`);
    } finally {
      this.running = false;
      this.process = undefined;
      this.postState();
    }
  }

  private userText(text: string, attachments: AttachmentPayload[]): string {
    if (!attachments.length) {
      return text;
    }
    return `${text}\n\nAdjuntos: ${attachments.map((a) => a.name).join(', ')}`.trim();
  }

  private async saveAttachments(attachments: AttachmentPayload[]): Promise<string[]> {
    if (!attachments.length) {
      return [];
    }
    const max = getConfig().get<number>('maxFileBytes', 5 * 1024 * 1024);
    const dir = path.join(getWorkspaceCwd(), '.hermes-chat', 'attachments');
    await fs.mkdir(dir, { recursive: true });

    const saved: string[] = [];
    for (const attachment of attachments) {
      const buffer = Buffer.from(attachment.dataBase64, 'base64');
      if (buffer.byteLength > max) {
        throw new Error(`El archivo ${attachment.name} supera el límite de ${max} bytes.`);
      }
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomId()}-${sanitize(attachment.name || 'file.bin')}`;
      const filePath = path.join(dir, name);
      await fs.writeFile(filePath, buffer);
      saved.push(filePath);
    }
    return saved;
  }

  private async buildPrompt(text: string, files: string[], includeSelection: boolean): Promise<string> {
    const lines: string[] = [];
    const active = vscode.window.activeTextEditor;
    lines.push('You are Hermes Agent running from Hermes IDE in VS Code/Cursor.');
    lines.push(`Workspace: ${getWorkspaceCwd()}`);
    lines.push(`Auto mode: ${this.autoMode ? 'enabled (--yolo)' : 'disabled'}`);
    lines.push('Respond in the user language. Use tools when needed and verify work before finalizing.');
    lines.push('');
    if (active) {
      lines.push(`Active file: ${active.document.uri.fsPath}`);
      if (includeSelection && !active.selection.isEmpty) {
        lines.push('Selected editor text:');
        lines.push('```');
        lines.push(active.document.getText(active.selection));
        lines.push('```');
        lines.push('');
      }
    }
    if (files.length) {
      lines.push('Attached local files copied into workspace:');
      for (const file of files) {
        lines.push(`- ${file}`);
      }
      lines.push('');
    }
    lines.push('User request:');
    lines.push(text || '(User only attached files.)');
    return lines.join('\n');
  }

  private runHermes(prompt: string, onChunk: (chunk: string) => void): Promise<void> {
    const config = getConfig();
    const executable = config.get<string>('executable', 'hermes');
    const extraArgs = config.get<string[]>('extraArgs', []);
    const args = [...extraArgs, ...(this.autoMode ? ['--yolo'] : []), 'chat', '-q', prompt];
    this.output.appendLine(`spawn ${executable} ${args.slice(0, -1).join(' ')} <prompt> cwd=${getWorkspaceCwd()}`);

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: getWorkspaceCwd(), shell: false });
      this.process = child;
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => onChunk(data.toString()));
      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        this.output.appendLine(`[stderr] ${chunk}`);
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        this.output.appendLine(`Hermes closed code=${code} signal=${signal ?? ''}`);
        if (signal) {
          reject(new Error(`Hermes fue detenido (${signal}).`));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Hermes terminó con código ${code}.\n${stderr}`));
        }
      });
    });
  }

  private postState(): void {
    this.host.webview.postMessage({
      type: 'state',
      messages: this.messages,
      running: this.running,
      autoMode: this.autoMode,
      cwd: getWorkspaceCwd(),
      workspace: path.basename(getWorkspaceCwd()),
      executable: getConfig().get<string>('executable', 'hermes'),
      includeSelectionDefault: getConfig().get<boolean>('includeSelectionByDefault', true),
      slashCommands: SLASH_COMMANDS
    });
  }

  private system(text: string): void {
    this.messages.push({ id: randomId(), role: 'system', text, createdAt: Date.now() });
    this.postState();
  }

  private fail(label: string, error: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    this.output.appendLine(`${label}: ${detail}`);
    this.messages.push({ id: randomId(), role: 'error', text: detail, createdAt: Date.now() });
    this.postState();
  }

  private html(): string {
    const webview = this.host.webview;
    const nonce = randomId();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'hermes-chat.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'hermes-chat.css'));
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'hermes-logo.png'));
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<link rel="stylesheet" href="${style}">
<title>Hermes IDE</title>
</head>
<body>
<div id="app" data-logo="${logo}"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function getWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? process.cwd();
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('hermesChat');
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}

function randomId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function runCommand(executable: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${executable} ${args.join(' ')} failed with code ${code}\n${stderr}`));
      }
    });
  });
}
