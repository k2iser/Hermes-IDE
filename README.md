# Hermes IDE for VS Code / Cursor

MVP extension to chat with [Hermes Agent](https://github.com/NousResearch/hermes-agent) from VS Code or Cursor, without living inside a raw terminal.

The goal is to make Hermes usable for people who prefer an IDE workflow: chat panel, selected-code context, pasted screenshots and drag-and-drop files.

## Features

- Hermes IDE Activity Bar icon with a dedicated sidebar chat view.
- Claude Code-style centered welcome screen and bottom composer, available as a full editor tab plus the Activity Bar sidebar.
- Uses the custom Hermes project logo inside the webview and VSIX metadata.
- `Hermes IDE: Open Chat`, `New Chat`, `Stop Hermes`, `Run /status`, and `Insert /help` commands.
- Webview chat inside VS Code/Cursor.
- Sends prompts to `hermes chat -q` using the current workspace as cwd.
- Optionally includes the active editor selection.
- Supports paste/drop of files and images with visible attachment chips.
- `+` button opens the webview file picker for local desktop files, then copies them into the workspace attachment folder for Hermes.
- Saves attachments into `.hermes-chat/attachments/` inside the workspace and includes their paths in the Hermes prompt.
- Richer welcome context rail showing workspace cwd, configured Hermes CLI, selection mode and Auto mode.
- Slash command menu when typing `/` or pressing the `/` toolbar button.
- Visual model menu for common Hermes providers/models plus the official `hermes model` wizard.
- Basic live output while Hermes is working: stdout chunks are appended as they arrive.
- Stop button for cancelling the active Hermes subprocess.
- Configurable Hermes executable and extra CLI args.

## Requirements

- Hermes Agent installed and available as `hermes` on PATH.
- VS Code or Cursor.
- For remote workflows, install the extension in the remote SSH extension host so `hermes` runs where the code lives.

## Usage

1. Open a project folder in VS Code or Cursor.
2. Run `Hermes IDE: Open Chat` from the Command Palette for the full Claude Code-style editor tab, or click the Hermes IDE icon in the Activity Bar for the sidebar.
3. Type a prompt in the Claude Code-style composer at the bottom.
4. Optional: type `/` to browse Hermes slash commands.
5. Optional: select code in the active editor and keep `include editor selection` checked.
6. Optional: paste screenshots/files, drag files into the composer, or click `+` to select files from your local desktop.
7. Optional: enable `Auto mode` to pass `--yolo` to Hermes for fewer approval prompts.
8. Press `Ctrl+Enter` / `Cmd+Enter` or click the ↑ send button. Use `Stop Hermes` if you need to cancel the running command.

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

That is reliable and simple, but it does not yet provide persistent session resume, a full tool approval UI, or bidirectional ACP integration. It does append stdout chunks as they arrive, so the UI feels more alive while Hermes works.

Next milestones:

1. Persistent Hermes session per workspace.
2. Tool execution/approval UI.
3. Better image/file semantics.
4. Optional Hermes ACP/API backend when stable.
5. Marketplace publishing.

## Why this exists

Hermes is powerful in terminal and Telegram, but many developers want the Claude Code-style IDE experience: chat beside code, paste/drop files, and avoid terminal friction. This project is a first step toward that workflow.
