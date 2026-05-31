# Hermes IDE for VS Code / Cursor

MVP extension to chat with [Hermes Agent](https://github.com/NousResearch/hermes-agent) from VS Code or Cursor, without living inside a raw terminal.

The goal is to make Hermes usable for people who prefer an IDE workflow: chat panel, selected-code context, pasted screenshots and drag-and-drop files.

## MVP features

- Hermes IDE Activity Bar icon with a dedicated sidebar chat view.
- `Hermes IDE: Open Chat` command.
- Webview chat inside VS Code/Cursor.
- Sends prompts to `hermes chat -q` using the current workspace as cwd.
- Optionally includes the active editor selection.
- Supports paste/drop of files and images.
- Saves attachments into `.hermes-chat/attachments/` inside the workspace and includes their paths in the Hermes prompt.
- Configurable Hermes executable and extra CLI args.

## Requirements

- Hermes Agent installed and available as `hermes` on PATH.
- VS Code or Cursor.
- For remote workflows, install the extension in the remote SSH extension host so `hermes` runs where the code lives.

## Usage

1. Open a project folder in VS Code or Cursor.
2. Click the Hermes IDE icon in the Activity Bar, or run `Hermes IDE: Open Chat` from the Command Palette.
3. Type a prompt.
4. Optional: select code in the active editor and keep `include editor selection` checked.
5. Optional: paste screenshots/files or drag files into the drop area.
6. Press `Ctrl+Enter` / `Cmd+Enter` or click `Send to Hermes`.

If the Activity Bar icon does not appear after installing a VSIX, uninstall the old extension, install the latest versioned VSIX, and run `Developer: Reload Window`.

## Settings

```json
{
  "hermesChat.executable": "hermes",
  "hermesChat.extraArgs": [],
  "hermesChat.includeSelectionByDefault": true,
  "hermesChat.maxFileBytes": 5242880
}
```

Example with profile:

```json
{
  "hermesChat.extraArgs": ["--profile", "default"]
}
```

## Development

```bash
npm install
npm run compile
```

Then open this folder in VS Code/Cursor and press `F5` to launch an Extension Development Host.

Package locally:

```bash
npm run package
```

## Current limitations

This MVP uses one-shot CLI calls:

```bash
hermes chat -q "..."
```

That is reliable and simple, but it does not yet provide true streaming, session resume, tool approval UI, or bidirectional ACP integration.

Next milestones:

1. Streaming responses.
2. Persistent Hermes session per workspace.
3. Stop/cancel button.
4. Tool execution/approval UI.
5. Better image/file semantics.
6. Optional Hermes ACP/API backend when stable.
7. Marketplace publishing.

## Why this exists

Hermes is powerful in terminal and Telegram, but many developers want the Claude Code-style IDE experience: chat beside code, paste/drop files, and avoid terminal friction. This project is a first step toward that workflow.
