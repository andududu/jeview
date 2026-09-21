import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createJeview, DATABASE, JEV_USD_PER_INPUT_TOKEN, type JeviewSummary } from "../src/jeview.ts";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
type Hooks = { after(fn: () => unknown): void };
const listen = (server: Server) => new Promise<number>((accept) => server.listen(0, "127.0.0.1", () => accept((server.address() as AddressInfo).port)));
const KEY = "ts-test-key-0001";

/** A stand-in for Jev: records what it was sent and answers with `reply`. */
async function jev(t: Hooks, reply: (seen: Seen) => { status?: number; headers?: Record<string, string>; body: string }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const call = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(call);
      const { status = 200, headers = { "content-type": "application/json" }, body } = reply(call);
      res.writeHead(status, headers);
      res.end(body);
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${port}/v1/systemone` };
}

async function proxy(t: Hooks, jevEndpoint: string, { key = KEY as string | null, dir = mkdtempSync(join(tmpdir(), "jeview-")) } = {}) {
  const made = createJeview({ dir, jevEndpoint });
  t.after(() => { made.server.close(); rmSync(dir, { recursive: true, force: true }); });
  if (key) made.store.setSetting("jevKey", key);
  const port = await listen(made.server);
  return { ...made, dir, base: `http://127.0.0.1:${port}` };
}

const question = { type: "choice", instructions: "What kind of message is `ticket`?", criteria: { bug_report: "a report of something broken", none: "none of the listed options fits" } };
const jevBody = JSON.stringify({ model: "jev-latest", state: { ticket: { subject: "LOGIN broken", plan: "pro" } }, questions: { kind: question, is_urgent: { type: "noul", instructions: "Is it urgent?" } } });
const jevAnswer = JSON.stringify({ model: "jev-2026-09", answers: { kind: { type: "choice", choice: "bug_report", probabilities: { bug_report: 0.9, none: 0.1 }, confidence: 0.9 }, is_urgent: { type: "noul", noul: 0.04 } }, usage: { input_tokens: 1000, output_tokens: 3 } });
const records = async (base: string) => (await (await fetch(`${base}/_/api/records`)).json()) as { cursor: number; records: JeviewSummary[]; keyed: boolean; database: string };

test("a Jev request goes to Jev with the key from settings, comes back with an event id per answer, and is kept whole without the caller's key", async (t) => {
  const upstream = await jev(t, () => ({ body: jevAnswer, headers: { "content-type": "application/json", "x-request-id": "r-1" } }));
  const { base, dir } = await proxy(t, upstream.url);
  const response = await fetch(`${base}/june-typing/stage-2/v1/systemone`, { method: "POST", headers: { authorization: "Bearer caller-secret", "content-type": "application/json" }, body: jevBody });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "r-1");
  assert.deepEqual(await response.json(), { ...JSON.parse(jevAnswer), events: { kind: "1:kind", is_urgent: "1:is_urgent" } });

  assert.equal(upstream.seen.length, 1);
  const sent = upstream.seen[0]!;
  assert.deepEqual([sent.method, sent.url, sent.body, sent.headers.authorization], ["POST", "/v1/systemone", jevBody, `Bearer ${KEY}`]);

  const { records: [summary], cursor, keyed } = await records(base);
  assert.deepEqual([cursor, keyed, summary!.label, summary!.trigger], [1, true, "june-typing/stage-2", null]);
  // the record key is the sha256 of exactly the body sent to Jev
  assert.equal(summary!.key, createHash("sha256").update(jevBody).digest("hex"));
  assert.deepEqual([summary!.model, summary!.answeredBy, summary!.inputTokens, summary!.cost], ["jev-latest", "jev-2026-09", 1000, 1000 * JEV_USD_PER_INPUT_TOKEN]);
  assert.deepEqual(summary!.questions, [
    { id: "kind", type: "choice", asks: "What kind of message is `ticket`?", options: ["bug_report", "none"], choice: "bug_report", confidence: 0.9, p: 0.9, probabilities: { bug_report: 0.9, none: 0.1 } },
    { id: "is_urgent", type: "noul", asks: "Is it urgent?", noul: 0.04, p: 0.96 },
  ]);
  const record = await (await fetch(`${base}/_/api/records/${summary!.id}`)).json() as { request: unknown; response: unknown };
  assert.deepEqual([record.request, record.response], [JSON.parse(jevBody), JSON.parse(jevAnswer)]);

  // a client that puts the vendor's name before its path lands under its run's label
  await fetch(`${base}/june/typesafe/v1/systemone`, { method: "POST", body: jevBody });
  assert.equal((await records(base)).records[1]!.label, "june");

  const database = join(dir, DATABASE);
  assert.ok(!readFileSync(database).includes("caller-secret"));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(database).mode & 0o777, 0o600);
});

