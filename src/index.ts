interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Census MCP — U.S. Census Bureau housing-relevant APIs.
 *
 * Tools:
 * - census_population: population (plus median age, households, median income) for a county/city/ZIP/state by plain-English name
 * - census_acs: American Community Survey 5-year data (housing units, median home value, owner-occupied, etc.)
 * - census_building_permits: Monthly building permits from the residential construction survey
 * - census_housing_starts: New residential construction (starts, under construction, completions)
 * - census_homeownership: Housing Vacancy Survey quarterly homeownership rates
 * - census_available_datasets: List available Census Bureau datasets (no key required)
 *
 * BYO key: Census API key from https://api.census.gov/data/key_signup.html
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Census');
}


const BASE = 'https://api.census.gov/data';

function extractKey(args: Record<string, unknown>): string {
  const key = args._apiKey as string;
  delete args._apiKey;
  if (!key) throw new Error('Census API key required. Get one free at https://api.census.gov/data/key_signup.html');
  return key;
}

async function censusFetch(url: string): Promise<unknown> {
  const res = await pwFetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Census API error (${res.status}): ${text}`);
  }
  // A valid-format period that Census has not published yet comes back as
  // HTTP 200 with an EMPTY BODY — not an error, not an empty array. Calling
  // res.json() on that throws "Unexpected end of JSON input", which is what a
  // caller asking for "the latest month" actually hit: the router reasonably
  // computes the current month, Census is a month or two behind, and a
  // reasonable question died on a parse error. Empty body is data-not-published,
  // so report it as absence and let the caller decide.
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Census answers a bad key with an HTML "Invalid Key" page at HTTP 200, so
    // it lands here rather than in the !res.ok branch. Saying "the period or
    // variable does not exist" for that sends the caller to rewrite a query
    // that was already correct.
    if (/invalid key/i.test(text)) {
      throw new Error(
        'Census rejected the API key. Register a free key at https://api.census.gov/data/key_signup.html and pass it as _apiKey — the geography and variables in this request were not the problem.',
      );
    }
    throw new Error(
      `Census API returned a non-JSON body (${text.slice(0, 120)}). This usually means the requested period or variable does not exist.`,
    );
  }
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
    name: 'census_population',
    description:
      'HOW MANY PEOPLE LIVE somewhere in the United States — the population of a county, city, town, ZIP code or state from the American Community Survey. Answers "population of Travis County Texas", "how many people live in Austin", "what is the population of 78701", "Ohio population". Say the place the way a person says it ("Travis County, TX", "Austin, TX", "78701", "Texas"); no FIPS codes and no variable codes needed. Also returns median age, household count and median household income for the same place when the survey publishes them. Figures are 5-year survey estimates, so they describe a period rather than a census-day headcount. For what homes cost or rent there, use census_acs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        place: { type: 'string', description: 'The place, in plain English: "Travis County, TX", "Austin, TX", "78701", "Texas". A county or place name works best with its state.' },
        year: { type: 'number', description: 'ACS 5-year survey year (default 2022; available from 2009).' },
        _apiKey: { type: 'string', description: 'Census API key' },
      },
      required: ['place'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        place: { type: 'string' },
        population: { type: 'number' },
        median_age: { type: 'number' },
        households: { type: 'number' },
        median_household_income_usd: { type: 'number' },
        year: { type: 'number' },
        estimate_note: { type: 'string' },
        source: { type: 'string' },
      },
      required: ['found', 'place', 'population', 'year', 'source'],
    },
  },
  {
    name: 'census_acs',
    description:
      'Median home value and median rent for a US ZIP CODE, city, town, county or state, from the American Community Survey — the keyless way to answer "what do homes cost in 33158" or "median home price in Miami-Dade County" at a grain below metro level. Pass the geography the way a person says it: a 5-digit ZIP ("33158"), a place with its state ("Palmetto Bay, FL"), a county ("Miami-Dade County, FL"), or a state ("Florida"); FIPS codes and raw Census "for" syntax also work. Median home value is B25077_001E and median gross rent is B25064_001E (B25003 is tenure counts, not rent); the same call also serves ownership rates, vacancy and any other ACS variable code. Values are 5-year survey estimates, so they describe a period rather than this month\'s asking prices.',
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
      'Check monthly building permits for new residential construction by geography. Returns count of authorized privately-owned housing units and construction activity trends.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time: { type: 'string', description: 'Month as "YYYY-MM" (e.g. "2026-04"), or "from 2026-01 to 2026-04" for a range. Defaults to the latest published month.' },
        category_code: { type: 'string', description: 'APERMITS (annual rate, default) or PERMITS (monthly level). Pass "ALL" to get every residential-construction series for the month.' },
        _apiKey: { type: 'string', description: 'Census API key' },
      },
    },
  },
  {
    name: 'census_housing_starts',
    description:
      'Get residential construction pipeline by geography: new starts, units under construction, and completed units. Returns housing supply and activity trends.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time: { type: 'string', description: 'Month as "YYYY-MM" (e.g. "2026-04"), or "from 2026-01 to 2026-04" for a range. Defaults to the latest published month.' },
        category_code: { type: 'string', description: 'ASTARTS (annual rate, default), STARTS, COMPLETIONS, UNDERCONST, AUTHNOTSTD, or "ALL".' },
        _apiKey: { type: 'string', description: 'Census API key' },
      },
    },
  },
  {
    name: 'census_homeownership',
    description:
      'US homeownership rate and housing vacancy rates by quarter, from the Census Housing Vacancy Survey (HVS) — the official source. Returns `headline` (the national homeownership rate as a percent) plus the rental and homeowner vacancy rates. Defaults to the latest published quarter.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time: { type: 'string', description: 'Quarter as "YYYY-QN" (e.g. "2026-Q1"). Defaults to the latest published quarter.' },
        _apiKey: { type: 'string', description: 'Census API key' },
      },
    },
  },
  {
    name: 'census_available_datasets',
    description:
      'Discover Census datasets and their variables. Returns dataset names, descriptions, and variable codes (e.g., B25001_001E) for querying with other census tools.',
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
    case 'census_population':
      return censusPopulation(args);
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

/**
 * Census "for" syntax needs FIPS codes nobody carries in their head: Miami-Dade
 * County is `county:086&in=state:12`. An agent asked for the median home price
 * in 33158 has a ZIP or a place name, not that, and the ZIP/county grain is the
 * grain people actually ask about. So resolve plain English here.
 *
 * State FIPS are fixed by federal standard and do not churn, so they are a table.
 * Counties and places are looked up live against the same ACS year being queried,
 * which keeps the resolver honest when place definitions change between vintages.
 */
const STATE_FIPS: Record<string, string> = {
  al: '01', ak: '02', az: '04', ar: '05', ca: '06', co: '08', ct: '09', de: '10',
  dc: '11', fl: '12', ga: '13', hi: '15', id: '16', il: '17', in: '18', ia: '19',
  ks: '20', ky: '21', la: '22', me: '23', md: '24', ma: '25', mi: '26', mn: '27',
  ms: '28', mo: '29', mt: '30', ne: '31', nv: '32', nh: '33', nj: '34', nm: '35',
  ny: '36', nc: '37', nd: '38', oh: '39', ok: '40', or: '41', pa: '42', ri: '44',
  sc: '45', sd: '46', tn: '47', tx: '48', ut: '49', vt: '50', va: '51', wa: '53',
  wv: '54', wi: '55', wy: '56', pr: '72',
};
const STATE_NAMES: Record<string, string> = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca',
  colorado: 'co', connecticut: 'ct', delaware: 'de', 'district of columbia': 'dc',
  florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il',
  indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok',
  oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc',
  'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt',
  virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi',
  wyoming: 'wy', 'puerto rico': 'pr',
};

function stateFips(token: string): string | null {
  const t = token.trim().toLowerCase().replace(/\.$/, '');
  if (STATE_FIPS[t]) return STATE_FIPS[t];
  const abbr = STATE_NAMES[t];
  return abbr ? STATE_FIPS[abbr] : null;
}

/** Strip the Census entity suffix so "Palmetto Bay village, Florida" matches "Palmetto Bay". */
function bareName(name: string): string {
  return name
    .split(',')[0]
    .replace(/\s+(village|city|town|borough|CDP|municipality|County|Parish|Census Area|Municipio)$/i, '')
    .trim()
    .toLowerCase();
}

async function lookupInState(
  level: 'county' | 'place', name: string, stFips: string, year: number, key: string,
) {
  const params = new URLSearchParams({ get: 'NAME', for: `${level}:*`, in: `state:${stFips}`, key });
  const rows = tableToObjects(await censusFetch(`${BASE}/${year}/acs/acs5?${params}`)) as Record<string, string>[];
  const want = bareName(name);
  const exact = rows.filter((r) => bareName(r.NAME ?? '') === want);
  const hits = exact.length ? exact : rows.filter((r) => bareName(r.NAME ?? '').startsWith(want));
  return hits.map((r) => ({ name: r.NAME, fips: r[level] }));
}

type GeoResolution = { forClause: string; inClause?: string; resolved: string; note?: string };

async function resolveGeography(raw: string, year: number, key: string): Promise<GeoResolution> {
  const geography = raw.trim();
  // Already Census syntax — pass it straight through, unchanged.
  if (geography.includes(':')) {
    const [forClause, inClause] = geography.split('&in=');
    return { forClause, inClause, resolved: geography };
  }

  const zip = geography.match(/\b(\d{5})\b/);
  if (zip && !/[a-z]/i.test(geography.replace(/zip|code|zcta/gi, ''))) {
    return {
      forClause: `zip code tabulation area:${zip[1]}`,
      resolved: `zip code tabulation area:${zip[1]}`,
      note: `Read "${geography}" as ZIP Code Tabulation Area ${zip[1]}. A ZCTA approximates the ZIP's delivery area and is not identical to it.`,
    };
  }

  // "<name>, <state>" — the shape people actually type.
  const comma = geography.split(',');
  if (comma.length >= 2) {
    const stFips = stateFips(comma[comma.length - 1]);
    const name = comma.slice(0, -1).join(',').trim();
    if (stFips && name) {
      const isCounty = /\b(county|parish|borough|municipio)\b/i.test(name);
      const order: ('county' | 'place')[] = isCounty ? ['county'] : ['place', 'county'];
      for (const level of order) {
        const hits = await lookupInState(level, name, stFips, year, key);
        if (hits.length === 1) {
          return {
            forClause: `${level}:${hits[0].fips}`,
            inClause: `state:${stFips}`,
            resolved: `${level}:${hits[0].fips}&in=state:${stFips}`,
            note: `Read "${geography}" as ${hits[0].name}.`,
          };
        }
        if (hits.length > 1) {
          throw new Error(
            `"${geography}" matches ${hits.length} ${level}s in that state: ${hits.map((h) => h.name).join('; ')}. Ask again with one of those exact names.`,
          );
        }
      }
      throw new Error(
        `No county or place named "${name}" exists in that state for ACS ${year}. Census names carry a suffix ("Palmetto Bay village"), which this tool strips for you, so the mismatch is the name itself — check the spelling, or query the ZIP instead by passing just the 5-digit code.`,
      );
    }
  }

  const stOnly = stateFips(geography);
  if (stOnly) return { forClause: `state:${stOnly}`, resolved: `state:${stOnly}`, note: `Read "${geography}" as state FIPS ${stOnly}.` };

  throw new Error(
    `Could not read "${geography}" as a geography. Pass a 5-digit ZIP ("33158"), a place or county with its state ("Palmetto Bay, FL" or "Miami-Dade County, FL"), a state ("Florida"), or raw Census "for" syntax ("county:086&in=state:12").`,
  );
}

