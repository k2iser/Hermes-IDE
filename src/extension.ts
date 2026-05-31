import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

const CHAT_VIEW_ID = 'hermesIde.chatView';
const VIEW_CONTAINER_ID = 'workbench.view.extension.hermesIde';
const FULL_PANEL_VIEW_TYPE = 'hermesIde.fullChat';

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
  type: 'ready' | 'send' | 'clear' | 'stop' | 'insertCommand' | 'openSettings' | 'pickModel' | 'setAutoMode';
  text?: string;
  attachments?: AttachmentPayload[];
  includeSelection?: boolean;
  command?: string;
  enabled?: boolean;
}

interface WebviewHost {
  webview: vscode.Webview;
}

interface ModelOption {
  label: string;
  description: string;
  provider?: string;
  model?: string;
  wizard?: boolean;
}

const SLASH_COMMANDS = [
  ['/help', 'Muestra ayuda y comandos disponibles'],
  ['/model', 'Ver o cambiar modelo'],
  ['/status', 'Estado de la sesión'],
  ['/tools', 'Gestionar herramientas'],
  ['/skills', 'Buscar e instalar skills'],
  ['/yolo', 'Alternar modo sin aprobaciones'],
  ['/new', 'Nueva sesión'],
  ['/clear', 'Limpiar conversación'],
  ['/retry', 'Reintentar último mensaje'],
  ['/undo', 'Deshacer último intercambio'],
  ['/verbose', 'Alternar salida detallada'],
  ['/config', 'Ver configuración'],
  ['/profile', 'Perfil activo'],
  ['/usage', 'Uso/tokens']
] as const;

const MODEL_OPTIONS: ModelOption[] = [
  { label: 'Asistente Hermes: abrir selector oficial', description: 'Ejecuta hermes model en terminal integrada', wizard: true },
  { label: 'OpenRouter · Claude Sonnet 4', description: 'anthropic/claude-sonnet-4', provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
  { label: 'OpenRouter · GPT-4.1', description: 'openai/gpt-4.1', provider: 'openrouter', model: 'openai/gpt-4.1' },
  { label: 'OpenRouter · Gemini 2.5 Pro', description: 'google/gemini-2.5-pro', provider: 'openrouter', model: 'google/gemini-2.5-pro' },
  { label: 'Anthropic · Claude Sonnet 4', description: 'claude-sonnet-4', provider: 'anthropic', model: 'claude-sonnet-4' },
  { label: 'Google · Gemini 2.5 Pro', description: 'gemini-2.5-pro', provider: 'google', model: 'gemini-2.5-pro' },
  { label: 'DeepSeek · Chat', description: 'deepseek-chat', provider: 'deepseek', model: 'deepseek-chat' },
  { label: 'xAI · Grok', description: 'grok-3', provider: 'xai', model: 'grok-3' },
  { label: 'Qwen OAuth · Qwen Coder', description: 'qwen-coder', provider: 'qwen-oauth', model: 'qwen-coder' },
  { label: 'Nous Portal · modelo por defecto', description: 'Configura proveedor Nous; requiere auth si no existe', provider: 'nous', model: 'default' }
];

let activeSession: HermesChatSession | undefined;
let fullPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Hermes IDE');
  output.appendLine(`Activating Hermes IDE from ${context.extensionUri.toString()}`);

  const provider = new HermesChatViewProvider(context.extensionUri, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('hermesChat.open', async () => {
      output.appendLine('Opening Hermes IDE full chat panel');
      openFullChatPanel(context.extensionUri);
    }),
    vscode.commands.registerCommand('hermesChat.openSidebar', async () => {
      output.appendLine('Opening Hermes IDE sidebar chat view');
      await revealHermesView();
    }),
    vscode.commands.registerCommand('hermesChat.newChat', async () => {
      openFullChatPanel(context.extensionUri);
      activeSession?.clear();
    }),
    vscode.commands.registerCommand('hermesChat.stop', () => {
      activeSession?.stop();
    }),
    vscode.commands.registerCommand('hermesChat.status', async () => {
      await revealHermesView();
      activeSession?.sendQuickCommand('/status');
    }),
    vscode.commands.registerCommand('hermesChat.commands', async () => {
      await revealHermesView();
      activeSession?.insertCommand('/');
    })
  );

  output.appendLine(`Registered WebviewViewProvider for ${CHAT_VIEW_ID}`);
}