test("a Jeview-Trigger header names the answer a request follows from: recorded and checked, never sent on, and the body goes as it came", async (t) => {
  const upstream = await jev(t, () => ({ body: jevAnswer }));
  const { base } = await proxy(t, upstream.url);
  const ask = (trigger?: string, path = "/v1/systemone") => fetch(`${base}${path}`, { method: "POST", headers: trigger === undefined ? {} : { "Jeview-Trigger": trigger, "Jeview-Anything": "ours" }, body: jevBody });

  const first = await (await ask()).json() as { events: Record<string, string> };
  assert.deepEqual(first.events, { kind: "1:kind", is_urgent: "1:is_urgent" });
  const second = await (await ask(first.events.is_urgent)).json() as { events: Record<string, string> };
  assert.deepEqual(second.events, { kind: "2:kind", is_urgent: "2:is_urgent" });
  // what Jev receives is the caller's body, byte for byte, and none of Jeview's own headers
  assert.deepEqual(upstream.seen.map((seen) => [seen.url, seen.body]), [["/v1/systemone", jevBody], ["/v1/systemone", jevBody]]);
  assert.deepEqual(upstream.seen.flatMap((seen) => Object.keys(seen.headers).filter((name) => name.startsWith("jeview-"))), []);

  for (const bad of ["", "x".repeat(201)]) {
    const refused = await ask(bad);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /trigger must be the event id of an earlier answer/);
  }
  assert.equal(upstream.seen.length, 2);
  assert.deepEqual((await records(base)).records.map((r) => [r.id, r.trigger]), [[1, null], [2, "1:is_urgent"]]);
  const record = await (await fetch(`${base}/_/api/records/2`)).json() as { request: unknown };
  assert.deepEqual(record.request, JSON.parse(jevBody));
  assert.deepEqual(((await (await fetch(`${base}/_/api/search?q=1:is_urgent`)).json()) as { ids: number[] }).ids, [2]);

  // with a run label in the path too
  await ask(first.events.kind, "/june/v1/systemone");
  const labelled = (await records(base)).records.at(-1)!;
  assert.deepEqual([labelled.label, labelled.trigger], ["june", "1:kind"]);
});

test("without a key a Jev request is refused and recorded; Jev's own refusals reach the caller as sent; nothing else is accepted", async (t) => {
  const upstream = await jev(t, () => ({ status: 429, headers: { "content-type": "application/json", "retry-after": "2" }, body: JSON.stringify({ error: "slow down" }) }));
  const { base, store } = await proxy(t, upstream.url, { key: null });
  const refused = await fetch(`${base}/v1/systemone`, { method: "POST", body: jevBody });
  assert.equal(refused.status, 401);
  assert.match(((await refused.json()) as { error: string }).error, /No Jev key: add one in the viewer's settings/);
  assert.equal(upstream.seen.length, 0);

  store.setSetting("jevKey", KEY);
  const busy = await fetch(`${base}/v1/systemone`, { method: "POST", body: jevBody });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "2");
  assert.deepEqual((await records(base)).records.map((r) => [r.status, r.error ?? null]), [[401, `No Jev key: add one in the viewer's settings at ${base}/`], [429, null]]);

  assert.equal((await fetch(`${base}/v1/systemone`)).status, 405);
  assert.equal((await fetch(`${base}/openrouter/api/v1/chat/completions`, { method: "POST", body: "{}" })).status, 405);
  assert.equal(upstream.seen.length, 1);
});

test("an unreachable Jev is a recorded 502, and the proxy refuses itself as Jev", async (t) => {
  const { base } = await proxy(t, "http://127.0.0.1:9/v1/systemone");
  const down = await fetch(`${base}/run/v1/systemone`, { method: "POST", body: jevBody });
  assert.equal(down.status, 502);
  const [summary] = (await records(base)).records;
  assert.deepEqual([summary!.status, summary!.label], [502, "run"]);
  assert.match(summary!.error ?? "", /Jev unreachable/);
  const selfDir = mkdtempSync(join(tmpdir(), "jeview-"));
  t.after(() => rmSync(selfDir, { recursive: true, force: true }));
  assert.throws(() => createJeview({ dir: selfDir, jevEndpoint: "http://localhost:4777/v1/systemone", port: 4777 }), /is this proxy/);
});

