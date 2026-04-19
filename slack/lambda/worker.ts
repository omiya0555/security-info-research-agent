import { SQSHandler } from 'aws-lambda';
import { getBotToken, postToSlack, invokeAndStream } from './shared.js';

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const { channel, threadTs, text, user, teamId } = JSON.parse(record.body);
    const botToken = await getBotToken();

    const prompt = text.replace(/<@[A-Z0-9]+>/g, '').trim() || 'hello';

    try {
      await invokeAndStream(
        botToken, channel, threadTs, prompt,
        `slack-thread-${channel}-${threadTs}`,
        { userId: user, teamId },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await postToSlack(botToken, channel, threadTs, `調査中にエラーが発生しました: ${message}`);
    }
  }
};
