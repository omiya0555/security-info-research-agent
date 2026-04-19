import { z } from 'zod';

export const NvdLookupInputSchema = z.object({
  cveId: z.string().regex(/^CVE-\d{4}-\d{4,}$/).optional()
    .describe('特定の CVE ID (例: CVE-2021-44228)'),
  keywordSearch: z.string().optional()
    .describe('キーワード検索 (例: log4j, Apache)'),
  cvssV3Severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional()
    .describe('CVSS v3.1 の重要度フィルタ'),
  pubStartDate: z.string().optional()
    .describe('公開日の開始 (ISO 8601, 例: 2024-01-01T00:00:00.000)'),
  pubEndDate: z.string().optional()
    .describe('公開日の終了 (ISO 8601)'),
  hasKev: z.boolean().optional()
    .describe('CISA KEV カタログに含まれる CVE のみ'),
  resultsPerPage: z.number().min(1).max(100).optional().default(20)
    .describe('取得件数'),
});