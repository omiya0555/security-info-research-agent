# Specifications

## 1. Agent

### 1.1 Overview

Strands Agents SDK (@strands-agents/sdk) で構築された対話型セキュリティ脆弱性調査エージェント。Slack 上でユーザーと対話しながら、複数のセキュリティ情報ソースを横断調査する。

### 1.2 Model

| Parameter | Value |
|---|---|
| Provider | Amazon Bedrock |
| Model | Claude Sonnet 4.6 (via inference-profile) |
| Max Tokens | 4096 (configurable: `MAX_TOKENS`) |
| Prompt Caching | `auto` strategy (configurable: `CACHE_STRATEGY`) |

### 1.3 System Prompt

XML タグ + RFC 2119 キーワードで構造化。[Anthropic 公式推奨パターン](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/use-xml-tags)に準拠。

```xml
<role>         -- 役割定義 + 現在日付 (Date injection for knowledge cutoff)
<instructions> -- 対話方針 + スキル使用ルール
<output_format> -- Slack mrkdwn 記法ルール + 引用元 URL 形式
<constraints>  -- 言語、簡潔性、絵文字禁止、推測禁止
<available_skills> -- Skills Plugin が起動時に自動追加
```

#### 対話方針の要点

- 曖昧な依頼 → 確認質問を返す（MUST）
- CVE ID / 製品名だけ → ツールで概要取得、3-5行で回答 + 深掘り選択肢を提示（MUST）
- 「詳しく」「レポートにして」→ security-investigation スキル発動（MUST）
- 前の会話を踏まえた深掘り対応（MUST）

#### Slack mrkdwn 出力ルール

標準 Markdown ではなく Slack mrkdwn で出力する:

| Standard Markdown | Slack mrkdwn | Note |
|---|---|---|
| `**bold**` | `*bold*` | 逆転 |
| `*italic*` | `_italic_` | `*` は Slack では太字 |
| `[text](url)` | `<url\|text>` | 順序逆 |
| `## Header` | `*Header*` | 太字で代替 |
| `\| table \|` | リスト形式 | テーブル非対応 |
| `---` | (使用不可) | 水平線非対応 |

ツール結果を含む回答には末尾に引用元 URL を付与:
```
引用元:
- <URL|ソース名>
```

### 1.4 Conversation Manager

`SlidingWindowConversationManager` を使用:

| Parameter | Default | Env Var |
|---|---|---|
| Window Size | 10 | `WINDOW_SIZE` |
| Truncate Results | true | `TRUNCATE_RESULTS` |

Truncate Results は、コンテキストウィンドウが溢れそうな場合に古いツール結果を先頭200文字 + 末尾200文字に切り詰める。メッセージ削除の前に実行される。

### 1.5 Session Management

server.ts が in-memory `Map<sessionId, Message[]>` でセッション管理。Slack Worker は `slack-thread-{channel}-{threadTs}` を Session ID として使用し、同一スレッド内の会話を継続。

| Parameter | Default | Env Var |
|---|---|---|
| Session TTL | 30 min | `SESSION_TTL_MS` |

---

## 2. Tools

### 2.1 nvd_lookup

NVD (National Vulnerability Database) API v2.0 から CVE 情報を取得する。

| Item | Value |
|---|---|
| Type | Custom Tool (Zod schema) |
| Base URL | `https://services.nvd.nist.gov/rest/json/cves/2.0` |
| Auth | `apiKey` header (optional, for rate limit relaxation) |
| Rate Limit | 5 req/30s (no key), 50 req/30s (with key) |

#### Input Schema

```typescript
z.object({
  cveId: z.string().regex(/^CVE-\d{4}-\d{4,}$/).optional(),
  keywordSearch: z.string().optional(),
  cvssV3Severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  pubStartDate: z.string().optional(),   // ISO 8601
  pubEndDate: z.string().optional(),     // ISO 8601
  hasKev: z.boolean().optional(),
  resultsPerPage: z.number().min(1).max(100).optional().default(20),
})
```

