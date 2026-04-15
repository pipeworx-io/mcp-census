interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Census MCP — U.S. Census Bureau housing-relevant APIs.
 *
 * Tools:
 * - census_acs: American Community Survey 5-year data (housing units, median home value, owner-occupied, etc.)
 * - census_building_permits: Monthly building permits from the residential construction survey
 * - census_housing_starts: New residential construction (starts, under construction, completions)
 * - census_homeownership: Housing Vacancy Survey quarterly homeownership rates
 * - census_available_datasets: List available Census Bureau datasets (no key required)
 *
 * BYO key: Census API key from https://api.census.gov/data/key_signup.html
 */


const BASE = 'https://api.census.gov/data';

function extractKey(args: Record<string, unknown>): string {
  const key = args._apiKey as string;
  delete args._apiKey;
  if (!key) throw new Error('Census API key required. Get one free at https://api.census.gov/data/key_signup.html');
  return key;
}

async function censusFetch(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Census API error (${res.status}): ${text}`);
  }
  return res.json();
}

/** Convert Census 2D array response into array of objects using first row as headers */
function tableToObjects(data: unknown): Record<string, string>[] {
  if (!Array.isArray(data) || data.length < 2) return [];
  const headers = data[0] as string[];
  return data.slice(1).map((row: string[]) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i];
    });
    return obj;
  });
}

const tools: McpToolExport['tools'] = [
  {
    name: 'census_acs',
    description:
      'Get American Community Survey (ACS) 5-year data from the U.S. Census Bureau. The core dataset for housing statistics including total housing units, median home value, owner-occupied units, median rent, and more. Common variable codes: B25001_001E (total housing units), B25077_001E (median home value), B25003_002E (owner-occupied), B25003_003E (renter-occupied), B25064_001E (median gross rent), B25071_001E (median rent as % of income).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        year: { type: 'number', description: 'Survey year (default 2022). ACS 5-year estimates available from 2009 onward.' },
        variables: { type: 'string', description: 'Comma-separated variable codes to retrieve (e.g., "NAME,B25001_001E,B25077_001E"). Always include NAME for place names.' },
        geography: { type: 'string', description: 'Geographic level and filter using Census "for" syntax (e.g., "state:06" for California, "county:*" for all counties, "state:*" for all states, "county:037&in=state:06" for LA County).' },
        _apiKey: { type: 'string', description: 'Census API key' },
      },
      required: ['variables', 'geography', '_apiKey'],
    },
  },
  {
    name: 'census_building_permits',
    description:
      'Get monthly building permits data from the Census Bureau residential construction survey. Tracks new privately-owned housing units authorized by building permits.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        variables: { type: 'string', description: 'Comma-separated variables (e.g., "PERMIT" for total permits, "PERMIT_1UNIT" for single-family). Use census_available_datasets to discover variables.' },
        time: { type: 'string', description: 'Time period (e.g., "2024-01" for January 2024, "from+2023-01+to+2024-01" for a range).' },
        category_code: { type: 'string', description: 'Category filter (e.g., "TOTAL" for total, "1UNIT" for single-family). Optional.' },
        _apiKey: { type: 'string', description: 'Census API key' },
      },
      required: ['variables', 'time', '_apiKey'],
    },
  },
  {
    name: 'census_housing_starts',
    description:
      'Get new residential construction data including housing starts, units under construction, and completions from the Census Bureau.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        variables: { type: 'string', description: 'Comma-separated variables (e.g., "STARTS" for housing starts, "UNDER_CONSTRUCTION", "COMPLETIONS").' },
        time: { type: 'string', description: 'Time period (e.g., "2024-01" for January 2024).' },
        region: { type: 'string', description: 'Census region filter (e.g., "NE" for Northeast, "MW" for Midwest, "S" for South, "W" for West). Optional.' },
        _apiKey: { type: 'string', description: 'Census API key' },
      },
      required: ['variables', 'time', '_apiKey'],
    },
  },
  {
    name: 'census_homeownership',
    description:
      'Get quarterly homeownership rates from the Census Bureau Housing Vacancy Survey (HVS). Reports the percentage of occupied housing units that are owner-occupied.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time: { type: 'string', description: 'Time period in YYYY-QN format (e.g., "2024-Q1" for Q1 2024). Use "from+2020-Q1+to+2024-Q1" for a range.' },
        _apiKey: { type: 'string', description: 'Census API key' },
      },
      required: ['time', '_apiKey'],
    },
  },
  {
    name: 'census_available_datasets',
    description:
      'List available Census Bureau datasets. No API key required. Useful for discovering dataset identifiers, descriptions, and available variables before querying specific data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _apiKey: { type: 'string', description: 'Census API key (not required for this endpoint but accepted for consistency)' },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'census_acs':
      return censusAcs(args);
    case 'census_building_permits':
      return censusBuildingPermits(args);
    case 'census_housing_starts':
      return censusHousingStarts(args);
    case 'census_homeownership':
      return censusHomeownership(args);
    case 'census_available_datasets':
      return censusAvailableDatasets(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function censusAcs(args: Record<string, unknown>) {
  const key = extractKey(args);
  const year = (args.year as number) ?? 2022;
  const variables = args.variables as string;
  const geography = args.geography as string;

  // Parse the geography into "for" and optional "in" parts
  const parts = geography.split('&in=');
  const forClause = parts[0];
  const inClause = parts[1];

  const params = new URLSearchParams({
    get: variables,
    for: forClause,
    key,
  });
  if (inClause) params.set('in', inClause);

  const data = await censusFetch(`${BASE}/${year}/acs/acs5?${params}`);
  return { year, variables: variables.split(','), geography, results: tableToObjects(data) };
}

async function censusBuildingPermits(args: Record<string, unknown>) {
  const key = extractKey(args);
  const variables = args.variables as string;
  const time = args.time as string;
  const categoryCode = args.category_code as string | undefined;

  const params = new URLSearchParams({
    get: variables,
    time,
    key,
  });
  if (categoryCode) params.set('category_code', categoryCode);

  const data = await censusFetch(`${BASE}/timeseries/eits/resconst?${params}`);
  return { variables: variables.split(','), time, results: tableToObjects(data) };
}

async function censusHousingStarts(args: Record<string, unknown>) {
  const key = extractKey(args);
  const variables = args.variables as string;
  const time = args.time as string;
  const region = args.region as string | undefined;

  const params = new URLSearchParams({
    get: variables,
    time,
    key,
  });
  if (region) params.set('geo', region);

  const data = await censusFetch(`${BASE}/timeseries/eits/resconst?${params}`);
  return { variables: variables.split(','), time, region: region ?? 'all', results: tableToObjects(data) };
}

async function censusHomeownership(args: Record<string, unknown>) {
  const key = extractKey(args);
  const time = args.time as string;

  const params = new URLSearchParams({
    get: 'HOR',
    for: 'us:*',
    time,
    key,
  });

  const data = await censusFetch(`${BASE}/timeseries/eits/hv?${params}`);
  return { metric: 'homeownership_rate', time, results: tableToObjects(data) };
}

async function censusAvailableDatasets(args: Record<string, unknown>) {
  // Key is optional for this endpoint
  delete args._apiKey;

  const data = (await censusFetch(`${BASE}.json`)) as { dataset?: { title: string; description: string; c_vintage?: number; identifier: string }[] };
  const datasets = (data.dataset ?? [])
    .filter((d) => {
      const title = (d.title ?? '').toLowerCase();
      const desc = (d.description ?? '').toLowerCase();
      return (
        title.includes('housing') ||
        title.includes('residential') ||
        title.includes('acs') ||
        title.includes('american community') ||
        title.includes('vacancy') ||
        title.includes('construction') ||
        title.includes('permit') ||
        desc.includes('housing') ||
        desc.includes('residential')
      );
    })
    .slice(0, 50)
    .map((d) => ({
      title: d.title,
      description: d.description,
      vintage: d.c_vintage ?? null,
      identifier: d.identifier,
    }));

  return { total_housing_related: datasets.length, datasets };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
