# Pi experimental engine

Available from ClawPanel 0.22.0. Pi has an independent installation/configuration page and a native RPC workbench. It does not depend on OpenClaw Gateway and is **not yet at full OpenClaw feature parity**.

## First session

1. Select **Pi** in the engine selector and open **Run & Configuration**.
2. Install the managed runtime. This release pins `@earendil-works/pi-coding-agent@1.1.0`; complete Node.js >=22.19.0 and npm are required. For the current recommended OpenClaw version too, use Node.js 24.16.0+ within 24.x.
3. Open **General → Model Channels**, save the Base URL, API key and model IDs, then explicitly **sync to Pi**. Set the default model if desired.
4. Configure a project directory, open **Workbench**, create a session and verify a complete response.

Saving a shared channel does not automatically update all engines. Model metadata includes context/output limits, but these settings do not enlarge the context actually loaded by your model server.

Configuration conversion supports OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Google Generative AI and Ollama via its OpenAI-compatible `/v1` endpoint. A saved API key is currently required; structured SecretRef and OAuth are outside this path. Config readback is not proof of a successful real-provider request.

## Tool permissions

Read/grep/find/ls are enabled by default. Opting into edit/write/bash/powershell requires confirmation for each call. Path tools enforce project boundaries and protect private credentials, but **the project directory is not an OS sandbox**: approved commands still run with the operating-system account's privileges.

Project extensions, MCP, Skills, templates and context-file auto-loading are disabled by default. This preview is not a multi-user code-execution isolation service. Default directory/permission changes apply to new sessions; existing sessions retain their own project and permissions.

## Sessions and runtime

- Pi is installed privately under `<OpenClaw config root>/clawpanel/pi/`; it does not overwrite an existing global Pi or `~/.pi` installation.
- Web uses ClawPanel authentication and `/__api/pi_call`, without an additional public port. Projects and loopback model URLs refer to the **server/container**, not the browser computer.
- Desktop uses a private authenticated loopback Node bridge. Node and npm are still needed; the full Windows installer bundles WebView2, not every engine runtime.
- Up to three active sessions; idle workers are reclaimed after 30 minutes. Closing a worker preserves history. Search and batch loading are available.
- Drafts are isolated by managed instance/session in the current tab's `sessionStorage`, survive page changes/reloads, and end when the tab closes.
- Streaming, model switching, approval reminders, stopping, and history/snapshot recovery are implemented. A prompt acknowledgement is not completion. Reconnection does not automatically resend a task.
- RPC select/confirm/input/editor dialogs are supported; arbitrary custom TUI extensions are outside this integration.

## Updates and uninstall

Install/update only activates the fixed version validated by ClawPanel. Checking upstream is user-triggered; unvalidated releases are reported rather than automatically installed. Staging installation and version checks precede activation, with rollback on a failed activation check.

Management changes are blocked while a task is running. Uninstall removes only the managed runtime, retaining credentials, configuration, history and the project directory. Back these up before migration or cleanup.

## Validation boundary

The release includes three-platform CI with the actual Pi 1.1.0 CLI and a local simulated SSE provider, plus Node/Rust tests. Windows production-Web checks cover narrow layouts, switching models, denying/allowing file writes, stopping, drafts and history restoration. Simulated responses are not paid-provider validation.

Remaining acceptance includes the full Tauri GUI flow, Linux/macOS/ARM64 hardware, and real Responses/Anthropic/Google/Ollama calls. Attachments, arbitrary project extensions/MCP and full OpenClaw controls are not implemented or fully accepted here.

See the detailed [Chinese guide](pi-integration.md), [parity review](pi-openclaw-parity-review.md), and [official fixed-version RPC documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md).