#### Response

NVD API の生レスポンスに `_sourceUrl` フィールドを追加して返却。主要フィールド:
- `id` (CVE ID), `description`, `published`, `lastModified`
- `metrics.cvssMetricV31[].cvssData` (baseScore, baseSeverity, vectorString)
- `weaknesses[].description[].value` (CWE IDs)
- `references[]` (url, tags)
- `configurations[].nodes[].cpeMatch[].criteria` (affected products)

### 2.2 shodan_cve

Shodan CVEDB から CVE 情報を取得する。EPSS / KEV / ランサムウェア情報を含む。

| Item | Value |
|---|---|
| Type | Custom Tool (Zod schema) |
| Base URL | `https://cvedb.shodan.io` |
| Auth | 不要 (完全無料) |
| Cache | Cloudflare 5日間 |

#### Input Schema

```typescript
z.object({
  cveId: z.string().regex(/^CVE-\d{4}-\d{4,}$/).optional(),
  product: z.string().optional(),
  isKev: z.boolean().optional().default(false),
  sortByEpss: z.boolean().optional().default(false),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().min(1).max(100).optional().default(20),
})
```

#### Endpoints

- `cveId` 指定: `GET /cve/{cveId}` (単体詳細)
- `cveId` なし: `GET /cves?{params}` (一覧検索)

#### Response

主要フィールド: `cve_id`, `summary`, `cvss` (latest), `cvss_v2/v3/v4`, `epss`, `ranking_epss`, `kev`, `propose_action`, `ransomware_campaign`, `references[]`, `published_time`

### 2.3 aws_bulletin

AWS Security Bulletins を RSS フィードから取得する。

| Item | Value |
|---|---|
| Type | Custom Tool (Zod schema) |
| RSS URL | `https://aws.amazon.com/security/security-bulletins/rss/feed/` |
| Auth | 不要 (パブリック) |
| Data Volume | ~35 items (as of 2026-04) |

#### Input Schema

```typescript
z.object({
  keyword: z.string().optional(),  // Service name, CVE ID, etc.
})
```

#### Behavior

1. RSS フィード (XML) を全件取得
2. `keyword` 指定時: title + description でクライアント側フィルタ
3. `keyword` 未指定: 全件返却

#### Response

```typescript
{ totalResults: number, items: BulletinItem[], _sourceUrl: string }

interface BulletinItem {
  title: string;       // "CVE-2026-5707, CVE-2026-5708 - Issues with AWS RES"
  link: string;        // Bulletin URL
  description: string; // HTML entities included
  pubDate: string;     // RFC 2822 date
}
```

### 2.4 Tavily MCP (tavily_search / tavily_extract)

Tavily MCP Server 経由の Web 検索・コンテンツ取得。

| Item | Value |
|---|---|
| Type | MCP (stdio transport) |
| Server | `npx -y tavily-mcp@latest` |
| Auth | `TAVILY_API_KEY` (environment variable) |
| Tools | `tavily_search`, `tavily_extract` |

#### tavily_search

Web 検索。セキュリティブログ、ベンダー勧告、ニュース記事を取得。

#### tavily_extract

指定 URL からコンテンツを抽出。Agent が aws_bulletin のリンク先を深掘りする際に自動判断で使用。

### 2.5 activate_skill (Plugin Tool)

Skills Plugin が提供する内部ツール。指定スキルのフル指示を遅延ロードする。

| Item | Value |
|---|---|
| Type | Plugin-generated Tool |
| Trigger | Agent が LLM の判断で呼出し |

#### Input Schema

```typescript
z.object({
  skillName: z.string(),  // e.g. "security-investigation"
})
```

#### Behavior

- スキルが存在: SKILL.md のフル指示テキストを返却
- スキルが不存在: 利用可能なスキル一覧を返却

---

## 3. Skills

### 3.1 Skills Plugin (Progressive Disclosure)

トークン効率のため、スキルの指示は遅延ロードされる:

