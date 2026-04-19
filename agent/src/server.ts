import express from 'express';
import { createAgent } from './agent.js';
import type { Message } from '@strands-agents/sdk';

const PORT = process.env.PORT || 8080;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 30 * 60 * 1000; // 30 分

// セッション別メッセージ履歴（in-memory）
const sessions = new Map<string, { messages: Message[]; lastAccess: number }>();

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}
setInterval(cleanupSessions, 5 * 60 * 1000);

const agent = await createAgent();

const app = express();

app.get('/ping', (_, res) =>
  res.json({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  })
);

app.post('/invocations', express.raw({ type: '*/*' }), async (req, res) => {
  const prompt = new TextDecoder().decode(req.body);
  const sessionId = req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as string | undefined;

  // セッション復元
  if (sessionId && sessions.has(sessionId)) {
    agent.messages = [...sessions.get(sessionId)!.messages];
  } else {
    agent.messages = [];
  }

  // SSE ストリーミング
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const TOOL_LABELS: Record<string, string> = {
    nvd_lookup: 'NVD API',
    shodan_cve: 'Shodan CVEDB',
    aws_bulletin: 'AWS Security Bulletins',
    tavily_search: 'Web 検索',
    tavily_extract: 'Web ページ取得',
  };

  const send = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let skillActivated = false;

  try {
    for await (const event of agent.stream(prompt)) {
      switch (event.type) {
        case 'beforeToolCallEvent':
          if (event.toolUse.name === 'activate_skill') {
            skillActivated = true;
          }
          send({
            event: 'tool_start',
            tool: event.toolUse.name,
            label: TOOL_LABELS[event.toolUse.name] ?? event.toolUse.name,
          });
          break;

        case 'afterToolCallEvent':
          send({
            event: 'tool_end',
            tool: event.toolUse.name,
            label: TOOL_LABELS[event.toolUse.name] ?? event.toolUse.name,
            error: event.error?.message,
          });
          break;

        case 'agentResultEvent':
          send({
            event: 'result',
            format: skillActivated ? 'report' : 'message',
            content: event.result.lastMessage?.content
              ?.filter((c) => c.type === 'textBlock')
              .map((c) => (c as { text: string }).text)
              .join('\n'),
          });
          break;
      }
    }

    // セッション保存
    if (sessionId) {
      sessions.set(sessionId, {
        messages: [...agent.messages],
        lastAccess: Date.now(),
      });
    }
  } catch (err) {
    send({ event: 'error', message: err instanceof Error ? err.message : 'Internal server error' });
  }

  res.end();
});

app.listen(PORT, () => {
  console.log(`Agent listening on 0.0.0.0:${PORT}`);
});
