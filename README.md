# Repo-Master (deephack)

Feishu bot that answers TiDB-related questions using chat context, TiDB.ai (docs-backed), and (optionally) local repo code/documents.

## Setup

1) Install deps

```bash
npm install
```

2) Configure env

- Option A: set env vars (recommended for deployment)
  - `APP_ID`/`APP_SECRET` take precedence over TOML.
- Option B: set `app_id`/`app_secret` in a per-instance TOML config file (do not commit secrets).

Create `.env` (or export env vars) based on `.env.example`.

3) Feishu developer console

- Enable **Bot** capability for the app.
- Use **long connection (WebSocket)** event receiving.
- Subscribe to `im.message.receive_v1`.
- Ensure permissions for history and group messages (typical):
  - `im:message.history:readonly`
  - `im:message.group_msg` (required to read group history)
- For image understanding (downloading message resources):
  - `im:resource`

## Run

```bash
npm run dev
```

### Run with a config file (multiple instances)

You can run multiple bot instances on the same machine by giving each one its own TOML config:

```bash
npm run dev -- --config ./examples/myrepo.toml
```

Or after building:

```bash
npm run build
node dist/index.js --config ./examples/myrepo.toml
```

Or use the wrapper script (make it executable once):

```bash
chmod +x ./repo-master
./repo-master --config ./examples/myrepo.toml
```

### OpenAI config (Codex-style)

In the TOML config you can configure an OpenAI-compatible provider:

- `[openai]`
  - `model_provider` (e.g. `crs`)
  - `model` (e.g. `gpt-5.2`)
  - `model_reasoning_effort` (`low|medium|high|xlow|xhigh`; when using real OpenAI, `xlow/xhigh` map to `low/high`)
- `[openai.model_providers.<provider>]`
  - `base_url` (e.g. `https://right.codes/codex/v1`)
- API key: set `OPENAI_API_KEY` as an environment variable (recommended) or as a TOML top-level key.

### TiDB.ai config (optional)

Repo-Master can use `https://tidb.ai/` as an additional knowledge source for TiDB ecosystem questions.
It does not do general web search/browsing; TiDB.ai is the only external knowledge source.

- TOML: `[tidb_ai] enabled`, `base_url`, `timeout_ms`, `max_context_chars`, `max_sources`, `chat_engine`
- Env: `TIDB_AI_ENABLED`, `TIDB_AI_BASE_URL`, `TIDB_AI_TIMEOUT_MS`, `TIDB_AI_MAX_CONTEXT_CHARS`, `TIDB_AI_MAX_SOURCES`, `TIDB_AI_CHAT_ENGINE`

Notes:
- The bot may send the user’s question (and sometimes a small amount of chat context) to TiDB.ai to retrieve relevant docs-backed information.
- The final answer is produced by the bot model, which rewrites and sanity-checks TiDB.ai results and cross-checks against repo context when available.

### Vision config (optional)

If you want the bot to understand image messages, configure:

- TOML: `[vision] max_images`, `max_image_bytes`, `image_detail = "low"|"high"|"auto"`
- Env: `VISION_MAX_IMAGES`, `VISION_MAX_IMAGE_BYTES`, `VISION_IMAGE_DETAIL`

## Behavior

- `p2p`: replies to every user message.
- `group`: replies only when user `@deephack`.
- Identity: calls itself **Repo Master** (mention name may differ).
- Persona: a TiDB question assistant; answers are intentionally concise.
- Message types:
  - `text` and `post`: extracted to plain text.
  - `image` (and images embedded in `post`): downloaded and sent to a vision-capable model for understanding.
- History: first tries to answer from the latest message; if more context is needed → thread: all messages, otherwise: last 20 messages.
- Reply: interactive card, falling back to text on errors.
- Research: may query TiDB.ai and scan repo(s) multiple times; if critical details are missing it asks 1–3 targeted questions.
- Repo awareness: if the message looks code-related and needs checking the repo (and `REPO_PATHS` / `[repo].paths` is set), the bot scans one or more repos (e.g. `tidb`, `tikv`, `pd`, `ticdc`, `tiflash`) and includes relevant excerpts in the prompt (single-repo `REPO_PATH` / `[repo].path` still works).
- TiDB.ai: if the message is TiDB-related and not repo-code-specific, the bot queries TiDB.ai and includes its docs-backed context + URLs.
