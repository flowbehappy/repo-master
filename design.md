# Repo-Master (deephack) — Design & Project Plan

Repo-Master is a Feishu (Lark) bot that acts as a **TiDB question assistant**, reading chat context and replying with professional, concise answers.

If configured with one or more local repository paths, it can scan the repo(s) to answer code-related questions more accurately.

Identity: it calls itself **Repo Master** (the Feishu mention name can be configured separately, default `deephack`).

This repo implements the bot in Node.js/TypeScript using Feishu **long connection (WebSocket)** events and Feishu OpenAPI calls for history + replies.

---

## Goals

- Respond to users in Feishu with professional, actionable answers.
- When configured with local repo(s), use repo code/docs as context for code-related questions.
  - Supports named repos and optional branch variants (e.g. `repo.ticdc.master.path`, `repo.ticdc.v8.5.path`).
  - Selects the most relevant repo(s) automatically based on the user’s message (e.g. “CDC” → `ticdc`).
    - CDC mapping: `ticdc` contains CDC new architecture (v8.5+); `tiflow` contains CDC old architecture and DM.
- Keep answers concise by default; ask a small number of clarifying questions when needed.
- Use enough chat history to understand the user’s question:
  - First decide whether the **latest message (and attachments)** is self-contained.
  - Only if more context is needed:
    - If the message is inside a **thread** (`thread_id` exists): fetch **all** messages in the thread.
    - If the message is in **group chat** or **p2p** without thread: fetch the **last 20** messages in the chat.
- Trigger rules:
  - In `p2p`: respond to **every** user message.
  - In `group`: respond **only** when the message `@mentions` the bot (`@deephack`).
- Answer generation:
  - Primary: OpenAI (configurable model).
  - Fallback: deterministic response (no external calls) for testing.
- Knowledge sources:
  - Local repo scan (optional) for repo-specific questions.
  - TiDB.ai (optional) for TiDB ecosystem questions (TiDB/TiKV/PD/TiCDC/TiDB Cloud) with docs-backed answers and links.
    - TiDB.ai is the only external knowledge source (no general web browsing/search).
    - Treat TiDB.ai output as evidence; verify against repo code when applicable and call out conflicts.
    - The bot may query TiDB.ai multiple times (and scan repo(s) multiple times) to collect enough evidence before answering.
    - If TiDB.ai is unavailable (timeout/network/etc.), the bot still answers without it and shows the issue in the reply.
- Reply format:
  - Default reply uses **interactive card**; fallback to **text** if card send fails.
  - Reply normally (`reply_in_thread=false`) — do not force “topic/thread style” follow-ups.
- Message types:
  - Supports `text`, `post`, and `image`.
  - For `image` (and images embedded in `post`), the bot downloads the image(s) and uses a vision-capable model to understand them.

## Non-goals (v1)

- Full semantic code understanding (e.g., compiling/building the target repo).
- Perfect/instant repo retrieval (current repo scan is heuristic and best-effort; no ripgrep/embeddings).
- Embeddings/vector DB indexing (planned future improvement).
- Streaming partial answer content (we only show progress updates; the final answer is sent once).

---

## Architecture (high level)

**Event (WS)** → **Gate** → **Decide if history is needed** → **(Optional) Fetch history** → **(Optional) Iterative research (repo scan / TiDB.ai, repeatable)** → **Generate answer (LLM or fallback)** → **Reply (card/text)**

When images are present, the pipeline additionally downloads image resources and includes them in the LLM prompt.

### Key modules

- `src/config.ts`
  - Loads config from env / TOML (`--config`) (precedence: env → TOML).
  - Repo config supports:
    - legacy: `repo.paths` / `repo.path` / `REPO_PATHS` / `REPO_PATH`
    - named: `repo.<name>.path` and `repo.<name>.<variant...>.path`
  - Includes repo scan limits and worker pool settings (`repo.search_workers`, `repo.search_queue_max`).
- `src/cli.ts`
  - Parses CLI args (e.g. `--config ./myrepo.toml`).
- `src/lark/start.ts`
  - Creates `Client` (OpenAPI) + `WSClient` (events), registers event handlers.
- `src/lark/handlers/imMessageReceive.ts`
  - Main pipeline: gate → decide history need → (optional) history → iterative research (repo scan / TiDB.ai) → answer → reply.
- `src/lark/messages.ts`
  - Normalizes incoming events, applies trigger rules, fetches history, formats transcript.
- `src/lark/resources.ts`
  - Downloads message resources (images) via `im.v1.messageResource.get` for vision prompts.
- `src/lark/progress.ts`
  - Sends and patch-updates a “Working on it…” shared card so users can see progress for long requests.
- `src/analysis/codeQuestion.ts`
  - Determines if a message is code-related and whether repo lookup is needed.
