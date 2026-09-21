// Jeview: a local middleman for Jev with a live view of every call (README.md). A client sends its Jev requests
// here exactly as it would to TypeSafe (POST /v1/systemone, optionally /<label>/v1/systemone to name a run); the proxy
// calls Jev with the key set in the viewer's settings (without a key, calls are refused), answers the client with
// Jev's answer, and keeps each call whole in a private SQLite database. Loopback only: calls can hold private data.
//
// Every answer Jev gives gets an event id, "<call>:<question>", returned with the answers as `events`. A later request
// that follows from one of those answers says so in a header, `Jeview-Trigger: <event id>`, so the viewer can grow
// that question as a branch off the answer that led to it. Jeview's own headers are dropped before Jev, and the body
// and path are Jev's own contract, untouched: Jev gets the body byte for byte.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const JEV_PATH = "/v1/systemone";
/** TypeSafe's endpoint: where every Jev call goes, with the Jev key. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000; // TypeSafe's rate for Jev; output tokens are free
export const DATABASE = "jeview.sqlite";
const BODY_LIMIT = 16 * 1024 * 1024;
const REQUEST_DROP = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "content-length", "accept-encoding", "authorization", "cookie", "origin", "referer"]);
// fetch has already decoded the body, so its length and encoding no longer describe what is sent on
const RESPONSE_DROP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const UI_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

/** One question as listed: its id, what it asks in its own words, what it offered (a choice's options, a score's
 * number of levels) and the answer's headline. `p` is the probability Jev gave the answer it landed on: the chosen
 * option, the nearest level, or the more likely side of a yes/no; `probabilities` is the whole spread. */
export type AnswerSummary = { id: string; type: string; asks: string; options?: string[]; levels?: number; choice?: string; score?: number; noul?: number; confidence?: number; p?: number; probabilities?: Record<string, number> };
const OPTIONS_LISTED = 60;
/** One recorded Jev call, as listed. `key` is the sha256 of the exact body sent to Jev: the same request always has
 * the same key, so a client that caches Jev answers by that hash can find the call here. */
export type JeviewSummary = {
  id: number; at: string; label: string; trigger: string | null;
  key: string; stateKey: string | null; status: number; elapsedMs: number; bytes: number;
  model: string | null; answeredBy: string | null; inputTokens: number | null; cost: number | null; questions: AnswerSummary[]; error?: string;
};
/** The whole call: the request as sent to Jev (parsed, or its text when it was not JSON) and the response as Jev returned it. */
export type JeviewRecord = { summary: JeviewSummary; request: unknown; response: unknown };

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return text; } };

/** The event id of one answer: the call it came in and the question it answered. */
export const eventId = (call: number, question: string) => `${call}:${question}`;
/** Jeview's own headers start with this; they are read here and never sent on to Jev. */
const OWN_HEADER = "jeview-";
/** The answer a request follows from, if its Jeview-Trigger header names one: an event id of at most 200 characters. */
export function requestTrigger(value: string | null): string | null {
  if (value === null) return null;
  if (!value.trim() || value.length > 200) throw Error("trigger must be the event id of an earlier answer, such as \"57:personal\"");
  return value.trim();
}

/** The question's own sentence: its instructions, or their `question` field when they carry context beside it. */
export function asks(instructions: unknown): string {
  const text = typeof instructions === "string" ? instructions : object(instructions) && typeof instructions.question === "string" ? instructions.question : JSON.stringify(instructions) ?? "";
  return text.length > 300 ? text.slice(0, 297) + "..." : text;
}

