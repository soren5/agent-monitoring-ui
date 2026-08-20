# NanoClaw Codex Status Reader

Host-only, fixed-function reader for the Codex CLI `/status` display.

The program accepts no arguments. It starts only the local `~/.local/bin/codex`
executable in a private pseudo-terminal, sends the literal `/status` command,
then returns only the displayed weekly-limit percentage and reset time as JSON.
It does not make a model request, edit a repository, expose a terminal to an
agent, or require Accessibility, Screen Recording, or Automation permission.

NanoClaw's host bridge is its sole caller. Containers can invoke only the
bridge's `POST /snapshot` action; they cannot choose a command, executable,
arguments, or destination.