- `src/analysis/researchFollowup.ts`
  - Decides whether more repo/TiDB.ai lookups are needed before answering and suggests next queries or clarifying questions.
- `src/research/collectAnswerContext.ts`
  - Orchestrates iterative repo searches and TiDB.ai queries; aggregates context + sources for answer generation.
- `src/repo/search.ts`
  - Scans local repo files (no `rg`) and extracts relevant excerpts + `path:line` sources.
- `src/repo/workerPool.ts` and `src/repo/repoSearchWorker.ts`
  - Runs repo scanning in worker threads with a bounded in-process queue so concurrent chats don’t block the main event loop.
- `src/tidbAi.ts`
  - Calls `https://tidb.ai/api/v1/chats` (non-streaming) to get docs-backed TiDB answers + source URLs.
- `src/answer/generateAnswer.ts`
  - OpenAI mode: builds prompt with question + transcript (+ repo context / TiDB.ai context when available).
  - Fallback mode: deterministic response for testing.
- `src/cards.ts` and `src/lark/reply.ts`
  - Builds an interactive card JSON and replies (card with text fallback).

---

## Feishu integration

### Receiving events (WebSocket)

- Use `@larksuiteoapi/node-sdk` `WSClient` with `BASE_DOMAIN=https://open.feishu.cn`.
- Register `EventDispatcher` handler for `im.message.receive_v1`.
- Ignore messages where `sender.sender_type === "app"` (bot/self).

### Trigger rules

- `chat_type === "p2p"` → always handle.
- `chat_type === "group"` → handle only if `message.mentions` contains `name === BOT_NAME` (default `deephack`).

### Replying

- Reply to the incoming `message_id` using the reply API (not “send to chat_id”).
- `reply_in_thread` remains unset/false.
- Send `msg_type="interactive"` with a card body; on failure, retry with `msg_type="text"`.
- For slow requests, send a quick “Working on it…” card and patch-update it in place (`im.v1.message.patch`), then replace it with the final answer (card `config.update_multi=true`).

### Required permissions (expected)

- History:
  - `im:message.history:readonly`
  - Group history requires `im:message.group_msg` (Feishu requirement).
- Send/reply:
  - `im:message` or `im:message:send_as_bot` (depending on app configuration)
- Progress card updates:
  - `im:message:update`
- Resource download (for image understanding):
  - `im:resource`

---

## History policy

- Pre-check (no history fetch):
  - Determine whether the latest message is self-contained or a follow-up that requires earlier context.
- If history is needed and `message.thread_id` exists:
  - Fetch all messages from `container_id_type="thread"`, paginate until `has_more=false`.
- If history is needed and not in a thread:
  - Fetch last 20 messages from `container_id_type="chat"`, sorted by create time desc.
  - Use `end_time = floor(message.create_time_ms / 1000)` to avoid pulling “future” messages.

Normalization:

- Keep only supported message types (v1: `text`, `post`, `image`).
- Convert to transcript entries `{ role: "user"|"assistant"|"unknown", text }`.

---

## Answer generation

### OpenAI mode

- Use `OPENAI_API_KEY` and `OPENAI_MODEL` (or TOML `[openai] model = ...`).
- Optional Codex-style provider config:
  - `[openai] model_provider = "crs"`
  - `[openai.model_providers.crs] base_url = "https://right.codes/codex/v1"`
  - `[openai] model_reasoning_effort = "xhigh"` (for real OpenAI this maps to `high`)
- Prompt includes:
  - The user question (mention removed).
  - Transcript (bounded by max chars/messages to avoid runaway prompts).
- Response requirements:
  - Be explicit when uncertain.
  - If repo context is missing, ask for file paths or relevant code snippets.

### Fallback mode (no LLM)

- If `MODE=fallback` or `OPENAI_API_KEY` is missing:
  - Reply with a deterministic response that echoes the question + available chat context, and includes repo excerpts when available.

---

## Operational concerns

- Dedupe: keep a small in-memory TTL set keyed by `event_id` (or `message_id` fallback).
- Limits:
  - Cap transcript size for prompts.
  - Cap number/size of snippets to stay under Feishu card limits (~30 KB).
- Logging:
  - Log event routing, fetch counts, and LLM mode; never log secrets.

---

## Project plan (implementation steps)

1. Scaffold Node/TS project structure and scripts.
2. Implement config loader (env + TOML parsing).
3. Implement Feishu WS receiver and message gating.
4. Implement history fetch for `thread` and `chat` containers.
5. Implement OpenAI answering + fallback.
6. Implement card reply + text fallback; add README with setup/run steps.

---

## Running multiple instances

Repo-Master supports loading config from a CLI-specified TOML file:

```bash
npm run dev -- --config ./examples/myrepo.toml
node dist/index.js --config ./examples/myrepo.toml
```

Use this to run multiple services on one machine (each process points at a different config file / bot name / OpenAI key).
