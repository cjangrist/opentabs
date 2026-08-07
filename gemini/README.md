# Gemini

OpenTabs plugin for Google Gemini — gives AI agents access to Gemini through your authenticated browser session.

## Install

```bash
opentabs plugin install gemini
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-gemini
```

## Setup

1. Open [gemini.google.com](https://gemini.google.com) in Chrome and log in
2. Open the OpenTabs side panel — the Gemini plugin should appear as **ready**

## Tools (6)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the current Gemini user profile | Read |

### Models (1)

| Tool | Description | Type |
|---|---|---|
| `list_models` | List available Gemini models | Read |

### Conversations (3)

| Tool | Description | Type |
|---|---|---|
| `list_conversations` | List recent Gemini conversations | Read |
| `get_conversation` | Get messages from the current conversation | Read |
| `create_conversation` | Start a new Gemini conversation | Write |

### Chat (1)

| Tool | Description | Type |
|---|---|---|
| `send_message` | Send a message to Gemini and get a response | Write |

## How It Works

This plugin runs inside your Gemini tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
