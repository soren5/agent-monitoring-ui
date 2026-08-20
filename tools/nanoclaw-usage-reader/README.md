# NanoClaw Usage Reader

A small, host-only macOS app for reading the visible **ChatGPT/Codex Usage** window. It has one supported action: `read-usage`.

It does not accept a target application, script, URL, or arbitrary command. It only locates the running ChatGPT application, finds a visible window titled `Usage`, and returns accessibility text containing usage-related terms as JSON on stdout. It makes no network requests or UI-navigation actions.

## Build and authorize

```sh
cd "/Users/soren/Documents/Agent Orchestration/nanoclaw-v2/tools/nanoclaw-usage-reader"
./setup-signing.sh # one-time: creates the helper-only local signing identity
./build.sh
./NanoClawUsageReader.app/Contents/MacOS/NanoClawUsageReader --request-accessibility
```

macOS will list **NanoClaw Usage Reader** separately under **System Settings → Privacy & Security → Accessibility**. Grant access to that app only.

`setup-signing.sh` stores a self-signed, local code-signing identity in the
login keychain. It makes the app's privacy identity stable across rebuilds; it
does not grant the app any macOS privacy permission.

## Use

Open the ChatGPT/Codex Usage view first, then run:

```sh
open NanoClawUsageReader.app
```

The helper returns JSON and fails closed if accessibility is unavailable, ChatGPT is not running, the Usage window is not visible, or no usage values can be read.
