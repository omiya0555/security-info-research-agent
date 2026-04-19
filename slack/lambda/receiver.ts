import { createHmac, timingSafeEqual } from 'crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const sqs = new SQSClient();
const ssm = new SSMClient();

const QUEUE_URL = process.env.QUEUE_URL!;
const SSM_SIGNING_SECRET = process.env.SSM_SIGNING_SECRET!;

let signingSecretCache: string | undefined;

async function getSigningSecret(): Promise<string> {
  if (signingSecretCache) return signingSecretCache;
  const result = await ssm.send(
    new GetParameterCommand({ Name: SSM_SIGNING_SECRET, WithDecryption: true })
  );
  signingSecretCache = result.Parameter!.Value!;
  return signingSecretCache;
}

function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string,
): boolean {
  const baseString = `v0:${timestamp}:${body}`;
  const hash = `v0=${createHmac('sha256', signingSecret).update(baseString).digest('hex')}`;
  return timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
}

export async function handler(event: {
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString()
    : event.body;

  // Slack リトライはスキップ
  if (event.headers['x-slack-retry-num']) {
    return { statusCode: 200, body: 'ok (retry skipped)' };
  }

  // 署名検証
  const signingSecret = await getSigningSecret();
  const signature = event.headers['x-slack-signature'] ?? '';
  const timestamp = event.headers['x-slack-request-timestamp'] ?? '';

  if (!verifySlackSignature(signingSecret, signature, timestamp, body)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const payload = JSON.parse(body);

  // URL Verification Challenge
  if (payload.type === 'url_verification') {
    return { statusCode: 200, body: payload.challenge };
  }

  // イベントコールバック
  if (payload.type === 'event_callback') {
    const slackEvent = payload.event;

    // Bot 自身のメッセージは無視（ループ防止）
    if (slackEvent.bot_id) {
      return { statusCode: 200, body: 'ok (bot message ignored)' };
    }

    // SQS FIFO に送信
    const threadTs = slackEvent.thread_ts ?? slackEvent.ts;
    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({
        channel: slackEvent.channel,
        threadTs,
        text: slackEvent.text,
        user: slackEvent.user,
        teamId: payload.team_id,
        eventTs: slackEvent.event_ts,
      }),
      MessageGroupId: `${slackEvent.channel}-${threadTs}`,
      MessageDeduplicationId: `${slackEvent.channel}-${slackEvent.event_ts}`,
    }));
  }

  return { statusCode: 200, body: 'ok' };
}