/**
 * Population is the most-asked census question and this pack could not be asked
 * it. The capability was here — census_acs resolves "Travis County, TX" and
 * B01003_001E returns 1,289,054 — but tool selection is embedding similarity
 * over the description, and census_acs's description is entirely home values
 * and rents. So "population of Travis County Texas" could not match it, and
 * did not: 13 asks from one PAID caller on 2026-09-09 all routed to
 * hud_fair_market_rents and answered with rents. The caller would also have
 * had to know the variable code. A question this common deserves a tool whose
 * description is about it and whose only argument is the place.
 */
const POP_VARS = {
  B01003_001E: 'population',
  B01002_001E: 'median_age',
  B11001_001E: 'households',
  B19013_001E: 'median_household_income_usd',
} as const;

function censusNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  // Census uses large negative sentinels (-666666666 and friends) for
  // suppressed or unavailable estimates. Returning one as a number would put a
  // negative median income in front of a caller as though it were measured.
  if (!Number.isFinite(n) || n <= -666666666) return null;
  return n;
}

async function censusPopulation(args: Record<string, unknown>) {
  const key = extractKey(args);
  const year = (args.year as number) ?? 2022;
  const place = typeof args.place === 'string' ? args.place.trim() : '';
  if (!place) throw new Error('user_error: place is required — e.g. "Travis County, TX", "Austin, TX", "78701" or "Texas"');

  const geo = await resolveGeography(place, year, key);

  const fetchVars = async (vars: string) => {
    const params = new URLSearchParams({ get: vars, for: geo.forClause, key });
    if (geo.inClause) params.set('in', geo.inClause);
    return tableToObjects(await censusFetch(`${BASE}/${year}/acs/acs5?${params}`));
  };

  // Ask for the extras in the same request, but never let them cost the
  // answer: Census 400s the WHOLE call when one variable is not published for
  // that geography (median household income is not available for every ZCTA),
  // so a failure here falls back to population alone rather than returning
  // nothing for a question that was answerable.
  let rows: Record<string, string>[] = [];
  let extras = true;
  try {
    rows = await fetchVars(`NAME,${Object.keys(POP_VARS).join(',')}`);
  } catch {
    extras = false;
    rows = await fetchVars('NAME,B01003_001E');
  }

  const row = rows[0];
  const population = censusNumber(row?.B01003_001E);
  if (!row || population === null) {
    return {
      found: false,
      reason: 'no_estimate',
      place: geo.resolved,
      place_requested: place,
      year,
      hint: `The American Community Survey publishes no population estimate for "${place}" in ${year}. Try a larger geography (the county or state containing it) or an earlier year.`,
      source: 'U.S. Census Bureau American Community Survey 5-year estimates',
    };
  }

  return {
    found: true,
    place: row.NAME ?? geo.resolved,
    ...(geo.resolved !== place ? { place_requested: place } : {}),
    ...(geo.note ? { geography_note: geo.note } : {}),
    population,
    ...(extras
      ? {
          median_age: censusNumber(row.B01002_001E),
          households: censusNumber(row.B11001_001E),
          median_household_income_usd: censusNumber(row.B19013_001E),
        }
      : {}),
    year,
    estimate_note: `${year} ACS 5-year estimate, covering ${year - 4}-${year}. Not a census-day headcount.`,
    source: 'U.S. Census Bureau American Community Survey 5-year estimates (api.census.gov)',
  };
}