export function summarize(call: { id: number; at: string; label: string; trigger: string | null; status: number; elapsedMs: number; error?: string }, body: Buffer, request: unknown, response: unknown): JeviewSummary {
  const questions = object(request) && object(request.questions) ? request.questions : {};
  const answers = object(response) && object(response.answers) ? response.answers : {};
  const usage = object(response) && object(response.usage) ? response.usage : {};
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  return {
    ...call, key: sha256(body), stateKey: object(request) && "state" in request ? sha256(JSON.stringify(request.state) ?? "null") : null, bytes: body.length,
    model: object(request) && typeof request.model === "string" ? request.model : null,
    answeredBy: object(response) && typeof response.model === "string" ? response.model : null,
    inputTokens, cost: inputTokens === null ? null : inputTokens * JEV_USD_PER_INPUT_TOKEN,
    questions: Object.entries(questions).map(([id, question]) => {
      const answer = answers[id], summary: AnswerSummary = { id, type: object(question) && typeof question.type === "string" ? question.type : "unknown", asks: asks(object(question) ? question.instructions : undefined) };
      if (object(question) && question.type === "choice" && object(question.criteria)) summary.options = Object.keys(question.criteria).slice(0, OPTIONS_LISTED);
      if (object(question) && question.type === "score" && Array.isArray(question.criteria)) summary.levels = question.criteria.length;
      if (object(answer)) for (const field of ["choice", "score", "noul", "confidence"] as const) if (typeof answer[field] === (field === "choice" ? "string" : "number")) (summary as Record<string, unknown>)[field] = answer[field];
      const probabilities = object(answer) && object(answer.probabilities) ? answer.probabilities : {};
      const landed = summary.choice ?? (summary.score === undefined ? undefined : String(Math.round(summary.score)));
      if (landed !== undefined && typeof probabilities[landed] === "number") summary.p = probabilities[landed];
      else if (summary.noul !== undefined) summary.p = Math.max(summary.noul, 1 - summary.noul);
      // every option's probability, so the viewer can show the whole spread a choice or a ranking came back with
      const spread = Object.entries(probabilities).filter(([, v]) => typeof v === "number").slice(0, OPTIONS_LISTED);
      if (spread.length) summary.probabilities = Object.fromEntries(spread.map(([k, v]) => [k, Math.round((v as number) * 1000) / 1000]));
      return summary;
    }),
  };
}

/** Everything the proxy keeps, in one SQLite database in a folder private to the user: each call whole, in the order
 * calls finished (so a reader polling from a position never misses a slower call), and the viewer's settings. */
export class JeviewStore {
  readonly dir: string;
  readonly database: string;
  readonly summaries: JeviewSummary[] = [];
  private readonly db: DatabaseSync;
  private next: number;
  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    this.database = join(this.dir, DATABASE);
    this.db = new DatabaseSync(this.database);
    chmodSync(this.database, 0o600);
    const calls = "(seq INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL UNIQUE, at TEXT NOT NULL, label TEXT NOT NULL, trigger TEXT, key TEXT NOT NULL, status INTEGER NOT NULL, summary TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL)";
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS calls ${calls};
      CREATE INDEX IF NOT EXISTS calls_trigger ON calls (trigger);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    for (const row of this.db.prepare("SELECT summary FROM calls ORDER BY seq").all()) this.summaries.push(JSON.parse(String(row.summary)) as JeviewSummary);
    this.next = Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM calls").get()?.id ?? 0) + 1;
  }
  allocate(): number { return this.next++; }
  save(record: JeviewRecord): Promise<void> {
    const { summary } = record;
    this.db.prepare("INSERT INTO calls (id, at, label, trigger, key, status, summary, request, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(summary.id, summary.at, summary.label, summary.trigger, summary.key, summary.status, JSON.stringify(summary), JSON.stringify(record.request), JSON.stringify(record.response));
    this.summaries.push(summary);
    return Promise.resolve();
  }
  /** Every save is written before it returns; kept for callers that wait on it. */
  flush(): Promise<void> { return Promise.resolve(); }
  read(id: number): JeviewRecord | null {
    const row = this.db.prepare("SELECT summary, request, response FROM calls WHERE id = ?").get(id);
    return row ? { summary: JSON.parse(String(row.summary)), request: JSON.parse(String(row.request)), response: JSON.parse(String(row.response)) } : null;
  }
  /** Ids of the calls whose label, trigger, request or response contains every word, case-insensitively, newest first. */
  search(query: string, limit = 1000): number[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const like = words.map(() => "lower(label || ' ' || COALESCE(trigger, '') || ' ' || request || ' ' || response) LIKE ? ESCAPE '\\'").join(" AND ");
    return this.db.prepare(`SELECT id FROM calls WHERE ${like} ORDER BY id DESC LIMIT ?`).all(...words.map((word) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), limit).map((row) => Number(row.id));
  }
  setting(name: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE name = ?").get(name);
    return row ? String(row.value) : undefined;
  }
  setSetting(name: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE name = ?").run(name);
    else this.db.prepare("INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").run(name, value);
  }
  private closed = false;
  close() { if (!this.closed) { this.closed = true; this.db.close(); } } // the server may be closed more than once
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) { reject(Object.assign(Error(`request body exceeds ${limit} bytes`), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on("error", reject);
    req.on("end", () => accept(Buffer.concat(chunks)));
  });
}
const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

