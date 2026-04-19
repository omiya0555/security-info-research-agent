import { tool } from '@strands-agents/sdk'
import { ShodanCveInputSchema } from '../schemas/shodan.js';

const SHODAN_BASE_URL = 'https://cvedb.shodan.io';
const DEFAULT_RESULTS_PER_PAGE = 20;

export const shodanCve = tool({
    name: 'shodan_cve',
    description:
        'Shodan CVEDB から CVE 情報を検索する。EPSS（悪用確率）や KEV（実攻撃の有無）を含む。' +
        'CVE ID 指定の詳細検索と、製品名・日付範囲での一覧検索の両方に対応。',
    inputSchema: ShodanCveInputSchema,

    callback: async (input) => {
        // cveIdが指定されていれば単体検索、なければ一覧検索
        if (input.cveId) {
            const url = `${SHODAN_BASE_URL}/cve/${input.cveId}`;
            const response = await fetch(url);
            if (!response.ok) return `Error: ${response.status} ${response.statusText}`;
            const data = await response.json();
            return JSON.stringify({ ...data, _sourceUrl: url });
        }

        // 一覧検索: クエリパラメータを組み立て
        const params = new URLSearchParams();
        if (input.product) params.set('product', input.product);
        if (input.isKev) params.set('is_kev', 'true');
        if (input.sortByEpss) params.set('sort_by_epss', 'true');
        if (input.startDate) params.set('start_date', input.startDate);
        if (input.endDate) params.set('end_date', input.endDate);
        params.set('limit', String(input.limit ?? DEFAULT_RESULTS_PER_PAGE));

        const url = `${SHODAN_BASE_URL}/cves?${params}`;
        const res = await fetch(url);
        if (!res.ok) return `Error: ${res.status} ${res.statusText}`;
        const data = await res.json();
        return JSON.stringify({ ...data, _sourceUrl: url });
    },
});