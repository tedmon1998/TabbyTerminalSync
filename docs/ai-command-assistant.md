# AI command assistant

The assistant is configured in **Settings → AI assistant**. It supports either a direct Ollama server or a self-hosted Open WebUI instance. The selected provider, address and model are regular synchronized settings. An Open WebUI API key is saved only in the operating system keychain under `Tabby Sync AI assistant`; it is never written into `config.yaml`, PostgreSQL or the terminal scrollback.

## Using it

1. Select **Ollama** or **Open WebUI**, enter the server address and use **Test connection and load models**.
2. For Open WebUI, enter the API key created under **Settings → Account → API Keys**. It is optional only on instances with authentication disabled.
3. Select one of the models returned by the tested server.
4. Enable the assistant.
5. Type a natural-language request on the terminal command line, then press the AI button to replace it with a suggested command.
6. If the result is unsuitable, press **Again**. Tabby reuses the original request, explicitly supplies the previous result as the command to avoid, and asks the selected model for a different valid command. The regenerated command still remains editable and is never run automatically.

Ollama uses `/api/tags` and `/api/chat`. Open WebUI uses its authenticated OpenAI-compatible `/api/models` and `/api/chat/completions` endpoints.

## Context and privacy

No context is collected until **Ask** is pressed. For a local terminal Tabby sends the reported working directory, OS and (optionally) at most 80 current file or directory names. For SSH, it opens a distinct `exec` channel and runs a limited `uname`, `pwd`, `ls -1A | head -80` probe; that command and its response are not emitted to the interactive terminal.

It never sends file contents, terminal scrollback, passwords, private keys, vault secrets or saved PostgreSQL credentials. The displayed context summary is the record of the context sent for that request. Disable **Include current directory and file/folder names** in settings to send only OS and the reported location.

The assistant returns a suggestion only; it never executes a command without the explicit **Run in terminal** click.

## Directory suggestions

Directory completion does not use the LLM. After typing a simple `cd ` command, Tabby lists real directories for the current local or SSH session. Use Up/Down to select, Tab to insert, Escape to close, or click a row. Completing a directory immediately loads the next level, so nested paths can be traversed without executing intermediate commands.

Local completion reads directories through a narrow Electron IPC handler. SSH completion uses the already authenticated SFTP channel and never falls back to local Mac folders when the SSH session is disconnected. Shell metacharacters are rejected and inserted directory names are quoted for the active platform.