export function deactivate(): void {
  activeSession?.stop();
}

async function revealHermesView(): Promise<void> {
  await vscode.commands.executeCommand(VIEW_CONTAINER_ID);
  await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
}

function openFullChatPanel(extensionUri: vscode.Uri): void {
  if (fullPanel) {
    fullPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  fullPanel = vscode.window.createWebviewPanel(
    FULL_PANEL_VIEW_TYPE,
    'Hermes IDE',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri]
    }
  );
  fullPanel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'hermes-h.svg');
  activeSession = new HermesChatSession(fullPanel, extensionUri, true);
  fullPanel.onDidDispose(() => {
    fullPanel = undefined;
    activeSession = undefined;
  });
}

class HermesChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.output.appendLine(`Resolving WebviewView ${CHAT_VIEW_ID}`);
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    activeSession = new HermesChatSession(webviewView, this.extensionUri, false);
  }
}

class HermesChatSession {
  private messages: ChatMessage[] = [];
  private running = false;
  private currentProcess: ChildProcessWithoutNullStreams | undefined;
  private autoMode = false;

  constructor(
    private readonly host: WebviewHost,
    private readonly extensionUri: vscode.Uri,
    private readonly fullSize: boolean
  ) {
    this.host.webview.html = this.getHtml();
    this.host.webview.onDidReceiveMessage(async (message: WebviewInboundMessage) => this.handleMessage(message));
  }

  clear(): void {
    this.messages = [];
    this.postState();
  }

  stop(): void {
    if (!this.currentProcess || !this.running) {
      return;
    }
    this.currentProcess.kill('SIGTERM');
    this.messages.push({ id: randomId(), role: 'system', text: 'Hermes detenido por el usuario.', createdAt: Date.now() });
    this.running = false;
    this.currentProcess = undefined;
    this.postState();
  }

  insertCommand(command: string): void {
    this.host.webview.postMessage({ type: 'insertCommand', command });
  }

  async sendQuickCommand(command: string): Promise<void> {
    await this.sendToHermes(command, [], false);
  }

  private async handleMessage(message: WebviewInboundMessage): Promise<void> {
    if (message.type === 'ready') {
      this.postState();
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

    if (message.type === 'insertCommand') {
      this.insertCommand(message.command ?? '');
      return;
    }

    if (message.type === 'openSettings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'hermesChat');
      return;
    }

    if (message.type === 'setAutoMode') {
      this.autoMode = Boolean(message.enabled);
      this.postState();
      return;
    }

    if (message.type === 'pickModel') {
      await this.pickModel();
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
      vscode.window.showWarningMessage('Hermes sigue trabajando. Pulsa Stop o espera a que termine.');
      return;
    }

    this.running = true;
    const userMessage = this.formatUserMessage(text, attachments);
    this.messages.push({ id: randomId(), role: 'user', text: userMessage, createdAt: Date.now() });
    const assistantMessage: ChatMessage = { id: randomId(), role: 'assistant', text: '', createdAt: Date.now() };
    this.messages.push(assistantMessage);
    this.postState();

    try {
      const savedAttachments = await this.saveAttachments(attachments);
      const prompt = await this.buildPrompt(text, savedAttachments, includeSelection);
      await this.runHermes(prompt, getWorkspaceCwd(), (chunk) => {
        assistantMessage.text += chunk;
        this.postState();
      });
      if (!assistantMessage.text.trim()) {
        assistantMessage.text = '(Hermes devolvió una respuesta vacía)';
      }
    } catch (error) {
      if (this.currentProcess === undefined && !this.running) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      assistantMessage.role = 'error';
      assistantMessage.text = message;
      vscode.window.showErrorMessage(`Hermes IDE falló: ${message}`);
    } finally {
      this.running = false;
      this.currentProcess = undefined;
      this.postState();
    }
  }

  private formatUserMessage(text: string, attachments: AttachmentPayload[]): string {
    const lines = [text];
    if (attachments.length) {
      lines.push('', `Adjuntos locales: ${attachments.map((a) => a.name).join(', ')}`);
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
        throw new Error(`El adjunto '${attachment.name}' pesa ${buffer.byteLength} bytes, supera hermesChat.maxFileBytes (${maxFileBytes}).`);
      }
      const safeName = sanitizeFilename(attachment.name || 'attachment.bin');
      const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;
      const fullPath = path.join(attachDir, filename);
      await fs.writeFile(fullPath, buffer);
      saved.push(fullPath);
    }
    return saved;
  }

