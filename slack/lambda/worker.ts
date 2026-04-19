import { SQSHandler } from 'aws-lambda';
import { getBotToken, postToSlack, invokeAndStream } from './shared.js';

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const { channel, threadTs, text } = JSON.parse(record.body);
    const botToken = await getBotToken();

    const prompt = text.replace(/<@[A-Z0-9]+>/g, '').trim() || 'hello';

    await postToSlack(botToken, channel, threadTs, 'リクエストを受け付けました');

    try {
      await invokeAndStream(
        botToken, channel, threadTs, prompt,
        `slack-thread-${channel}-${threadTs}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await postToSlack(botToken, channel, threadTs, `調査中にエラーが発生しました: ${message}`);
    }
  }
};
