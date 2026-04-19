import { EventBridgeHandler } from 'aws-lambda';
import { getBotToken, postToSlack, invokeAndStream } from './shared.js';

const SLACK_CHANNEL = process.env.SLACK_CHANNEL!;

interface SecurityHubFinding {
  Title: string;
  Description: string;
  Severity: { Label: string };
  Vulnerabilities?: Array<{ Id: string }>;
  Resources?: Array<{ Type: string; Id: string }>;
  ProductArn: string;
}

interface SecurityHubDetail {
  findings: SecurityHubFinding[];
}

export const handler: EventBridgeHandler<'Security Hub Findings - Imported', SecurityHubDetail, void> = async (event) => {
  const botToken = await getBotToken();

  for (const finding of event.detail.findings) {
    const severity = finding.Severity.Label;
    const title = finding.Title;
    const cveIds = finding.Vulnerabilities?.map(v => v.Id).join(', ') || 'なし';
    const resources = finding.Resources?.map(r => `${r.Type}: ${r.Id}`).join('\n') || 'なし';

    // Slack に通知スレッドを作成
    const threadTs = await postToSlack(
      botToken, SLACK_CHANNEL, '',
      `*[${severity}] Security Hub Finding 検出*\n${title}`,
    );

    const prompt = `以下の Security Hub Finding を調査して対応方針をまとめて。

タイトル: ${title}
重要度: ${severity}
CVE: ${cveIds}
対象リソース: ${resources}
説明: ${finding.Description}`;

    try {
      await invokeAndStream(
        botToken, SLACK_CHANNEL, threadTs, prompt,
        `push-${SLACK_CHANNEL}-${threadTs}-${Date.now()}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await postToSlack(botToken, SLACK_CHANNEL, threadTs, `調査中にエラーが発生しました: ${message}`);
    }
  }
};
