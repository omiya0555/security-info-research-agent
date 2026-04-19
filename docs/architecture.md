# Architecture

## System Overview

```
                                ┌─────────────────────────────┐
                                │  External Data Sources       │
                                │                             │
                                │  - NVD API v2.0             │
                                │  - Shodan CVEDB             │
                                │  - AWS Security Bulletins   │
                                │  - Tavily (Web Search)      │
                                └──────────┬──────────────────┘
                                           │
┌──────────────────────────────────────────│──────────────────────────────────────────┐
│  AWS Account (ap-northeast-1)            │                                          │
│                                          ▼                                          │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Amazon Bedrock AgentCore Runtime (ARM64 Container)                          │   │
│  │                                                                              │   │
│  │  Express HTTP Server (port 8080)                                             │   │
│  │  ├── GET  /ping           Health check                                       │   │
│  │  └── POST /invocations    SSE streaming response                             │   │
│  │                                                                              │   │
│  │  Strands Agent (@strands-agents/sdk)                                         │   │
│  │  ├── Model: Amazon Bedrock (Claude Sonnet 4.6 via inference-profile)         │   │
│  │  ├── Tools: nvd_lookup, shodan_cve, aws_bulletin, Tavily MCP (stdio)         │   │
│  │  ├── Skills: security-investigation, analysis-template                       │   │
│  │  ├── Plugin: Skills Plugin (Progressive Disclosure)                          │   │
│  │  ├── ConversationManager: SlidingWindow (per-session in-memory)              │   │
│  │  └── Prompt Caching: auto strategy                                           │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│       ▲                                                                             │
│       │ InvokeAgentRuntime (SSE)                                                    │
│       │                                                                             │
│  ┌────┴─────────────────────────────────────────────────────────────────────────┐   │
│  │  Slack Integration Layer                                                      │   │
│  │                                                                               │   │
│  │  [Pull: Slack Mention]                                                        │   │
│  │  Slack ──HTTPS──▶ API Gateway (HTTP API)                                      │   │
│  │                      └──▶ Receiver Lambda (10s)                               │   │
│  │                             ├── Slack signature verification                  │   │
│  │                             ├── Retry filter (x-slack-retry-num)              │   │
│  │                             ├── Bot message exclusion                         │   │
│  │                             └──▶ SQS FIFO Queue                              │   │
│  │                                    ├── MessageGroupId: {channel}-{thread}     │   │
│  │                                    ├── MessageDeduplicationId                 │   │
│  │                                    └── DLQ (14 day retention)                 │   │
│  │                                         │                                     │   │
│  │                                         ▼                                     │   │
│  │                                  Worker Lambda (900s)                          │   │
│  │                                    ├── Post "リクエストを受け付けました"         │   │
│  │                                    ├── InvokeAgentRuntime (SSE stream)         │   │
│  │                                    ├── tool_start → Slack post                │   │
│  │                                    ├── tool_end   → Slack post (on error)     │   │
│  │                                    ├── result     → Slack post or snippet     │   │
│  │                                    └── thread_ts → sessionId mapping          │   │
│  │                                                                               │   │
│  │  [Push: Security Hub Finding] (optional, disabled by default)                 │   │
│  │  Security Hub ──▶ EventBridge Rule                                            │   │
│  │                      └──▶ Push Worker Lambda (900s)                           │   │
│  │                             ├── Finding → prompt conversion                   │   │
│  │                             ├── InvokeAgentRuntime (SSE stream)               │   │
│  │                             └── Slack channel notification                    │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │  Supporting Services                                                          │   │
│  │                                                                               │   │
│  │  SSM Parameter Store (SecureString)                                           │   │
│  │  ├── /security-agent/tavily-api-key                                           │   │
│  │  ├── /security-agent/nvd-api-key                                              │   │
│  │  ├── /security-agent/slack-bot-token                                          │   │
│  │  └── /security-agent/slack-signing-secret                                     │   │
│  │                                                                               │   │
│  │  AgentCore Gateway (Target 未追加 - Phase 4 で拡張予定)                        │   │
│  │  Cognito UserPool (Gateway 自動生成)                                           │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### AgentCore Runtime

AgentCore Runtime は Docker コンテナ（ARM64）として動作する。Strands Agents SDK で構築された Agent を Express HTTP サーバーとしてホストする。

#### HTTP Protocol Contract

AgentCore Runtime は以下の HTTP エンドポイントを実装する:

| Endpoint | Method | Purpose |
|---|---|---|
| `/ping` | GET | Health check. `{"status": "Healthy", "time_of_last_update": <unix_ts>}` を返す |
| `/invocations` | POST | Agent 呼出し。SSE (`text/event-stream`) でストリーミングレスポンスを返す |

#### SSE Event Format

`/invocations` は以下の SSE イベントを送出する:

```
data: {"event":"tool_start","tool":"nvd_lookup","label":"NVD API"}
data: {"event":"tool_end","tool":"nvd_lookup","label":"NVD API","error":null}
data: {"event":"result","format":"message","content":"CVE-2024-6387 の概要です。..."}
```

| Event | Fields | Description |
|---|---|---|
| `tool_start` | `tool`, `label` | ツール実行開始。`label` は日本語表示名 |
| `tool_end` | `tool`, `label`, `error` | ツール実行完了。`error` はエラー時のみ |
| `result` | `format`, `content` | 最終結果。`format` は `"message"` (通常) or `"report"` (スキル発動時) |
| `error` | `message` | エラー |

`format` フィールドは server.ts が `activate_skill` ツールの発動を追跡し、スキルが発動した場合に `"report"` を設定する。Worker Lambda はこの値を使ってスニペット化の判断を行う。

#### Session Management

server.ts は in-memory の `Map<sessionId, Message[]>` でセッション別の会話履歴を保持する。

- Session ID は `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` ヘッダーから取得
- Slack Worker は `slack-thread-{channel}-{threadTs}` を Session ID として使用し、同一スレッド内の会話を継続
- セッションは `SESSION_TTL_MS` (デフォルト 30 分) の TTL で自動削除
- 5 分ごとにクリーンアップが実行される

#### Container Specification

| Item | Value |
|---|---|
| Platform | ARM64 (Graviton) |
| Host | 0.0.0.0 |
| Port | 8080 |
| Base Image | Node.js 24 |
| Build | `npm install` + `tsc` + Skills ファイルコピー |

### Strands Agent

#### Model Configuration

| Parameter | Value | Source |
|---|---|---|
| Model | Claude Sonnet 4.6 | Bedrock inference-profile |
| Max Tokens | 4096 | `MAX_TOKENS` env var |
| Cache Strategy | `auto` | `CACHE_STRATEGY` env var |

Prompt Caching (`auto` strategy) は System Prompt とツール定義を自動キャッシュし、2 回目以降の呼出しでキャッシュ読み取りコストを削減する。

#### Conversation Manager

`SlidingWindowConversationManager` を使用:

| Parameter | Value | Source |
|---|---|---|
| Window Size | 10 messages | `WINDOW_SIZE` env var |
| Truncate Results | true | `TRUNCATE_RESULTS` env var |

コンテキストウィンドウが溢れそうな場合:
1. まず古いツール結果を先頭 200 文字 + 末尾 200 文字に切り詰め
2. それでも不足なら最も古いメッセージを削除（ツール use/result ペアを保持）

#### System Prompt Structure

XML タグ + RFC 2119 キーワードで構造化（[Anthropic 公式推奨](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/use-xml-tags)）:

```xml
<role>       -- 役割定義 + 現在日付
<instructions> -- 対話方針 + スキル使用ルール
<output_format> -- Slack mrkdwn 記法ルール + 引用元 URL 形式
<constraints>  -- 言語、簡潔性、絵文字禁止、推測禁止
```

起動時に Skills Plugin が `<available_skills>` セクションを自動追加。

#### Skills Plugin (Progressive Disclosure)

トークン効率のため、スキルの指示は遅延ロードされる:

1. **起動時**: スキル名と description のみ System Prompt に注入（軽量）
2. **発動時**: LLM が `activate_skill` ツールを呼び出し、フル指示をコンテキストにロード

```
System Prompt (起動時):
  <available_skills>
  - security-investigation: 詳細調査スキル。明示的に依頼された場合にのみ使用。
  - analysis-template: 読み解きテンプレート。
  </available_skills>