  private async pickModel(): Promise<void> {
    const selected = await vscode.window.showQuickPick(MODEL_OPTIONS, {
      title: 'Instalar / cambiar modelo de Hermes',
      placeHolder: 'Elige un modelo soportado o abre el selector oficial de Hermes'
    });

    if (!selected) {
      return;
    }

    const executable = vscode.workspace.getConfiguration('hermesChat').get<string>('executable', 'hermes');
    if (selected.wizard) {
      const terminal = vscode.window.createTerminal({ name: 'Hermes Model Setup', cwd: getWorkspaceCwd() });
      terminal.show();
      terminal.sendText(`${executable} model`);
      this.messages.push({ id: randomId(), role: 'system', text: 'Abierto el selector oficial de modelos: `hermes model` en la terminal integrada.', createdAt: Date.now() });
      this.postState();
      return;
    }

    if (!selected.provider || !selected.model) {
      return;
    }

    try {
      await runHermesConfigSet(executable, 'model.provider', selected.provider, getWorkspaceCwd());
      await runHermesConfigSet(executable, 'model.default', selected.model, getWorkspaceCwd());
      const summary = `Modelo configurado:\nprovider: ${selected.provider}\nmodel: ${selected.model}\n\nSi faltan credenciales, ejecuta \`hermes auth add ${selected.provider}\` o usa \`hermes model\`.`;
      this.messages.push({ id: randomId(), role: 'system', text: summary, createdAt: Date.now() });
      this.postState();
      vscode.window.showInformationMessage(`Hermes IDE configuró ${selected.label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.messages.push({ id: randomId(), role: 'error', text: `No pude configurar el modelo: ${message}`, createdAt: Date.now() });
      this.postState();
    }
  }

  private async buildPrompt(text: string, attachmentPaths: string[], includeSelection: boolean): Promise<string> {
    const workspace = getWorkspaceCwd();
    const active = vscode.window.activeTextEditor;
    const lines: string[] = [];

    lines.push('You are Hermes Agent being used from the Hermes IDE VS Code/Cursor extension.');
    lines.push(`Workspace: ${workspace}`);
    lines.push(`Auto mode: ${this.autoMode ? 'enabled (--yolo requested; do not ask for routine tool approvals unless safety requires it)' : 'disabled'}`);
    lines.push('Answer in the user language unless they ask otherwise. If files are attached, inspect or reason about the paths below.');
    lines.push('Use Hermes strengths in this IDE context: inspect files, use tools, run commands, summarize clearly, and keep working until the task is complete and verified.');
    lines.push('');

    if (active) {
      lines.push(`Active file: ${active.document.uri.fsPath}`);
      if (includeSelection && !active.selection.isEmpty) {
        lines.push('Selected code/text from the editor:');
        lines.push('```');
        lines.push(active.document.getText(active.selection));
        lines.push('```');
        lines.push('');
      }
    }

    if (attachmentPaths.length) {
      lines.push('Attached local files copied into the remote/workspace attachment folder:');
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
    const config = vscode.workspace.getConfiguration('hermesChat');
    this.host.webview.postMessage({
      type: 'state',
      messages: this.messages,
      running: this.running,
      workspace: path.basename(getWorkspaceCwd()),
      cwd: getWorkspaceCwd(),
      includeSelectionDefault: config.get<boolean>('includeSelectionByDefault', true),
      executable: config.get<string>('executable', 'hermes'),
      autoMode: this.autoMode,
      slashCommands: SLASH_COMMANDS.map(([command, description]) => ({ command, description }))
    });
  }

  private runHermes(prompt: string, cwd: string, onStdout: (chunk: string) => void): Promise<void> {
    const config = vscode.workspace.getConfiguration('hermesChat');
    const executable = config.get<string>('executable', 'hermes');
    const extraArgs = config.get<string[]>('extraArgs', []);
    const autoArgs = this.autoMode && !extraArgs.includes('--yolo') ? ['--yolo'] : [];
    const args = [...extraArgs, ...autoArgs, 'chat', '-q', prompt];

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, shell: false });
      this.currentProcess = child;
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => {
        onStdout(data.toString());
      });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('error', (error) => reject(error));
      child.on('close', (code, signal) => {
        if (signal) {
          reject(new Error(`Hermes fue detenido (${signal}).`));
          return;
        }
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Hermes exited with code ${code}.\n${stderr}`));
        }
      });
    });
  }

  private getHtml(): string {
    const nonce = randomId();
    const logoUri = this.host.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'hermes-logo.png'));
    const sizeClass = this.fullSize ? 'fullSize' : 'sidebarSize';
    const slashCommandsJson = JSON.stringify(SLASH_COMMANDS.map(([command, description]) => ({ command, description })));

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.host.webview.cspSource} data:; style-src 'unsafe-inline' ${this.host.webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hermes IDE</title>
  <style>
    :root {
      color-scheme: light dark;
      --hermes-accent: #18d7f7;
      --hermes-accent-2: #7c5cff;
      --surface: var(--vscode-editor-background);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border, rgba(127,127,127,.22));
      --card: color-mix(in srgb, var(--vscode-editorWidget-background) 84%, transparent);
      --composer: color-mix(in srgb, var(--vscode-input-background) 88%, var(--vscode-editor-background));
      --shadow: 0 18px 54px rgba(0,0,0,.18);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--surface); }
    button, textarea { font-family: inherit; }
    .app { display: flex; flex-direction: column; height: 100vh; min-width: 0; overflow: hidden; }
    .topbar { min-height: 58px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; background: color-mix(in srgb, var(--surface) 94%, transparent); }
    .brandBlock { min-width: 0; }
    .eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .84; margin-bottom: 7px; }
    .title { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title img { width: 24px; height: 24px; border-radius: 50%; box-shadow: 0 0 18px color-mix(in srgb, var(--hermes-accent) 40%, transparent); }
    .title span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .topActions { display: flex; align-items: center; gap: 6px; }
    .iconBtn { min-width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; color: var(--vscode-foreground); background: transparent; border: 1px solid transparent; cursor: pointer; font-size: 13px; padding: 0 8px; }
    .iconBtn:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--border); }
    main { flex: 1; overflow-y: auto; padding: 18px 14px 142px; scroll-behavior: smooth; }
    .messagesInner { max-width: 860px; margin: 0 auto; width: 100%; }
    .hero { min-height: calc(100vh - 255px); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 14px; opacity: .98; }
    .heroLogo { width: 86px; height: 86px; border-radius: 50%; box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 20px 55px rgba(24,215,247,.18); }
    .heroTitle { font-size: clamp(22px, 4vw, 34px); font-weight: 750; letter-spacing: -.03em; display: flex; align-items: center; gap: 10px; }
    .heroTitle .spark { color: var(--hermes-accent); text-shadow: 0 0 18px var(--hermes-accent); }
    .heroText { max-width: 620px; color: var(--muted); line-height: 1.55; font-size: 14px; }
    .contextRail { display: flex; flex-wrap: wrap; gap: 7px; justify-content: center; margin-top: 2px; }
    .pill { border: 1px solid var(--border); border-radius: 999px; padding: 5px 9px; color: var(--muted); background: color-mix(in srgb, var(--card) 82%, transparent); font-size: 11px; }
    .quickGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; width: min(620px, 100%); margin-top: 8px; }
    .quick { text-align: left; padding: 10px 11px; border: 1px solid var(--border); border-radius: 12px; background: var(--card); color: var(--vscode-foreground); cursor: pointer; line-height: 1.25; }
    .quick:hover { border-color: color-mix(in srgb, var(--hermes-accent) 60%, var(--border)); transform: translateY(-1px); }
    .quick b { display: block; font-size: 12px; margin-bottom: 4px; }
    .quick span { color: var(--muted); font-size: 11px; }
    .message { border: 1px solid var(--border); border-radius: 16px; padding: 12px 13px; margin-bottom: 12px; white-space: pre-wrap; line-height: 1.48; overflow-wrap: anywhere; background: var(--card); }
    .message.user { margin-left: auto; max-width: 88%; background: color-mix(in srgb, var(--hermes-accent) 10%, var(--card)); border-color: color-mix(in srgb, var(--hermes-accent) 28%, var(--border)); }
    .message.assistant { max-width: 100%; }
    .message.error { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 8%, var(--card)); }
    .message.system { color: var(--muted); font-style: italic; }
    .role { display: flex; align-items: center; gap: 8px; font-weight: 750; margin-bottom: 7px; opacity: .95; }
    .role img { width: 18px; height: 18px; border-radius: 50%; }
    .time { margin-left: auto; font-weight: 400; color: var(--muted); font-size: 11px; }
    .composerWrap { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 14px 18px; background: linear-gradient(to top, var(--surface) 76%, transparent); pointer-events: none; }
    .composer { width: min(860px, 100%); margin: 0 auto; pointer-events: auto; border: 1px solid color-mix(in srgb, var(--hermes-accent) 48%, var(--border)); border-radius: 15px; background: var(--composer); box-shadow: var(--shadow), 0 0 0 1px color-mix(in srgb, var(--hermes-accent) 16%, transparent); overflow: visible; position: relative; }
    .dropActive .composer { border-color: var(--hermes-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--hermes-accent) 25%, transparent), var(--shadow); }
    textarea { width: 100%; min-height: 46px; max-height: 190px; resize: vertical; color: var(--vscode-input-foreground); background: transparent; border: 0; outline: none; padding: 14px 48px 8px 18px; font-size: 14px; line-height: 1.45; }
    .mic { position: absolute; right: 18px; top: 16px; opacity: .55; }
    .composerTop { position: relative; }
    .attachments { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 14px 8px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 999px; padding: 4px 8px; font-size: 11px; color: var(--muted); background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent); }
    .chip button { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0 0 0 3px; }
    .toolbar { border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 9px; }
    .leftTools, .rightTools { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .toolBtn { border: 0; background: transparent; color: var(--vscode-foreground); min-width: 30px; height: 30px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0 8px; gap: 5px; }
    .toolBtn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .sendBtn { width: 34px; height: 34px; border-radius: 10px; border: 0; cursor: pointer; color: white; background: linear-gradient(135deg, var(--hermes-accent), var(--hermes-accent-2)); font-size: 17px; box-shadow: 0 8px 24px color-mix(in srgb, var(--hermes-accent) 26%, transparent); }
    .sendBtn:disabled { opacity: .55; cursor: wait; box-shadow: none; }
    .modeToggle { color: var(--muted); font-size: 12px; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
    label { display: flex; gap: 5px; align-items: center; font-size: 12px; color: var(--muted); white-space: nowrap; }
    .running { color: var(--hermes-accent); font-size: 12px; white-space: nowrap; }
    .dropHint { display: none; position: fixed; inset: 16px; border: 2px dashed var(--hermes-accent); border-radius: 18px; background: color-mix(in srgb, var(--surface) 82%, var(--hermes-accent)); z-index: 5; align-items: center; justify-content: center; text-align: center; font-weight: 700; pointer-events: none; }
    .dropActive .dropHint { display: flex; }
    .slashMenu { display: none; position: absolute; left: 12px; right: 12px; bottom: 78px; max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); box-shadow: var(--shadow); z-index: 10; padding: 6px; }
    .slashMenu.visible { display: block; }
    .slashItem { width: 100%; text-align: left; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--vscode-foreground); cursor: pointer; display: block; }
    .slashItem:hover, .slashItem.active { background: var(--vscode-list-hoverBackground); }
    .slashItem b { display: block; font-size: 12px; }
    .slashItem span { color: var(--muted); font-size: 11px; }
    @media (max-width: 460px) {
      .topbar { min-height: 50px; padding: 8px 10px; }
      .eyebrow { display: none; }
      main { padding: 12px 8px 150px; }
      .hero { min-height: calc(100vh - 245px); }
      .heroLogo { width: 62px; height: 62px; }
      .quickGrid { grid-template-columns: 1fr; }
      .message.user { max-width: 100%; }
      .composerWrap { padding: 8px; }
      .toolbar { align-items: flex-start; }
      .leftTools, .rightTools { gap: 3px; flex-wrap: wrap; }
      .modeToggle span { display: none; }
    }
  </style>
</head>
<body class="${sizeClass}">
  <div class="app" id="app">
    <div class="dropHint">Suelta aquí imágenes, PDFs o archivos de tu equipo local<br/>Hermes los copiará al workspace para analizarlos.</div>
    <header class="topbar">
      <div class="brandBlock">
        <div class="eyebrow">HERMES IDE</div>
        <div class="title"><img src="${logoUri}" alt="Hermes" /><span id="workspaceTitle">Untitled</span></div>
      </div>
      <div class="topActions">
        <button class="iconBtn" id="modelPicker" title="Instalar / cambiar modelo">Modelos</button>
        <button class="iconBtn" id="newChat" title="Nuevo chat">⊕</button>
        <button class="iconBtn" id="settings" title="Ajustes">⚙</button>
      </div>
    </header>
    <main id="messages"><div class="messagesInner" id="messagesInner"></div></main>
    <section class="composerWrap">
      <div class="composer" id="dropZone">
        <div class="slashMenu" id="slashMenu"></div>
        <div class="composerTop">
          <textarea id="input" placeholder="Pide a Hermes que construya, revise, investigue o automatice… Escribe / para comandos"></textarea>
          <div class="mic" title="Voz próximamente">◌</div>
        </div>
        <div class="attachments" id="attachments"></div>
        <div class="toolbar">
          <div class="leftTools">
            <button class="toolBtn" id="attach" title="Adjuntar archivo local desde tu escritorio/equipo">＋</button>
            <button class="toolBtn" id="slashBtn" title="Comandos disponibles">/</button>
            <label title="Incluye el texto seleccionado del editor en el prompt"><input type="checkbox" id="includeSelection" checked /> selección</label>
          </div>
          <div class="rightTools">
            <span class="running" id="running"></span>
            <label class="modeToggle" title="Auto mode añade --yolo: Hermes no pedirá aprobación para acciones rutinarias"><input type="checkbox" id="autoMode" /><span>Auto mode</span></label>
            <button class="toolBtn" id="stop" title="Detener Hermes" style="display:none">Stop</button>
            <button class="sendBtn" id="send" title="Enviar (Ctrl/Cmd+Enter)">↑</button>
          </div>
        </div>
      </div>
      <input id="fileInput" type="file" multiple style="display:none" />
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const appEl = document.getElementById('app');
    const messagesEl = document.getElementById('messages');
    const messagesInnerEl = document.getElementById('messagesInner');
    const inputEl = document.getElementById('input');
    const sendEl = document.getElementById('send');
    const stopEl = document.getElementById('stop');
    const runningEl = document.getElementById('running');
    const attachmentsEl = document.getElementById('attachments');
    const includeSelectionEl = document.getElementById('includeSelection');
    const autoModeEl = document.getElementById('autoMode');
    const dropZoneEl = document.getElementById('dropZone');
    const workspaceTitleEl = document.getElementById('workspaceTitle');
    const slashMenuEl = document.getElementById('slashMenu');
    const fileInputEl = document.getElementById('fileInput');
    const slashCommands = ${slashCommandsJson};
    let attachments = [];
    let includeSelectionTouched = false;
    let autoModeTouched = false;

    const quickPrompts = [
      ['Adjuntar archivo local', 'Pulsa + o arrastra desde tu escritorio'],
      ['/help', 'Ver comandos de Hermes'],
      ['Instalar / cambiar modelo', 'Abre el selector visual de modelos'],
      ['Explica un error', 'Pega logs o stack traces']
    ];

    function render(state) {
      workspaceTitleEl.textContent = state.workspace || 'Untitled';
      if (!includeSelectionTouched && typeof state.includeSelectionDefault === 'boolean') {
        includeSelectionEl.checked = state.includeSelectionDefault;
      }
      if (!autoModeTouched && typeof state.autoMode === 'boolean') {
        autoModeEl.checked = state.autoMode;
      }
      messagesInnerEl.innerHTML = '';
      if (!state.messages.length) {
        const hero = document.createElement('div');
        hero.className = 'hero';
        const logo = document.createElement('img');
        logo.className = 'heroLogo';
        logo.src = '${logoUri}';
        logo.alt = 'Hermes';
        const title = document.createElement('div');
        title.className = 'heroTitle';
        title.innerHTML = '<span class="spark">✦</span><span>Hermes IDE</span>';
        const text = document.createElement('div');
        text.className = 'heroText';
        text.textContent = 'Hermes dentro de VS Code/Cursor: selección de código, archivos locales desde tu escritorio, slash commands, modelos y salida en vivo mientras trabaja.';
        const rail = document.createElement('div');
        rail.className = 'contextRail';
        for (const item of ['cwd: ' + (state.cwd || state.workspace || 'workspace'), 'cli: ' + (state.executable || 'hermes'), includeSelectionEl.checked ? 'selección activa' : 'selección off', autoModeEl.checked ? 'auto mode on' : 'auto mode off']) {
          const pill = document.createElement('span');
          pill.className = 'pill';
          pill.textContent = item;
          rail.appendChild(pill);
        }
        const grid = document.createElement('div');
        grid.className = 'quickGrid';
        for (const [label, desc] of quickPrompts) {
          const btn = document.createElement('button');
          btn.className = 'quick';
          btn.innerHTML = '<b></b><span></span>';
          btn.querySelector('b').textContent = label;
          btn.querySelector('span').textContent = desc;
          btn.addEventListener('click', () => {
            if (label.startsWith('/')) { inputEl.value = label; inputEl.focus(); showSlashMenu(true); return; }
            if (label.startsWith('Adjuntar')) { fileInputEl.click(); return; }
            if (label.startsWith('Instalar')) { vscode.postMessage({ type: 'pickModel' }); return; }
            inputEl.value = label + ': ';
            inputEl.focus();
          });
          grid.appendChild(btn);
        }
        hero.appendChild(logo);
        hero.appendChild(title);
        hero.appendChild(text);
        hero.appendChild(rail);
        hero.appendChild(grid);
        messagesInnerEl.appendChild(hero);
      }
      for (const msg of state.messages) {
        const div = document.createElement('div');
        div.className = 'message ' + msg.role;
        const role = document.createElement('div');
        role.className = 'role';
        if (msg.role === 'assistant') {
          const img = document.createElement('img');
          img.src = '${logoUri}';
          img.alt = 'Hermes';
          role.appendChild(img);
        }
        const roleLabel = document.createElement('span');
        roleLabel.textContent = msg.role === 'assistant' ? 'Hermes' : msg.role === 'user' ? 'Tú' : msg.role;
        role.appendChild(roleLabel);
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        role.appendChild(time);
        const text = document.createElement('div');
        text.textContent = msg.text || (msg.role === 'assistant' && state.running ? 'Hermes está trabajando…' : '');
        div.appendChild(role);
        div.appendChild(text);
        messagesInnerEl.appendChild(div);
      }
      runningEl.textContent = state.running ? 'Trabajando…' : '';
      stopEl.style.display = state.running ? 'inline-flex' : 'none';
      sendEl.disabled = state.running;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderAttachments() {
      attachmentsEl.innerHTML = '';
      attachments.forEach((attachment, index) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = '📎 ' + attachment.name;
        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.title = 'Quitar';
        remove.addEventListener('click', () => { attachments.splice(index, 1); renderAttachments(); });
        chip.appendChild(remove);
        attachmentsEl.appendChild(chip);
      });
    }

    async function fileToAttachment(file) {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return { name: file.name || 'local-file', mime: file.type || 'application/octet-stream', dataBase64: btoa(binary) };
    }

    async function addFiles(fileList) {
      for (const file of fileList) {
        attachments.push(await fileToAttachment(file));
      }
      renderAttachments();
      inputEl.focus();
    }

    function send() {
      const text = inputEl.value;
      if (!text.trim() && attachments.length === 0) return;
      vscode.postMessage({ type: 'send', text, attachments, includeSelection: includeSelectionEl.checked });
      inputEl.value = '';
      attachments = [];
      renderAttachments();
      hideSlashMenu();
    }

    function commandMatches(command, query) {
      return command.command.toLowerCase().includes(query.toLowerCase()) || command.description.toLowerCase().includes(query.toLowerCase());
    }

    function getSlashQuery() {
      const value = inputEl.value;
      const cursor = inputEl.selectionStart || value.length;
      const before = value.slice(0, cursor);
      const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf(' '));
      const token = before.slice(lastBreak + 1);
      return token.startsWith('/') ? token : null;
    }

    function showSlashMenu(force = false) {
      const query = force ? '/' : getSlashQuery();
      if (!query) { hideSlashMenu(); return; }
      slashMenuEl.innerHTML = '';
      const matches = slashCommands.filter(cmd => commandMatches(cmd, query.slice(1))).slice(0, 12);
      if (!matches.length) { hideSlashMenu(); return; }
      for (const cmd of matches) {
        const item = document.createElement('button');
        item.className = 'slashItem';
        item.innerHTML = '<b></b><span></span>';
        item.querySelector('b').textContent = cmd.command;
        item.querySelector('span').textContent = cmd.description;
        item.addEventListener('click', () => insertSlashCommand(cmd.command));
        slashMenuEl.appendChild(item);
      }
      slashMenuEl.classList.add('visible');
    }

    function hideSlashMenu() {
      slashMenuEl.classList.remove('visible');
    }

    function insertSlashCommand(command) {
      const value = inputEl.value;
      const cursor = inputEl.selectionStart || value.length;
      const before = value.slice(0, cursor);
      const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf(' '));
      const prefix = before.slice(0, lastBreak + 1);
      const after = value.slice(cursor);
      inputEl.value = prefix + command + (after ? ' ' + after : '');
      hideSlashMenu();
      inputEl.focus();
    }

    includeSelectionEl.addEventListener('change', () => { includeSelectionTouched = true; });
    autoModeEl.addEventListener('change', () => { autoModeTouched = true; vscode.postMessage({ type: 'setAutoMode', enabled: autoModeEl.checked }); });
    sendEl.addEventListener('click', send);
    stopEl.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('newChat').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
    document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    document.getElementById('modelPicker').addEventListener('click', () => vscode.postMessage({ type: 'pickModel' }));
    document.getElementById('attach').addEventListener('click', () => fileInputEl.click());
    document.getElementById('slashBtn').addEventListener('click', () => { inputEl.value = inputEl.value || '/'; inputEl.focus(); showSlashMenu(true); });
    fileInputEl.addEventListener('change', async () => { await addFiles(fileInputEl.files || []); fileInputEl.value = ''; });
    inputEl.addEventListener('input', () => showSlashMenu(false));
    inputEl.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); }
      if (event.key === 'Escape') { hideSlashMenu(); }
      if (event.key === '/' && !inputEl.value.trim()) { setTimeout(() => showSlashMenu(true), 0); }
    });
    ['dragenter', 'dragover'].forEach(name => document.addEventListener(name, (event) => { event.preventDefault(); appEl.classList.add('dropActive'); }));
    ['dragleave', 'drop'].forEach(name => document.addEventListener(name, (event) => { if (name !== 'drop') event.preventDefault(); appEl.classList.remove('dropActive'); }));
    dropZoneEl.addEventListener('drop', async (event) => { event.preventDefault(); await addFiles(event.dataTransfer.files); });
    document.addEventListener('paste', async (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) { await addFiles(files); }
    });
    window.addEventListener('message', (event) => {
      if (event.data.type === 'state') render(event.data);
      if (event.data.type === 'insertCommand') { inputEl.value = event.data.command || ''; inputEl.focus(); showSlashMenu(inputEl.value.startsWith('/')); }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

async function runHermesConfigSet(executable: string, key: string, value: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['config', 'set', key, value], { cwd, shell: false });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || stdout || `hermes config set ${key} exited with code ${code}`));
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
