import { tool } from '@strands-agents/sdk'
import { ShodanCveInputSchema } from '../schemas/shodan.js';

const SHODAN_BASE_URL = 'https://cvedb.shodan.io';
const DEFAULT_RESULTS_PER_PAGE = 20;
const MAX_REFERENCES = 3;
const MAX_CPES = 5;

type ShodanCve = {
    cve_id?: string;
    summary?: string;
    cvss?: number;
    cvss_v2?: number;
    cvss_v3?: number;
    epss?: number;
    ranking_epss?: number;
    kev?: boolean;
    propose_action?: string;
    ransomware_campaign?: string;
    references?: string[];
    published_time?: string;
    cpes?: string[];
};

function compactCve(c: ShodanCve) {
    return {
        cveId: c.cve_id,
        summary: c.summary,
        cvss: c.cvss_v3 ?? c.cvss ?? c.cvss_v2,
        epss: c.epss,
        ranking_epss: c.ranking_epss,
        kev: c.kev,
        ransomware_campaign: c.ransomware_campaign,
        propose_action: c.propose_action,
        published: c.published_time,
        cpes: c.cpes?.slice(0, MAX_CPES),
        references: c.references?.slice(0, MAX_REFERENCES),
    };
}

export const shodanCve = tool({
    name: 'shodan_cve',
    description:
        'Shodan CVEDB から CVE 情報を検索する。EPSS（悪用確率）や KEV（実攻撃の有無）を含む。' +
        'CVE ID 指定の詳細検索と、製品名・日付範囲での一覧検索の両方に対応。',
    inputSchema: ShodanCveInputSchema,

    callback: async (input) => {
        if (input.cveId) {
            const url = `${SHODAN_BASE_URL}/cve/${input.cveId}`;
            const response = await fetch(url);
            if (!response.ok) return `Error: ${response.status} ${response.statusText}`;
            const data = await response.json() as ShodanCve;
            return JSON.stringify({ ...compactCve(data), _sourceUrl: url });
        }

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
        const data = await res.json() as { cves?: ShodanCve[] };
        return JSON.stringify({
            cves: (data.cves ?? []).map(compactCve),
            _sourceUrl: url,
        });
    },
});