async function censusAcs(args: Record<string, unknown>) {
  const key = extractKey(args);
  const year = (args.year as number) ?? 2022;
  const variables = args.variables as string;
  const geography = args.geography as string;

  const geo = await resolveGeography(geography, year, key);

  const params = new URLSearchParams({
    get: variables,
    for: geo.forClause,
    key,
  });
  if (geo.inClause) params.set('in', geo.inClause);

  const data = await censusFetch(`${BASE}/${year}/acs/acs5?${params}`);
  return {
    year,
    variables: variables.split(','),
    geography: geo.resolved,
    ...(geo.resolved !== geography ? { geography_requested: geography } : {}),
    ...(geo.note ? { geography_note: geo.note } : {}),
    results: tableToObjects(data),
  };
}

/**
 * The Census EITS `resconst` dataset does NOT have variables called PERMIT /
 * PERMIT_1UNIT / STARTS — those were invented in this pack's schema, so EVERY
 * documented call returned `400 unknown variable 'PERMIT'`. The real dataset is
 * a long table keyed by `category_code` (APERMITS, ASTARTS, COMPLETIONS,
 * UNDERCONST, …) × `data_type_code` (TOTAL / SINGLE / MULTI), and it REQUIRES
 * `seasonally_adj` and `time_slot_id` in the variable list or it 400s.
 *
 * Both tools now build that variable set themselves and default to the latest
 * published month, so a bare call works. `time` is honoured when given.
 */
