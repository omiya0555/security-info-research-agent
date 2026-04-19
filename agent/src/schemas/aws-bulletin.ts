import { z } from 'zod';

export const AwsBulletinInputSchema = z.object({
  keyword: z.string().optional()
    .describe('検索キーワード（サービス名、CVE ID 等。例: ECS, Lambda, CVE-2024-12345）'),
});