test("the viewer answers loopback hosts only, serves its page, and a non-JSON body is kept as sent", async (t) => {
  const upstream = await jev(t, () => ({ status: 400, body: "bad request" }));
  const { base } = await proxy(t, upstream.url);
  const port = new URL(base).port;
  const status = (host: string) => new Promise<number>((accept, reject) => httpRequest({ host: "127.0.0.1", port, path: "/_/api/records", headers: { host } }, (res) => { res.resume(); accept(res.statusCode ?? 0); }).on("error", reject).end());
  assert.equal(await status(`localhost:${port}`), 200);
  assert.equal(await status("attacker.example"), 403);
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(await page.text(), /<title>Jeview<\/title>/);
  assert.equal((await fetch(`${base}/_/ui/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await fetch(`${base}/_/ui/app.css`)).status, 200);
  assert.equal((await fetch(`${base}/_/ui/..%2Fjeview.ts`)).status, 404);

  await fetch(`${base}/v1/systemone`, { method: "POST", body: "not json" });
  const [summary] = (await records(base)).records;
  const record = await (await fetch(`${base}/_/api/records/${summary!.id}`)).json() as { request: unknown; response: unknown };
  assert.deepEqual([summary!.status, summary!.questions, record.request, record.response], [400, [], "not json", "bad request"]);
});

test("calls survive a restart in the database, ids continue, and search reads every request and answer", async (t) => {
  const upstream = await jev(t, () => ({ body: jevAnswer }));
  const dir = mkdtempSync(join(tmpdir(), "jeview-"));
  const first = createJeview({ dir, jevEndpoint: upstream.url });
  t.after(() => { first.server.close(); rmSync(dir, { recursive: true, force: true }); }); // cleaned up even if a step fails
  first.store.setSetting("jevKey", KEY);
  const firstBase = `http://127.0.0.1:${await listen(first.server)}`;
  await fetch(`${firstBase}/v1/systemone`, { method: "POST", body: jevBody });
  await fetch(`${firstBase}/v1/systemone`, { method: "POST", body: jevBody.replace("LOGIN broken", "Other_Thing 100%") });
  await new Promise((accept) => first.server.close(accept));

  const { base } = await proxy(t, upstream.url, { key: null, dir });
  assert.deepEqual((await records(base)).records.map((r) => r.id), [1, 2]);
  assert.equal((await records(base)).keyed, true); // the key is kept in the database too
  await fetch(`${base}/v1/systemone`, { method: "POST", body: jevBody });
  const listed = await records(base);
  assert.deepEqual(listed.records.map((r) => r.id), [1, 2, 3]);
  assert.equal(listed.records[0]!.stateKey, listed.records[2]!.stateKey);
  assert.notEqual(listed.records[0]!.stateKey, listed.records[1]!.stateKey);
  const search = async (q: string) => ((await (await fetch(`${base}/_/api/search?q=${encodeURIComponent(q)}`)).json()) as { ids: number[] }).ids;
  assert.deepEqual(await search("login"), [3, 1]);
  assert.deepEqual(await search("other_THING"), [2]);
  assert.deepEqual(await search("100%"), [2]); // % and _ are literal, not wildcards
  assert.deepEqual(await search("jev-2026-09 bug_report"), [3, 2, 1]);
  assert.deepEqual(await search(""), []);
});

test("the Jev key is set from the viewer only, never shown, and used by every call; llms.txt says how to connect", async (t) => {
  const upstream = await jev(t, () => ({ body: jevAnswer }));
  const { base } = await proxy(t, upstream.url, { key: null });
  const settings = async () => (await (await fetch(`${base}/_/api/settings`)).json()) as { jevKey: { set: boolean; ending: string | null } };
  const change = (value: unknown, headers: Record<string, string> = { origin: base, "content-type": "application/json" }) => fetch(`${base}/_/api/settings`, { method: "POST", headers, body: JSON.stringify(value) });
  assert.deepEqual(await settings(), { jevKey: { set: false, ending: null } });
  assert.match(await (await fetch(`${base}/llms.txt`)).text(), /not set yet, so calls are refused/);

  assert.equal((await change({ jevKey: "ts-live-0123456789abcd" }, { "content-type": "application/json" })).status, 403);
  assert.equal((await change({ jevKey: "ts-live-0123456789abcd" }, { origin: "http://attacker.example", "content-type": "application/json" })).status, 403);
  assert.equal((await change({ jevKey: "ts-live-0123456789abcd" }, { origin: base, "content-type": "text/plain" })).status, 415);
  assert.equal((await change({ jevKey: "short" })).status, 400);
  assert.equal((await change({ jevKey: "has a space in it" })).status, 400);
  const saved = await change({ jevKey: "ts-live-0123456789abcd" });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { jevKey: { set: true, ending: "abcd" } });
  assert.ok(!JSON.stringify(await settings()).includes("0123456789"));

  await fetch(`${base}/v1/systemone`, { method: "POST", headers: { authorization: "Bearer caller-key" }, body: jevBody });
  assert.equal(upstream.seen[0]!.headers.authorization, "Bearer ts-live-0123456789abcd");

  assert.deepEqual(await (await change({ jevKey: null })).json(), { jevKey: { set: false, ending: null } });
  assert.equal((await fetch(`${base}/v1/systemone`, { method: "POST", body: jevBody })).status, 401);
  assert.equal(upstream.seen.length, 1);
  await change({ jevKey: "ts-live-0123456789abcd" });
  const guide = await fetch(`${base}/llms.txt`);
  assert.equal(guide.headers.get("content-type"), "text/plain; charset=utf-8");
  const text = await guide.text();
  assert.ok(text.includes(`${base}/v1/systemone`) && text.includes(`${base}/<label>/v1/systemone`) && text.includes("Jeview-Trigger: <event id>") && text.includes("The Jev key: set."));
  assert.ok(!text.includes("0123456789"));
});

