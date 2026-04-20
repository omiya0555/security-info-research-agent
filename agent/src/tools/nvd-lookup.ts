import { tool } from '@strands-agents/sdk'
import { NvdLookupInputSchema } from '../schemas/nvd.js';

const NVD_BASE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const DEFAULT_RESULTS_PER_PAGE = 20;
const MAX_REFERENCES = 3;
const MAX_AFFECTED = 10;

type CvssMetric = {
    cvssData?: { baseScore?: number; baseSeverity?: string; vectorString?: string };
    type?: string;
};

type CpeMatch = {
    vulnerable?: boolean;
    criteria?: string;
    versionStartIncluding?: string;
    versionStartExcluding?: string;
    versionEndIncluding?: string;
    versionEndExcluding?: string;
};

type NvdVulnerability = {
    cve?: {
        id?: string;
        published?: string;
        lastModified?: string;
        vulnStatus?: string;
        descriptions?: Array<{ lang?: string; value?: string }>;
        metrics?: {
            cvssMetricV31?: CvssMetric[];
            cvssMetricV30?: CvssMetric[];
            cvssMetricV2?: CvssMetric[];
        };
        weaknesses?: Array<{ description?: Array<{ lang?: string; value?: string }> }>;
        configurations?: Array<{ nodes?: Array<{ cpeMatch?: CpeMatch[] }> }>;
        references?: Array<{ url?: string; tags?: string[] }>;
    };
};

function pickCvss(metrics: CvssMetric[] | undefined) {
    if (!metrics?.length) return null;
    const primary = metrics.find((m) => m.type === 'Primary') ?? metrics[0];
    const d = primary.cvssData;
    if (!d) return null;
    return {
        baseScore: d.baseScore,
        baseSeverity: d.baseSeverity,
        vectorString: d.vectorString,
    };
}

function compactVulnerability(v: NvdVulnerability) {
    const cve = v.cve ?? {};
    const description = cve.descriptions?.find((d) => d.lang === 'en')?.value;
    const cwes = cve.weaknesses
        ?.flatMap((w) => w.description ?? [])
        .filter((d) => d.lang === 'en' && d.value)
        .map((d) => d.value!) ?? [];
    const affected = cve.configurations
        ?.flatMap((c) => c.nodes ?? [])
        .flatMap((n) => n.cpeMatch ?? [])
        .filter((m) => m.vulnerable)
        .slice(0, MAX_AFFECTED)
        .map((m) => ({
            criteria: m.criteria,
            versionStartIncluding: m.versionStartIncluding,
            versionStartExcluding: m.versionStartExcluding,
            versionEndIncluding: m.versionEndIncluding,
            versionEndExcluding: m.versionEndExcluding,
        })) ?? [];
    return {
        id: cve.id,
        published: cve.published,
        lastModified: cve.lastModified,
        vulnStatus: cve.vulnStatus,
        description,
        cvssV3: pickCvss(cve.metrics?.cvssMetricV31 ?? cve.metrics?.cvssMetricV30),
        cvssV2: pickCvss(cve.metrics?.cvssMetricV2),
        cwes: [...new Set(cwes)],
        affected,
        references: cve.references?.slice(0, MAX_REFERENCES).map((r) => ({ url: r.url, tags: r.tags })) ?? [],
    };
}

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
        const data = await res.json() as { totalResults?: number; vulnerabilities?: NvdVulnerability[] };
        return JSON.stringify({
            totalResults: data.totalResults,
            vulnerabilities: (data.vulnerabilities ?? []).map(compactVulnerability),
            _sourceUrl: url,
        });
    },
});