1. 起動時: スキル名 + description のみ System Prompt に注入 (`<available_skills>`)
2. 発動時: `activate_skill` ツール呼出しでフル指示をコンテキストにロード

SKILL.md フォーマット:
```markdown
---
name: skill-name
description: 1行の説明（LLM がスキル選択に使用）
---

(Full instructions loaded on activation)
```

### 3.2 security-investigation

セキュリティ脆弱性の詳細調査スキル。

#### 発動条件

ユーザーが「詳しく調査して」「詳細を教えて」「レポートにして」「深掘りして」等、明示的に詳細調査を依頼した場合にのみ使用。CVE ID や製品名だけの入力では MUST NOT 発動しない。

#### Instructions

XML タグ + RFC 2119 で構造化:

```xml
<instructions>  -- ツール使い分けルール + 重要度判断基準
<output_format> -- Markdown 出力形式、要約セクション、ソース URL
<constraints>   -- 事実のみ報告、失敗ソース明示
```

#### Tool Usage Rules

| Condition | Tools |
|---|---|
| CVE ID specified | nvd_lookup + shodan_cve (MUST both) |
| Product/keyword | shodan_cve → nvd_lookup (SHOULD supplement) |
| AWS service | aws_bulletin (MUST) → tavily_extract (SHOULD for details) |
| Patches/news | tavily_search (SHOULD) |

#### Severity Assessment

1. CVSS Score — technical severity (primary)
2. EPSS Score — exploitation probability within 30 days
3. KEV Status — confirmed in-the-wild exploitation by CISA

### 3.3 analysis-template

セキュリティ事例の読み解きテンプレート。

#### 発動条件

ユーザーが「読み解きテンプレートで」「テンプレートで出力して」「テンプレートで分析して」等と指示した場合。

#### Template Structure

7 セクション構成 (全セクション MUST 含める):

1. 全体像 — 3-5行の概要
2. タイムライン — 時系列表形式（攻撃開始〜対応完了）
3. 攻撃の詳細 — 手法 / IoC / 攻撃者帰属
4. 影響規模 — 定量的記述
5. なぜ既存の防御が機能しなかったのか — 技術 + 運用両面
6. 推奨される対策 — 即時 / 短期 / 長期の3段階
7. 開発者にとっての学び — アクションアイテム付き

---

## 4. Server (AgentCore Runtime)

### 4.1 HTTP Endpoints

| Path | Method | Content-Type | Description |
|---|---|---|---|
| `/ping` | GET | `application/json` | Health check |
| `/invocations` | POST | `text/event-stream` | Agent invocation (SSE) |

### 4.2 SSE Event Specification

#### tool_start

ツール実行開始時に送出。

```json
{"event": "tool_start", "tool": "nvd_lookup", "label": "NVD API"}
```

| Field | Type | Description |
|---|---|---|
| `tool` | string | ツール名 (internal name) |
| `label` | string | 表示用ラベル (日本語) |

Label mapping:

| Tool Name | Label |
|---|---|
| `nvd_lookup` | NVD API |
| `shodan_cve` | Shodan CVEDB |
| `aws_bulletin` | AWS Security Bulletins |
| `tavily_search` | Web 検索 |
| `tavily_extract` | Web ページ取得 |
| (other) | tool name as-is |

#### tool_end

ツール実行完了時に送出。

```json
{"event": "tool_end", "tool": "nvd_lookup", "label": "NVD API", "error": null}
```

| Field | Type | Description |
|---|---|---|
| `error` | string \| null | エラー時のメッセージ |

#### result

最終結果。

```json
{"event": "result", "format": "message", "content": "CVE-2024-6387 の概要です。..."}
```

| Field | Type | Description |
|---|---|---|
| `format` | `"message"` \| `"report"` | `"report"` = activate_skill が発動された場合 |
| `content` | string | Agent の回答テキスト |

`format` は server.ts が `activate_skill` ツールの発動を追跡して設定する。Worker Lambda はこの値でスニペット化の判断に利用可能。

#### error

Agent 実行中のエラー。

```json
{"event": "error", "message": "Internal server error"}
```

