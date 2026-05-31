# Hermes Chat VS Code Extension MVP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a minimal VS Code/Cursor extension that lets a user chat with Hermes Agent from an IDE panel and send pasted/dropped files.

**Architecture:** A VS Code extension contributes a `Hermes Chat: Open` command. The command opens a Webview chat panel. The extension host receives prompts and attachments from the Webview, saves attachments into the workspace, builds a contextual prompt, and invokes the local/remote Hermes CLI via `hermes chat -q`.

**Tech Stack:** VS Code Extension API, TypeScript, Node.js child_process, Hermes CLI.

---

## MVP acceptance criteria

- The extension compiles with `npm run compile`.
- VS Code/Cursor can open a `Hermes Chat` panel.
- The user can send a prompt to Hermes.
- The active editor selection can be included.
- Pasted/dropped files are saved under `.hermes-chat/attachments` and their paths are sent to Hermes.
- Settings allow changing the Hermes executable and adding extra Hermes CLI args.

## Task 1: Scaffold VS Code extension

**Objective:** Create package metadata and TypeScript config.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Verification:**

Run:

```bash
npm install
npm run compile
```

Expected: TypeScript starts successfully. It may fail until `src/extension.ts` exists.

## Task 2: Register command and panel

**Objective:** Add `hermesChat.open` command that creates/reveals a Webview panel.

**Files:**
- Create: `src/extension.ts`

**Implementation notes:**

- Export `activate(context)`.
- Register `vscode.commands.registerCommand('hermesChat.open', ...)`.
- Use singleton panel behavior.
- Enable scripts and retain Webview context.

**Verification:**

Run `npm run compile`.

## Task 3: Build Webview chat UI

**Objective:** Provide a basic chat interface with text input, send button, clear button, include-selection checkbox, and attachment drop area.

**Files:**
- Modify: `src/extension.ts`

**Implementation notes:**

- Use `acquireVsCodeApi()`.
- Post messages of type `send`, `clear`, `ready`.
- Accept drag/drop and paste files.
- Convert files to base64 before posting to extension host.

**Verification:**

Open Extension Development Host and confirm the UI renders.

## Task 4: Save attachments and build Hermes prompt

**Objective:** Save Webview attachments into workspace and include useful context in prompt.

**Files:**
- Modify: `src/extension.ts`

**Implementation notes:**

- Save to `<workspace>/.hermes-chat/attachments`.
- Enforce `hermesChat.maxFileBytes`.
- Include workspace path, active file path, selected text, attachment paths, and user request.

**Verification:**

Paste/drop a file and confirm it appears under `.hermes-chat/attachments`.

## Task 5: Invoke Hermes CLI

**Objective:** Send prompt to Hermes and render response.

**Files:**
- Modify: `src/extension.ts`

**Implementation notes:**

- Read `hermesChat.executable` and `hermesChat.extraArgs`.
- Spawn: `<executable> ...extraArgs chat -q <prompt>`.
- Set cwd to workspace root.
- Collect stdout/stderr.
- Show errors in the chat and via VS Code error notification.

**Verification:**

Run a simple prompt from a workspace where `hermes` is available.

## Task 6: Package and document

**Objective:** Create README and package as VSIX.

**Files:**
- Create: `README.md`

**Verification:**

Run:

```bash
npm run compile
npm run package
```

Expected: a `.vsix` package is produced.
