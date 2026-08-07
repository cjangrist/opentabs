# Kimi

OpenTabs plugin for [Kimi](https://www.kimi.com) — gives AI agents access to Kimi through your authenticated browser session.

## Setup

1. Open [kimi.com](https://www.kimi.com) in Chrome and log in
2. Open the OpenTabs side panel — the Kimi plugin should appear as **ready**

## Tools (6)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the current Kimi user profile | Read |

### Models (1)

| Tool | Description | Type |
|---|---|---|
| `list_models` | List available Kimi models | Read |

### Conversations (3)

| Tool | Description | Type |
|---|---|---|
| `list_conversations` | List recent Kimi conversations | Read |
| `get_conversation` | Get messages from a Kimi conversation | Read |
| `create_conversation` | Start a new Kimi conversation | Write |

### Chat (1)

| Tool | Description | Type |
|---|---|---|
| `send_message` | Send a message to Kimi and get the reply | Write |

## How It Works

This plugin runs inside your Kimi tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required.

Kimi's web app talks to a Connect-RPC gateway at `https://www.kimi.com/apiv2/...`, authenticated with the bearer token the app keeps in `localStorage.access_token`. The plugin calls those same endpoints:

| Purpose | Method |
|---|---|
| Current user | `kimi.gateway.account.v1.UserService/GetCurrentUser` |
| Models | `kimi.gateway.config.v1.ConfigService/GetAvailableModels` |
| Conversation list | `kimi.gateway.feed.v1.FeedService/ListFeeds` |
| Conversation metadata | `kimi.gateway.chat.v1.ChatService/GetChat` |
| Conversation messages | `kimi.gateway.chat.v1.ChatService/ListMessages` |
| Send / create chat | `kimi.gateway.chat.v1.ChatService/Chat` (streaming, `application/connect+json`) |

Expired access tokens are refreshed automatically via `GET /api/auth/token/refresh` using `localStorage.refresh_token`.

## License

MIT
