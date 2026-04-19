import z from 'zod'

export const ShodanCveInputSchema = z.object({
  cveId: z.string().regex(/^CVE-\d{4}-\d{4,}$/).optional()
    .describe('特定の CVE ID (例: CVE-2021-44228)'),
  product: z.string().optional()
    .describe('製品名で検索 (例: nginx, apache)'),
  isKev: z.boolean().optional().default(false)
    .describe('KEV (既知の悪用された脆弱性) のみ'),
  sortByEpss: z.boolean().optional().default(false)
    .describe('EPSS スコア順でソート'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('公開日の開始 (YYYY-MM-DD)'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('公開日の終了 (YYYY-MM-DD)'),
  limit: z.number().min(1).max(100).optional().default(20)
    .describe('取得件数'),
});