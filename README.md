# opentabs-providers

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Normalized [OpenTabs](https://github.com/opentabs-dev/opentabs) plugins for LLM chat
providers. Your AI calls the providers' real web APIs **through your own authenticated
browser session** — no API keys, no OAuth setup, no screenshots, no DOM scraping where an
API exists.

Every provider exposes **the same tool names, inputs and output shapes**, defined in
[`SPEC.md`](SPEC.md). Conversation content is returned in the
[OpenAI Responses](https://platform.openai.com/docs/api-reference/responses) item schema, so
one consumer works across all of them.

## Providers

| Provider | Site |
|---|---|
| `gemini` | gemini.google.com |
| `claude` | claude.ai |
| `chatgpt` | chatgpt.com |
| `kimi` | kimi.com |
| `perplexity` | perplexity.com |
| `deepseek` | chat.deepseek.com |
| `qwen` | chat.qwen.ai |
| `grok` | grok.com |
| `copilot` | copilot.microsoft.com |
| `zai` | z.ai |

## Capability surface

- **Conversations** — list / get / create / send / search / rename / delete, with explicit
  cursor pagination on every list tool
- **Projects & folders** — create, update, delete, and move conversations between projects
- **Models** — parsed live from each provider's own picker at query time; never hardcoded
- **Thinking / effort** — `thinking` and `thinking_level` normalized across providers that
  expose extended thinking, reasoning effort, or a dedicated reasoning model
- **Capabilities** — `list_capabilities` reports every model, toggle and feature a provider
  actually supports, derived live
- **Deep research** — modelled as a pollable multi-step job, including clarifying-question
  handling (auto-answers `"Include everything."` by default, or raises the question to you)

File upload and attachment handling are deliberately out of scope for now.

## Setup

```bash
npm install -g @opentabs-dev/cli
opentabs start
```

Register this directory as a plugin source so every provider here is auto-discovered:

```jsonc
// ~/.opentabs/config.json
{ "localPluginDirs": ["/path/to/this/repo"] }
```

Then build a provider and it hot-reloads into the running server:

```bash
cd claude && npm install && npm run build
opentabs config set plugin-permission.claude ask
```

## Contributing

Read [`AGENTS.md`](AGENTS.md) first — commit conventions, the testing bar, and the known
failure modes that have already shipped in real plugins.

## License

[MIT](LICENSE). Portions derive from [opentabs-dev/opentabs](https://github.com/opentabs-dev/opentabs)
(MIT). Not affiliated with or endorsed by any provider.