export class SettingsError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
/** What the viewer may see of the Jev key: whether it is set and how it ends, never the key. */
const keyView = (key: string | undefined) => ({ jevKey: key ? { set: true, ending: key.slice(-4) } : { set: false, ending: null } });
/** A settings change must come from the viewer itself: a same-origin JSON request (a page on another site cannot
 * send one), with a key that looks like a key. Returns the new key, or null to remove it. */
function keyChange(req: IncomingMessage, body: Buffer): string | null {
  if (req.headers.origin !== `http://${req.headers.host ?? ""}`) throw new SettingsError(403, "Settings can only be changed from the viewer");
  if ((req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/json") throw new SettingsError(415, "Settings are sent as JSON");
  const value = parse(body.toString("utf8"));
  if (!object(value) || !("jevKey" in value)) throw new SettingsError(400, "Send { jevKey: \"...\" } to set the key, or { jevKey: null } to remove it");
  if (value.jevKey === null) return null;
  if (typeof value.jevKey !== "string" || !/^[\x21-\x7e]{8,400}$/.test(value.jevKey.trim())) throw new SettingsError(400, "A Jev key is 8 to 400 visible characters, without spaces");
  return value.jevKey.trim();
}

/** How to connect, for people and agents: served at /llms.txt with this proxy's own address and state. */
export function llmsText(origin: string, keyed: boolean): string {
  return `# Jeview

A local middleman for Jev (TypeSafe System One) at ${origin}, with a live view of every call at ${origin}/
It calls Jev with the Jev key set in the viewer's settings and keeps each call whole (what was asked, what Jev saw,
what it answered) in a SQLite database on this machine.

The Jev key: ${keyed ? "set." : `not set yet, so calls are refused. Set it in the viewer's settings at ${origin}/.`}

## Send Jev requests here

Use ${origin}/v1/systemone wherever you would use https://api.typesafe.ai/v1/systemone: the same body
{ model, state, questions }, the same answers. No key is needed from the caller. To name a run, put a label in the
path: ${origin}/<label>/v1/systemone.

## Link a question to the answer that led to it

Every answer comes back with an event id, in "events" beside the answers: { "<question id>": "<call>:<question id>" }.
When a later request follows from one of those answers, send its event id in a header: Jeview-Trigger: <event id>.
The viewer then grows that request's questions as a branch off the answer that triggered them. Jeview drops its own
headers before calling Jev, and sends the body on exactly as it came.

## Read what was recorded (JSON, from this machine only)

- GET ${origin}/_/api/records?since=<n>: summaries in the order calls finished; "cursor" is the next "since".
- GET ${origin}/_/api/records/<id>: one call, the request sent to Jev and the response it returned.
- GET ${origin}/_/api/search?q=<words>: the ids of calls whose request or response contains every word.

A record's "key" is the sha256 of the exact body sent to Jev.
`;
}

export type JeviewOptions = { dir: string; jevEndpoint?: string; port?: number; fetch?: typeof fetch; ui?: string | URL };
export type Jeview = { server: Server; store: JeviewStore };

export function createJeview(options: JeviewOptions): Jeview {
  const endpoint = new URL(options.jevEndpoint ?? JEV_ENDPOINT);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw Error(`jeview: the Jev endpoint must be an http(s) URL, not ${endpoint.protocol}`);
  if (options.port !== undefined && LOOPBACK.test(endpoint.hostname) && Number(endpoint.port || 80) === options.port) throw Error(`jeview: the Jev endpoint ${endpoint.origin} is this proxy`);
  const jevEndpoint = endpoint.href, request = options.fetch ?? fetch, store = new JeviewStore(options.dir);
  const ui = resolve(fileURLToPath(options.ui ?? new URL("../ui/", import.meta.url)));
  const jevKey = () => store.setting("jevKey");

  /** One Jev call: to Jev with the Jev key, back to the caller with an event id per answer, and into the database. */
  async function ask(req: IncomingMessage, res: ServerResponse, label: string) {
    let body: Buffer;
    try { body = await readBody(req, BODY_LIMIT); } catch (error) { return send(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message }); }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (!REQUEST_DROP.has(name) && !name.startsWith(OWN_HEADER) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    const triggerHeader = req.headers[`${OWN_HEADER}trigger`];
    let trigger: string | null;
    try { trigger = requestTrigger(triggerHeader === undefined ? null : String(triggerHeader)); } catch (error) { return send(res, 400, { error: `jeview: ${(error as Error).message}` }); }
    const sent = body, requestValue = parse(body.toString("utf8")); // sent on as it came
    const id = store.allocate(), at = new Date().toISOString(), started = Date.now();
    const keep = (status: number, text: string, error?: string) => {
      const responseValue = text ? parse(text) : null;
      void store.save({ summary: summarize({ id, at, label, trigger, status, elapsedMs: Date.now() - started, ...(error ? { error } : {}) }, sent, requestValue, responseValue), request: requestValue, response: responseValue });
    };
    const fail = (status: number, message: string) => { keep(status, "", message); return send(res, status, { error: message }); };
    const key = jevKey();
    if (!key) return fail(401, `No Jev key: add one in the viewer's settings at http://${req.headers.host}/`);
    let response: Response;
    try { response = await request(jevEndpoint, { method: "POST", headers: { ...headers, authorization: `Bearer ${key}` }, body: new Uint8Array(sent), redirect: "manual" }); }
    catch (error) { return fail(502, `Jev unreachable: ${(error as Error).message}`); }
    let text: Buffer;
    try { text = Buffer.from(await response.arrayBuffer()); } catch (error) { return fail(502, `Jev's answer was cut short: ${(error as Error).message}`); }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => { if (!RESPONSE_DROP.has(name)) responseHeaders[name] = value; });
    const returned = parse(text.toString("utf8"));
    // each answer's event id, for a later request to name as its trigger
    const events = object(returned) && object(returned.answers) ? Object.fromEntries(Object.keys(returned.answers).map((question) => [question, eventId(id, question)])) : null;
    const reply = events && object(returned) ? Buffer.from(JSON.stringify({ ...returned, events })) : text;
    res.writeHead(response.status, responseHeaders);
    res.end(reply);
    keep(response.status, text.toString("utf8"));
  }


  const server = createServer((req, res) => {
    void (async () => {
      // Host allowlist against DNS rebinding: a page on another site must not read the records through a local name.
      if (!LOOPBACK.test(req.headers.host ?? "")) return send(res, 403, { error: "Host not allowed" });
      const url = new URL(req.url ?? "/", "http://proxy");
      // a Jev request: POST .../v1/systemone; whatever comes before names the run
      if (url.pathname.endsWith(JEV_PATH) && !url.pathname.startsWith("/_/")) {
        if (req.method !== "POST") return send(res, 405, { error: "Jev requests are POSTed" });
        const segments = url.pathname.slice(0, -JEV_PATH.length).split("/").filter(Boolean).map(decodeURIComponent);
        if (segments.at(-1) === "typesafe") segments.pop(); // clients that add the vendor's name before its path
        return ask(req, res, segments.join("/"));
      }
      if (url.pathname === "/_/api/settings" && req.method === "POST") {
        try { store.setSetting("jevKey", keyChange(req, await readBody(req, 16 * 1024))); return send(res, 200, keyView(jevKey())); }
        catch (error) { return send(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message }); }
      }
      if (req.method !== "GET") return send(res, 405, { error: "Send Jev requests to /v1/systemone; the viewer is otherwise read-only" });
      if (url.pathname === "/_/api/settings") return send(res, 200, keyView(jevKey()));
      if (url.pathname === "/llms.txt") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return void res.end(llmsText(`http://${req.headers.host}`, !!jevKey()));
      }
      const file = url.pathname === "/" ? "index.html" : /^\/_\/ui\/([a-z-]+\.(?:css|js))$/.exec(url.pathname)?.[1];
      if (file) {
        let content: Buffer;
        try { content = readFileSync(join(ui, file)); } catch { return send(res, 404, { error: "Not found" }); }
        res.writeHead(200, { "content-type": UI_TYPES[extname(file)]!, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": CSP });
        return void res.end(content);
      }
      if (url.pathname === "/_/api/records") {
        const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
        return send(res, 200, { cursor: store.summaries.length, records: store.summaries.slice(since), jev: endpoint.host, database: store.database, keyed: !!jevKey() });
      }
      const one = /^\/_\/api\/records\/(\d+)$/.exec(url.pathname);
      if (one) { const record = store.read(Number(one[1])); return record ? send(res, 200, record) : send(res, 404, { error: "No such record" }); }
      if (url.pathname === "/_/api/search") return send(res, 200, { ids: store.search(url.searchParams.get("q") ?? "") });
      return send(res, 404, { error: "Not found" });
    })().catch((error: unknown) => { if (!res.headersSent) send(res, 500, { error: (error as Error).message }); else res.destroy(); });
  });
  server.on("close", () => store.close());
  return { server, store };
}
