# Census — US Census Bureau

The official US Census Bureau data: decennial census, American Community Survey (ACS), economic census, population estimates, housing characteristics, geographic boundaries. National, state, county, place, tract, block-group, and ZCTA-level. Free, no key required for public datasets.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Why this matters for AI agents

Demographics, housing characteristics, economic activity, geographic identifiers — Census is the authoritative source. If an agent is computing per-capita rates, comparing metros, looking up population, or working with FIPS codes, this is where it goes.

Common flows:

- **Population for an area.** ACS 1-year or 5-year estimates by state/county/place.
- **Housing characteristics.** Median home value, occupancy, units, age — all in ACS.
- **Geographic ID lookup.** Place name → FIPS code → boundary geometry.
- **Economic Census** every 5 years for industry-level economic activity.

Pair with [FRED](/docs/reference/fred) for time-series macro and [BLS](/docs/reference/bls) for labor.

## Auth

Most Census APIs are free and unauthenticated, with light rate limits (~500 calls/day per IP). For higher rates, get a key at https://api.census.gov/data/key_signup.html and pass via `_apiKey`.

## Datasets worth knowing

| Dataset | Cadence | Geography |
|---|---|---|
| Decennial Census (PL, DHC) | 10-year | Block-level and up |
| ACS 5-year | Annually-rolling | Tract/BG (5-year smoothing) |
| ACS 1-year | Annually | Places ≥65k population |
| Population Estimates Program (PEP) | Annually | County-level |
| Economic Census | 5-year | Industry × geography |

ACS 5-year is what you usually want for current demographics — it's available at finer geographies than 1-year and updates yearly with rolling 5-year smoothing.

## Common pitfalls

- **Year-of-coverage vs release year.** ACS 5-year 2018-2022 was released in 2023. Don't conflate.
- **Margins of error.** ACS includes MOE for every estimate. At small geographies (block group, small tract), MOEs can be larger than the estimate. Always carry MOE through to the user.
- **Geography hierarchy.** State (`01`) → County (`01001`) → Tract (`01001020100`) → Block Group. The 11-digit tract code is state(2) + county(3) + tract(6).
- **Place vs MSA.** "Denver" can mean the City and County of Denver, OR the Denver-Aurora-Lakewood Metropolitan Statistical Area (very different boundaries and populations). Disambiguate per use case.
- **Population estimates lag the decennial.** Between censuses, PEP estimates are extrapolated and revised. The Census Bureau revises previous PEPs each year as they reconcile with births/deaths/migration data.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "census": {
      "url": "https://gateway.pipeworx.io/census/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/census/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/census_population \
  -H 'Content-Type: application/json' \
  -d '{"place":"Travis County, TX"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/census_population`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "census": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-census"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-census
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Census data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
