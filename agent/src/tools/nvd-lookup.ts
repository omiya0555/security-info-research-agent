import { tool } from '@strands-agents/sdk'
import { NvdLookupInputSchema } from '../schemas/nvd.js';

const NVD_BASE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const DEFAULT_RESULTS_PER_PAGE = 20;

export const nvdLookup = tool({
    name: 'nvd_lookup',
    description:
        'NVD (National Vulnerability Database) から CVE 情報を検索する。' +
        '権威的な CVSS スコア、CWE、影響製品 (CPE)、参照 URL を含む。',
    inputSchema: NvdLookupInputSchema,

    callback: async (input) => {
    const params = new URLSearchParams();
    if (input.cveId) params.set('cveId', input.cveId);
    if (input.keywordSearch) params.set('keywordSearch', input.keywordSearch);
    if (input.cvssV3Severity) params.set('cvssV3Severity', input.cvssV3Severity);
    if (input.pubStartDate) params.set('pubStartDate', input.pubStartDate);
    if (input.pubEndDate) params.set('pubEndDate', input.pubEndDate);
    if (input.hasKev) params.set('hasKev', '');
    params.set('resultsPerPage', String(input.resultsPerPage ?? DEFAULT_RESULTS_PER_PAGE));

    const headers: Record<string, string> = {};
    if (process.env.NVD_API_KEY) {
        headers['apiKey'] = process.env.NVD_API_KEY;
    }

    const url = `${NVD_BASE_URL}?${params}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return `Error: ${res.status} ${res.statusText}`;
    const data = await res.json();
    return JSON.stringify({ ...data, _sourceUrl: url });
    },
});