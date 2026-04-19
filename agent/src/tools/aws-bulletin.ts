import { tool } from '@strands-agents/sdk';
import { AwsBulletinInputSchema } from '../schemas/aws-bulletin.js';

const RSS_URL = 'https://aws.amazon.com/security/security-bulletins/rss/feed/';

interface BulletinItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

function parseRssItems(xml: string): BulletinItem[] {
  const items: BulletinItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? '';
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? '';
    const description = block.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() ?? '';
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? '';

    items.push({ title, link, description, pubDate });
  }

  return items;
}

export const awsBulletin = tool({
  name: 'aws_bulletin',
  description:
    'AWS Security Bulletins（AWS 公式セキュリティ勧告）を RSS フィードから取得する。' +
    'AWS サービス固有の脆弱性情報、CVE 対応状況、影響を受けるバージョンを含む。' +
    'キーワード指定で特定サービスや CVE ID に絞り込み可能。' +
    '詳細が必要な場合は、返却される link を tavily_extract で取得すること。',
  inputSchema: AwsBulletinInputSchema,

  callback: async (input) => {
    const res = await fetch(RSS_URL);
    if (!res.ok) return `Error: ${res.status} ${res.statusText}`;

    const xml = await res.text();
    let items = parseRssItems(xml);

    if (input.keyword) {
      const kw = input.keyword.toLowerCase();
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(kw) ||
          item.description.toLowerCase().includes(kw),
      );
    }

    return JSON.stringify({
      totalResults: items.length,
      items,
      _sourceUrl: RSS_URL,
    });
  },
});