LLM が activate_skill("security-investigation") を呼出し:
  → SKILL.md のフル指示がツール結果としてコンテキストに追加
  → LLM はその指示に従って回答を生成
```

### Slack Integration

#### Slack 3 秒制約への対応

Slack はイベント受信後 3 秒以内にレスポンスしないとリトライする。Agent の調査は 1 分以上かかるため、同期応答は不可能。

| Pattern | Adopted | Reason |
|---|---|---|
| Bolt lazy listener | No | Python 限定。JS 未対応を公式明言。2 回 cold start + ap-northeast-1 → US RTT リスク |
| Receiver + Worker direct | No | 重複排除・リトライ処理が手動。DLQ なし |
| **Receiver + Worker + SQS FIFO** | **Yes** | AWS 公式リファレンスアーキテクチャ。重複排除・DLQ・順序保証が組み込み |
| Socket Mode (ECS) | No | 常駐コストが発生。社内ツール用途ではオーバースペック |

#### Receiver Lambda

- Runtime: Node.js 24 (ARM64)
- Timeout: 10 seconds
- Responsibilities:
  1. Slack 署名検証 (HMAC-SHA256 with Signing Secret)
  2. `x-slack-retry-num` ヘッダーでリトライをスキップ
  3. URL Verification Challenge に応答
  4. Bot 自身のメッセージを除外（ループ防止）
  5. SQS FIFO にメッセージ送信
  6. HTTP 200 を即座に返却

#### SQS FIFO Queue

| Parameter | Value |
|---|---|
| FIFO | Yes |
| Content-Based Deduplication | No (MessageDeduplicationId を明示指定) |
| MessageGroupId | `{channel_id}-{thread_ts}` (スレッド単位の順序保証) |
| MessageDeduplicationId | `{channel_id}-{event_ts}` (Slack リトライの重複排除) |
| Visibility Timeout | 900 seconds (Worker Lambda タイムアウトに一致) |
| DLQ | Max Receive Count: 2, Retention: 14 days |

#### Worker Lambda

- Runtime: Node.js 24 (ARM64)
- Timeout: 900 seconds (15 minutes)
- Memory: 256 MB
- SQS Event Source: batchSize 1

Processing flow:
1. SQS メッセージから `channel`, `threadTs`, `text` を取得
2. メンションテキストから Bot ID を除去してプロンプトを抽出
3. `chat.postMessage` で「リクエストを受け付けました」を投稿
4. `InvokeAgentRuntime` を SSE モードで呼出し
5. SSE イベントを逐次パース:
   - `tool_start` → `chat.postMessage` で「{label} を検索中...」を投稿
   - `tool_end` + error → `chat.postMessage` でエラー投稿
   - `result` (1000 文字以下) → `chat.postMessage` で投稿
   - `result` (1000 文字超) → `files.uploadV2` (3-step) でスニペット添付
6. エラー時はエラーメッセージを Slack に投稿

#### Slack File Upload (3-step flow)

1000 文字を超えるレスポンスは Slack のファイルアップロード API で `.md` スニペットとして添付する:

1. `files.getUploadURLExternal` — pre-signed URL を取得
2. Upload — pre-signed URL にコンテンツを POST
3. `files.completeUploadExternal` — アップロードを完了し、スレッドに共有

Required scope: `files:write`

#### Push Worker Lambda (EventBridge)

Security Hub Finding をトリガーに自動調査を実行する（デフォルト無効）:

1. EventBridge Rule が `aws.securityhub` の `Security Hub Findings - Imported` イベントをキャプチャ
2. フィルタ: `RecordState: ACTIVE`, `Workflow.Status: NEW`
3. Push Worker Lambda が Finding JSON からプロンプトを生成
4. AgentCore Runtime に SSE で調査を依頼
5. 結果を指定 Slack チャンネルに投稿（新規スレッド作成）

Enable/disable は CDK context で制御:
```bash
npx cdk deploy -c enableSecurityHubPush=true -c slackChannel=C0123ABCDEF
```

### CDK Stack

全リソースは単一の `SecurityAgentStack` で管理される。

#### Resource Inventory

| Resource | Type | Key Configuration |
|---|---|---|
| AgentRuntime | BedrockAgentCore::Runtime | ARM64 Docker container, HTTP protocol |
| AgentGateway | BedrockAgentCore::Gateway | Target 未追加 (Phase 4) |
| Cognito UserPool | Cognito | Gateway 自動生成 |
| SlackQueue | SQS FIFO | Visibility 900s, DLQ attached |
| SlackDlq | SQS FIFO | Retention 14 days |
| SlackReceiver | Lambda (NodejsFunction) | Node.js 24, 10s timeout |
| SlackWorker | Lambda (NodejsFunction) | Node.js 24, 900s timeout, 256MB |
| PushWorker | Lambda (NodejsFunction) | Node.js 24, 900s timeout, 256MB |
| SlackApi | API Gateway HTTP API | POST /slack/events |
| SecurityHubRule | EventBridge Rule | Disabled by default |

#### IAM Policies

| Principal | Actions | Resources |
|---|---|---|
| AgentCore Runtime Role | `ssm:GetParameter` | `/security-agent/*` |
| AgentCore Runtime Role | `kms:Decrypt` | `*` |
| AgentCore Runtime Role | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` | `foundation-model/*`, `inference-profile/*` |
| Receiver Lambda | `sqs:SendMessage` | SlackQueue |
| Receiver Lambda | `ssm:GetParameter` | `/security-agent/slack-signing-secret` |
| Worker Lambda | `bedrock-agentcore:InvokeAgentRuntime` | Runtime ARN + `/*` |
| Worker Lambda | `ssm:GetParameter` | `/security-agent/slack-bot-token` |
| Push Worker Lambda | `bedrock-agentcore:InvokeAgentRuntime` | Runtime ARN + `/*` |
| Push Worker Lambda | `ssm:GetParameter` | `/security-agent/slack-bot-token` |

### Secrets Management

全シークレットは SSM Parameter Store (SecureString) で管理:

| Parameter | Usage | Consumer |
|---|---|---|
| `/security-agent/tavily-api-key` | Tavily MCP Server 認証 | AgentCore Runtime |
| `/security-agent/nvd-api-key` | NVD API レート制限緩和 | AgentCore Runtime |
| `/security-agent/slack-bot-token` | Slack API 認証 (`xoxb-...`) | Worker Lambda, Push Worker |
| `/security-agent/slack-signing-secret` | Slack 署名検証 | Receiver Lambda |

AgentCore Runtime は環境変数経由で SSM パラメータ名を受け取り、起動時に `resolveEnv()` で値を取得する。Lambda は起動時に SSM から取得し、Lambda コンテナのライフタイム内でキャッシュする。

## Data Flow

### Pull Flow (Slack Mention)

```
1. User: @security-agent CVE-2024-6387
2. Slack → API Gateway → Receiver Lambda
3. Receiver: signature verify → SQS FIFO enqueue → HTTP 200
4. SQS → Worker Lambda
5. Worker → Slack: "リクエストを受け付けました"
6. Worker → AgentCore Runtime: InvokeAgentRuntime (SSE)
7. Runtime: agent.stream("CVE-2024-6387")
8. Agent → Shodan CVEDB API (tool call)
   Runtime → Worker: SSE tool_start
   Worker → Slack: "Shodan CVEDB を検索中..."
9. Agent → NVD API (tool call)
   Runtime → Worker: SSE tool_start
   Worker → Slack: "NVD API を検索中..."
10. Agent generates response
    Runtime → Worker: SSE result (format: "message")
    Worker → Slack: response text (or snippet if > 1000 chars)
11. Runtime: save session messages to in-memory map
```

### Push Flow (Security Hub Finding)

```
1. Inspector detects vulnerability → Security Hub Finding (NEW + ACTIVE)
2. EventBridge Rule matches → Push Worker Lambda
3. Push Worker: extract title, severity, CVE IDs from Finding
4. Push Worker → Slack: "[CRITICAL] Security Hub Finding 検出" (new thread)
5. Push Worker → AgentCore Runtime: InvokeAgentRuntime (SSE)
6. (Same SSE processing as Pull flow)
7. Push Worker → Slack: investigation report in thread
```

## Network Architecture

```
Internet
    │
    ├── Slack API (outbound from Worker Lambda)
    ├── NVD API (outbound from AgentCore Runtime)
    ├── Shodan CVEDB (outbound from AgentCore Runtime)
    ├── Tavily API (outbound from AgentCore Runtime via MCP stdio)
    └── AWS Security Bulletins RSS (outbound from AgentCore Runtime)

AWS (ap-northeast-1)
    │
    ├── API Gateway (inbound from Slack)
    ├── AgentCore Runtime (PUBLIC network mode)
    ├── Lambda x3 (VPC-less, internet access via AWS managed NAT)
    ├── SQS FIFO (internal)
    ├── SSM Parameter Store (internal)
    └── EventBridge (internal)
```

All outbound traffic from AgentCore Runtime uses PUBLIC network mode. Lambda functions are not VPC-attached.