### 4.3 Session Lifecycle

1. Request arrives with `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header
2. If session exists in Map → restore `agent.messages`
3. If not → `agent.messages = []`
4. Process `agent.stream(prompt)` → SSE events
5. After completion → save `agent.messages` to Map
6. Every 5 minutes → cleanup sessions older than `SESSION_TTL_MS`

---

## 5. Slack Integration

### 5.1 Receiver Lambda

**File:** `slack/lambda/receiver.ts`

#### Request Processing

1. Base64 decode body if `isBase64Encoded`
2. Check `x-slack-retry-num` header → skip if present (200 OK)
3. Verify Slack signature: `HMAC-SHA256(v0:{timestamp}:{body})` vs `x-slack-signature`
4. Parse JSON body
5. Route by `type`:
   - `url_verification` → respond with `challenge`
   - `event_callback` → process event

#### Event Processing

1. Check `bot_id` → skip if present (loop prevention)
2. Resolve `threadTs`: `event.thread_ts ?? event.ts`
3. Enqueue to SQS FIFO:
   - Body: `{ channel, threadTs, text, user, eventTs }`
   - MessageGroupId: `{channel}-{threadTs}`
   - MessageDeduplicationId: `{channel}-{eventTs}`
4. Return 200 OK

### 5.2 Worker Lambda

**File:** `slack/lambda/worker.ts`

#### Processing Flow

1. Parse SQS record body → `{ channel, threadTs, text }`
2. Get bot token from SSM (cached)
3. Strip mention: `text.replace(/<@[A-Z0-9]+>/g, '').trim()`
4. Post "リクエストを受け付けました" to thread
5. Call `invokeAndStream()` with session ID `slack-thread-{channel}-{threadTs}`

### 5.3 Push Worker Lambda

**File:** `slack/lambda/push-worker.ts`

#### Processing Flow

1. Extract findings from EventBridge event
2. For each finding:
   a. Post `*[{severity}] Security Hub Finding 検出*\n{title}` to Slack channel (new thread)
   b. Construct prompt from finding fields (Title, Severity, CVE IDs, Resources, Description)
   c. Call `invokeAndStream()` with session ID `push-{channel}-{threadTs}-{timestamp}`

### 5.4 Shared Module

**File:** `slack/lambda/shared.ts`

#### postToSlack()

`chat.postMessage` with `mrkdwn: true`. Returns message `ts` for thread replies.

#### uploadSnippet()

3-step Slack file upload:
1. `files.getUploadURLExternal` (filename, length, snippet_type: "markdown")
2. Upload content to pre-signed URL
3. `files.completeUploadExternal` (share to channel + thread)

#### invokeAndStream()

1. `InvokeAgentRuntimeCommand` with SSE streaming
2. Parse SSE events from `AsyncIterable<Uint8Array>` response
3. For each event:
   - `tool_start` → `postToSlack("{label} を検索中...")`
   - `tool_end` + error → `postToSlack("{label} (エラー: {error})")`
   - `result` + content > 1500 chars → `uploadSnippet()` as `report.md`
   - `result` + content <= 1500 chars → `postToSlack(content)`
   - `error` → `postToSlack("エラーが発生しました: {message}")`

#### Snippet Threshold

| Condition | Action |
|---|---|
| Content <= 1500 chars | `chat.postMessage` (Slack mrkdwn) |
| Content > 1500 chars | `files.uploadV2` as `report.md` snippet |

### 5.5 Slack App Configuration

**Manifest:** `slack/app-manifest.json`

| Setting | Value |
|---|---|
| Bot Display Name | security-agent |
| Always Online | true |
| Bot Scopes | `app_mentions:read`, `chat:write`, `files:write` |
| Event Subscriptions | `app_mention` |

---

## 6. CDK Stack

### 6.1 Stack: SecurityAgentStack

**File:** `cdk/lib/security-agent-stack.ts`

Single stack managing all resources.

### 6.2 AgentCore Resources

| Resource | Construct | Configuration |
|---|---|---|
| Runtime | `agentcore.Runtime` | `security_agent_runtime`, Docker asset from `agent/`, env vars for SSM param names |
| Gateway | `agentcore.Gateway` | `security-agent-gateway`, no targets (Phase 4) |

### 6.3 Slack Resources

| Resource | Construct | Configuration |
|---|---|---|
| SQS DLQ | `sqs.Queue` | FIFO, 14 day retention |
| SQS Queue | `sqs.Queue` | FIFO, visibility 900s, DLQ attached (maxReceiveCount: 2) |
| Receiver | `NodejsFunction` | Node.js 24, ARM64, 10s timeout |
| Worker | `NodejsFunction` | Node.js 24, ARM64, 900s timeout, 256MB, SQS event source (batchSize: 1) |
| HTTP API | `HttpApi` | `POST /slack/events` → Receiver |

### 6.4 EventBridge Resources

| Resource | Construct | Configuration |
|---|---|---|
| Push Worker | `NodejsFunction` | Node.js 24, ARM64, 900s timeout, 256MB |
| SecurityHubRule | `events.Rule` | source: `aws.securityhub`, disabled by default |

Context variables:

| Key | Default | Description |
|---|---|---|
| `enableSecurityHubPush` | `false` | EventBridge Rule の有効/無効 |
| `slackChannel` | `""` | Push 通知先 Slack チャンネル ID |

### 6.5 Outputs

| Output | Description |
|---|---|
| `SlackApiUrl` | Slack Event Subscriptions に設定する URL |
| `RuntimeArn` | AgentCore Runtime ARN |

---

## 7. Secrets Management

All secrets stored in SSM Parameter Store (SecureString), prefix: `/security-agent/`.

| Parameter | Consumer | Purpose |
|---|---|---|
| `/security-agent/tavily-api-key` | AgentCore Runtime | Tavily MCP auth |
| `/security-agent/nvd-api-key` | AgentCore Runtime | NVD rate limit relaxation |
| `/security-agent/slack-bot-token` | Worker Lambda, Push Worker | Slack API auth (`xoxb-...`) |
| `/security-agent/slack-signing-secret` | Receiver Lambda | Slack signature verification |

Resolution pattern:
- AgentCore Runtime: `resolveEnv()` checks env var first, falls back to SSM
- Lambda: Direct SSM fetch with in-memory cache per container lifetime

---

## 8. Error Handling

### 8.1 Agent Tool Errors

| Error | Handling |
|---|---|
| NVD API rate limit (403) | Report with Shodan + Tavily only. State NVD failure. |
| Shodan CVEDB timeout | Report with NVD + Tavily only. |
| Tavily MCP connection failure | Report with NVD + Shodan only. State web search unavailable. |
| All tools fail | "現在情報を取得できません。時間をおいて再試行してください" |
| CVE ID not found | "指定された CVE ID は見つかりませんでした" |

### 8.2 Slack Integration Errors

| Error | Handling |
|---|---|
| AgentCore invocation failure | Post error message to Slack thread |
| SSE parse error | Skip malformed line, continue processing |
| Snippet upload failure | Throw (caught by outer try/catch → error posted to Slack) |
| SQS message processing failure | Retry via SQS visibility timeout, then DLQ after 2 failures |

---

## 9. Token Optimization

| Technique | Implementation | Impact |
|---|---|---|
| Prompt Caching | `BedrockModel({ cacheConfig: { strategy: 'auto' } })` | Cache System Prompt + tool definitions. ~90% cost reduction on cached tokens. |
| SlidingWindow | `windowSize: 10, shouldTruncateResults: true` | Limit context size. Truncate old tool results before removing messages. |
| Progressive Disclosure | Skills Plugin loads full instructions only on activation | Avoid loading investigation instructions for every conversation turn. |
| Max Tokens | `maxTokens: 4096` | Cap output token generation. |
| Concise Prompt | System Prompt constrains verbosity (`MUST 簡潔に回答`) | Reduce output tokens on conversational turns. |