// geo_level_code is NOT optional: without it the response contains five
// identical-looking TOTAL rows (238 / 130 / 748 / 1423 / 307) that are actually
// the four census regions plus the US, and nothing in the payload says which is
// which. A reader — human or model — cannot pick the headline number out of
// that, which is why "how many permits were issued?" came back as "the data
// does not provide a single total" even after the 400 was fixed.
const RESCONST_VARS =
  'cell_value,category_code,data_type_code,seasonally_adj,geo_level_code,time_slot_id,time_slot_name';

/** Latest EITS month with data. Building permits publish ~3 weeks after month
 *  end; using 2-month lag gives safe availability margin. */
function defaultResconstMonth(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 2);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function resconst(
  args: Record<string, unknown>,
  defaultCategory: string,
): Promise<unknown> {
  const key = args._apiKey as string | undefined;
  delete args._apiKey;
  const requestedTime = (args.time as string | undefined)?.trim() || defaultResconstMonth();
  const category = ((args.category_code as string | undefined) ?? defaultCategory).toUpperCase();

  const fetchMonth = async (t: string) => {
    const params = new URLSearchParams({ get: RESCONST_VARS, time: t });
    if (category !== 'ALL') params.set('category_code', category);
    if (key) params.set('key', key);
    return tableToObjects(
      await censusFetch(`${BASE}/timeseries/eits/resconst?${params}`),
    ) as Record<string, string>[];
  };

  // Census publishes residential construction on a lag, so "the latest month"
  // is not this month. Asking for an unpublished month returns an empty body
  // (see censusFetch), which used to surface as a parse error on a perfectly
  // reasonable question. Walk back to the most recent month that HAS data and
  // say plainly which month answered — silently substituting a different period
  // would be worse than the error it replaces.
  const MAX_LOOKBACK_MONTHS = 14;
  let time = requestedTime;
  let rows = await fetchMonth(time);
  let monthsWalkedBack = 0;
  if (rows.length === 0 && /^\d{4}-\d{2}$/.test(requestedTime)) {
    const [y0, m0] = requestedTime.split('-').map(Number);
    for (let back = 1; back <= MAX_LOOKBACK_MONTHS && rows.length === 0; back++) {
      const d = new Date(Date.UTC(y0, m0 - 1 - back, 1));
      const candidate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      rows = await fetchMonth(candidate);
      if (rows.length > 0) {
        time = candidate;
        monthsWalkedBack = back;
      }
    }
  }

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_data_for_period',
      requested_time: requestedTime,
      category_code: category,
      hint: `Census published nothing for ${requestedTime} or the ${MAX_LOOKBACK_MONTHS} months before it. Residential construction runs roughly two months behind, so try an explicit earlier month as time="YYYY-MM", or omit time to get the latest published month.`,
    };
  }

  // Lead with the one number the question is actually asking for: the national,
  // seasonally-adjusted total for the requested category. Everything else stays
  // in `results` for anyone who wants the regional or single/multi split. A
  // correct payload the reader can't summarise is still a failed answer.
  const headlineRow = rows.find(
    (r) =>
      r.data_type_code === 'TOTAL' &&
      r.seasonally_adj === 'yes' &&
      (r.geo_level_code === 'US' || r.geo_level_code === 'us'),
  );
  const headline = headlineRow
    ? {
        category_code: headlineRow.category_code,
        value_thousands: Number(headlineRow.cell_value),
        units: 'thousands of housing units, seasonally adjusted annual rate',
        geography: 'United States',
        period: headlineRow.time_slot_name ?? time,
      }
    : null;

  return {
    time,
    date: `${time}-01`,
    category_code: category,
    ...(monthsWalkedBack > 0
      ? {
          requested_time: requestedTime,
          period_adjusted: true,
          period_note: `Census had not published ${requestedTime} yet; this is the latest available month (${time}), ${monthsWalkedBack} month(s) earlier. Residential construction runs roughly two months behind.`,
        }
      : {}),
    ...(headline ? { headline } : {}),
    units: 'thousands of housing units, annual rate where seasonally adjusted',
    note: 'category_code: APERMITS/PERMITS = units authorized by building permits, ASTARTS/STARTS = starts, COMPLETIONS, UNDERCONST, AUTHNOTSTD. data_type_code: TOTAL / SINGLE (1-unit) / MULTI; E_* rows are the standard errors. geo_level_code: US = national, the rest are census regions. Codes prefixed A are the annual-rate series.',
    count: rows.length,
    results: rows,
  };
}

