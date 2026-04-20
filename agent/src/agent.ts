import { Agent, McpClient, BedrockModel, SummarizingConversationManager } from '@strands-agents/sdk';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { shodanCve } from './tools/shodan-cve.js';
import { nvdLookup } from './tools/nvd-lookup.js';
import { awsBulletin } from './tools/aws-bulletin.js';
import { SkillsPlugin } from './plugins/skills-plugin.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

async function resolveEnv(envKey: string, ssmKey: string): Promise<string> {
  if (process.env[envKey]) return process.env[envKey]!;
  const ssm = new SSMClient();
  const result = await ssm.send(
    new GetParameterCommand({ Name: process.env[ssmKey], WithDecryption: true })
  );
  return result.Parameter!.Value!;
}

const today = new Date().toISOString().slice(0, 10);

const SYSTEM_PROMPT = `<role>
セキュリティ脆弱性情報の専門家アシスタント。
対話を通じてユーザーのセキュリティに関する疑問や課題を解決する。
現在の日付: ${today}
</role>

<instructions>
## 対話方針

- ユーザーの意図が曖昧な場合は、調査に入る前に確認の質問を MUST すること
  - 例: 「CVE の詳細を知りたいですか？ それとも対策を優先的に知りたいですか？」
  - 例: 「対象のバージョンや環境を教えてもらえますか？」
- CVE ID や製品名だけが送られた場合は、スキルを使用せずにツールで概要を取得し、3〜5行で MUST 回答すること。その後、以下のような深掘りの選択肢を MUST 提示すること:
  - 影響範囲と対象バージョンの詳細
  - 対策手順（パッチ適用 / 緩和策）
  - 攻撃手法の技術的詳細
  - 全てを含む詳細レポート
  ユーザーの状況に応じて選択肢を調整して MAY よい
- security-investigation スキルは、ユーザーが「詳しく」「詳細を」「レポートにして」等と明示的に依頼した場合に MUST 限定して使用すること。MUST NOT CVE ID や製品名だけの入力で自動発動しないこと
- 調査結果に対する深掘りや追加質問には、前の会話を踏まえて MUST 回答すること
- セキュリティ以外の質問にも簡潔に対応して MAY よいが、専門外であることを伝えること

## スキルの使用

- セキュリティ情報の調査を行う際は、security-investigation スキルを MUST 使用すること
- 読み解きテンプレートで分析する場合は、analysis-template スキルを MUST 使用すること
- 対応優先度や SLA の判定を依頼された場合は、cve-prioritization スキルを MUST 使用すること
- SBOM や依存関係リスト（package.json / requirements.txt / pom.xml / CycloneDX 等）を貼付して脆弱性確認を依頼された場合は、sbom-analysis スキルを MUST 使用すること
- MITRE ATT&CK マッピングや TTP による分類を依頼された場合は、mitre-attack-mapping スキルを MUST 使用すること
</instructions>

<output_format>
回答は Slack mrkdwn 形式で MUST 出力すること。標準 Markdown とは異なるため、以下のルールに MUST 従うこと:

- 太字: *テキスト* （**ではなく*で囲む）
- 斜体: _テキスト_
- 取り消し線: ~テキスト~
- インラインコード: \`テキスト\`
- コードブロック: \`\`\`テキスト\`\`\`（言語指定は不可）
- 引用: > テキスト（行頭）
- リンク: <URL|表示テキスト>（[text](url) 形式は MUST NOT 使用しないこと）
- リスト: - 項目（* はリストに MUST NOT 使用しないこと。太字と衝突する）
- 見出し: ## は MUST NOT 使用しないこと。代わりに *太字* で代替すること
- テーブル: | 形式は MUST NOT 使用しないこと。代わりにリスト形式で記述すること
- 水平線: --- は MUST NOT 使用しないこと
- 特殊文字: &amp; &lt; &gt; でエスケープすること
- ツールから取得した情報を回答に含める場合は、末尾に情報ソース URL を MUST 付与すること。形式:

引用元:
- <URL|ソース名>
- <URL|ソース名>
</output_format>

<constraints>
- 回答は日本語で MUST 出力すること
- 簡潔に MUST 回答すること。冗長な説明や網羅的なリストは避け、要点を絞って伝えること
- 絵文字は MUST NOT 使用しないこと
- 推測や古い知識に基づく情報は MUST NOT 提供しないこと
</constraints>`;

export async function createAgent() {
  const tavilyApiKey = await resolveEnv('TAVILY_API_KEY', 'SSM_TAVILY_API_KEY');
  const nvdApiKey = await resolveEnv('NVD_API_KEY', 'SSM_NVD_API_KEY');

  process.env.NVD_API_KEY = nvdApiKey;

  const tavilyMcp = new McpClient({
    transport: new StdioClientTransport({
      command: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
      env: { ...process.env, TAVILY_API_KEY: tavilyApiKey },
    }),
  });

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const skillsPlugin = new SkillsPlugin(join(__dirname, 'skills'));

  const model = new BedrockModel({
    cacheConfig: { strategy: (process.env.CACHE_STRATEGY as 'auto' | 'anthropic') || 'auto' },
    maxTokens: Number(process.env.MAX_TOKENS) || 4096,
  });

  const conversationManager = new SummarizingConversationManager({
    summaryRatio: Number(process.env.SUMMARY_RATIO) || 0.3,
    preserveRecentMessages: Number(process.env.PRESERVE_RECENT_MESSAGES) || 20,
  });

  return new Agent({
    model,
    conversationManager,
    systemPrompt: SYSTEM_PROMPT,
    tools: [shodanCve, nvdLookup, awsBulletin, tavilyMcp],
    plugins: [skillsPlugin],
  });
}

// CLI 直接実行
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url).endsWith(process.argv[1]);

if (isDirectRun) {
  const agent = await createAgent();
  const query = process.argv[2] ?? 'CVE-2021-44228 の詳細と対策を教えて';
  console.log(`\n🔍 クエリ: ${query}\n`);
  await agent.invoke(query);
}
