import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const agentCore = new BedrockAgentCoreClient();
const ssm = new SSMClient();

const RUNTIME_ARN = process.env.RUNTIME_ARN!;
const SSM_BOT_TOKEN = process.env.SSM_BOT_TOKEN!;
const SNIPPET_THRESHOLD = 1500;

let botTokenCache: string | undefined;

export async function getBotToken(): Promise<string> {
  if (botTokenCache) return botTokenCache;
  const result = await ssm.send(
    new GetParameterCommand({ Name: SSM_BOT_TOKEN, WithDecryption: true })
  );
  botTokenCache = result.Parameter!.Value!;
  return botTokenCache;
}

export async function postToSlack(
  botToken: string,
  channel: string,
  threadTs: string,
  text: string,
): Promise<string> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text, mrkdwn: true }),
  });
  const data = await res.json() as { ok: boolean; ts?: string };
  return data.ts ?? threadTs;
}

export async function uploadSnippet(
  botToken: string,
  channel: string,
  threadTs: string,
  content: string,
  filename: string,
  comment: string,
): Promise<void> {
  const contentBytes = new TextEncoder().encode(content);

  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      filename,
      length: String(contentBytes.byteLength),
      snippet_type: 'markdown',
    }),
  });
  const urlData = await urlRes.json() as { ok: boolean; upload_url: string; file_id: string; error?: string };
  if (!urlData.ok) throw new Error(`getUploadURL failed: ${urlData.error}`);

  await fetch(urlData.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: contentBytes,
  });

  await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      files: [{ id: urlData.file_id, title: filename }],
      channel_id: channel,
      thread_ts: threadTs,
      initial_comment: comment,
    }),
  });
}

/** AgentCore を SSE で呼び出し、イベントごとに Slack へ投稿 */
export async function invokeAndStream(
  botToken: string,
  channel: string,
  threadTs: string,
  prompt: string,
  sessionId: string,
): Promise<void> {
  const response = await agentCore.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: sessionId,
    qualifier: 'DEFAULT',
    payload: new TextEncoder().encode(prompt),
  }));

  const stream = response.response! as AsyncIterable<Uint8Array>;
  let buffer = '';

  for await (const chunk of stream) {
    buffer += new TextDecoder().decode(chunk);

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        switch (data.event) {
          case 'tool_start':
            await postToSlack(botToken, channel, threadTs, `${data.label} を検索中...`);
            break;
          case 'tool_end':
            if (data.error) {
              await postToSlack(botToken, channel, threadTs, `${data.label} (エラー: ${data.error})`);
            }
            break;
          case 'result': {
            const content: string = data.content ?? '';
            if (content.length > SNIPPET_THRESHOLD) {
              await uploadSnippet(botToken, channel, threadTs, content, 'report.md', '');
            } else {
              await postToSlack(botToken, channel, threadTs, content);
            }
            break;
          }
          case 'error':
            await postToSlack(botToken, channel, threadTs, `エラーが発生しました: ${data.message}`);
            break;
        }
      } catch { /* skip malformed lines */ }
    }
  }
}