async function censusBuildingPermits(args: Record<string, unknown>) {
  return resconst(args, 'APERMITS');
}

async function censusHousingStarts(args: Record<string, unknown>) {
  return resconst(args, 'ASTARTS');
}

/** Latest published HVS quarter. The Housing Vacancy Survey lands ~4 weeks after
 *  quarter end, so step back one full quarter for a safe default. */
function defaultHvQuarter(): string {
  const d = new Date();
  const q = Math.floor(d.getUTCMonth() / 3); // 0-3 for the CURRENT quarter
  return q === 0 ? `${d.getUTCFullYear() - 1}-Q4` : `${d.getUTCFullYear()}-Q${q}`;
}

async function censusHomeownership(args: Record<string, unknown>) {
  const key = extractKey(args);
  const time = (args.time as string | undefined)?.trim() || defaultHvQuarter();

  // This used to send `get=HOR`, but HOR is a category_code in the EITS housing-
  // vacancy program, not a variable — so every call 400'd with "unknown variable
  // 'HOR'" and the official US homeownership rate was simply unanswerable. The
  // program takes the same shape as resconst above: ask for the standard cell
  // columns and pick the series you want out of the rows.
  const params = new URLSearchParams({
    get: 'cell_value,category_code,data_type_code,seasonally_adj,geo_level_code,time_slot_id,time_slot_name',
    time,
    key,
  });

  const rows = tableToObjects(
    await censusFetch(`${BASE}/timeseries/eits/hv?${params}`),
  ) as Record<string, string>[];

  // The rate series live under category_code=RATE and are told apart by
  // data_type_code: HOR = homeownership rate, RVR = rental vacancy rate, HVR =
  // homeowner vacancy rate, SAHOR = seasonally-adjusted homeownership. The E_*
  // twins are standard errors, not rates — picking one of those by accident is
  // how you report a 0.5% homeownership rate with a straight face.
  const national = (dataType: string) =>
    rows.find(
      (r) =>
        r.category_code === 'RATE' &&
        r.data_type_code === dataType &&
        r.geo_level_code.toUpperCase() === 'US',
    );
  const pct = (r?: Record<string, string>) =>
    r && r.cell_value !== '' ? Number(r.cell_value) : null;

  const hor = national('HOR');
  return {
    metric: 'homeownership_rate',
    time,
    ...(hor
      ? {
          headline: {
            homeownership_rate_pct: pct(hor),
            seasonally_adjusted_pct: pct(national('SAHOR')),
            standard_error_pct: pct(national('E_HOR')),
            units: 'percent of occupied housing units that are owner-occupied',
            geography: 'United States',
            period: hor.time_slot_name ?? time,
          },
        }
      : {}),
    rental_vacancy_rate_pct: pct(national('RVR')),
    homeowner_vacancy_rate_pct: pct(national('HVR')),
    note: 'Source: Census Housing Vacancy Survey (HVS), quarterly, not seasonally adjusted unless stated. category_code RATE holds the rates (data_type_code HOR / RVR / HVR, E_* = standard errors, SAHOR = seasonally adjusted); ESTIMATE holds the unit counts in thousands. geo_level_code US = national, the rest are census regions.',
    count: rows.length,
    results: rows,
  };
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
