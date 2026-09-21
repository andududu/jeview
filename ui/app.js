// Jeview. Jev sits in the centre; the questions it is asked sit around it, each labelled with the question itself;
// every answer a question can get sits beyond it, showing the probability Jev last gave it. A question asked after an
// answer (its request named that answer's event id as its trigger) grows as a branch off that answer. A call flies in
// from the edge and out along its whole path, drawing anything new as it passes. A question that has not been asked
// for a while fades off the map. The corner lists recent calls and reads one question at a time; a call opens in the
// drawer, with the answer that triggered it and the calls it led to.
"use strict";
(() => {
  const INVALID = "\u0000invalid", POLL_MS = 1000, TAU = Math.PI * 2, FADE_AFTER = 2000, GONE_AFTER = 10000, LAYER_LINGER = 5000, HOLD_GONE = 6000, RECENT = 80;
  const $ = (selector) => document.querySelector(selector);
  const SVG = "http://www.w3.org/2000/svg";
  function h(tag, attrs, ...children) {
    const node = tag.startsWith("svg:") ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (name === "class") node.setAttribute("class", value);
      else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of children.flat(Infinity)) if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : String(child));
    return node;
  }
  const human = (value) => String(value).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const kindOf = (id) => id.replace(/_\d+$/, "");
  /** A question in plain words: `company_guidance` reads as "company guidance", `rows[0].text` as "rows 1 text". */
  const plainQuestion = (asks) => String(asks ?? "").replace(/`([^`]+)`/g, (_, path) => human(path.replace(/\[(\d+)\]/g, (m, n) => ` ${Number(n) + 1} `).replace(/\./g, " "))).replace(/\s+([?,.])/g, "$1").trim();
  const clip = (value, n) => value.length > n ? value.slice(0, n - 1).trimEnd() + "…" : value;
  const questionOf = (q) => plainQuestion(q.asks) || human(kindOf(q.id));
  const pct = (n) => `${Math.round(n * 100)}%`;
  const money = (n) => "$" + (n === 0 ? "0" : n < 0.01 ? n.toPrecision(2) : n.toFixed(2));
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  const text = (value) => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  const seconds = (ms) => ms === null ? "–" : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const median = (values) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const finished = (record) => Date.parse(record.at) + (record.elapsedMs || 0);
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  function ago(time) {
    const s = Math.max(0, (Date.now() - time) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${Math.round(s)} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(time).toLocaleDateString();
  }
  /** The answer dot an answer lands on: a choice's option, yes or no for a yes/no, the nearest level for a ranking. */
  function landing(q) {
    if (q.choice !== undefined) return q.choice;
    if (q.noul !== undefined) return q.noul >= 0.5 ? "yes" : "no";
    if (q.score !== undefined) return `level ${Math.round(q.score)}`;
    return null;
  }
  /** An answer in its own terms, in a few words. */
  function answerWords(q) {
    if (q.choice !== undefined) return q.choice === "none" ? "none of the options" : human(q.choice);
    if (q.noul !== undefined) return `${pct(q.noul)} yes`;
    if (q.score !== undefined) return `${q.score.toFixed(2)}${q.levels ? ` of ${q.levels - 1}` : ""}`;
    return "no answer";
  }
  const typeWords = (q) => q.type === "choice" ? `Pick one${q.options ? ` of ${q.options.length} options` : ""}` : q.type === "noul" ? "Yes or no, as a probability" : q.type === "score" ? `A ranking${q.levels ? ` on ${q.levels} levels` : ""}` : "Question";
  const failed = (record) => record.status !== 200 || !!record.error;
  const hash = (value) => { let x = 2166136261; for (const c of String(value)) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return (x >>> 0) / 4294967296; };

  // ---------- data ----------
  // per-viewer toggles, remembered in this browser when it lets us
  const remembered = (name, fallback) => { try { const value = localStorage.getItem(`jeview.${name}`); return value === null ? fallback : value === "1"; } catch { return fallback; } };
  const remember = (name, on) => { try { localStorage.setItem(`jeview.${name}`, on ? "1" : "0"); } catch { /* not remembered, still applied */ } };
  const data = { records: [], byId: new Map(), cursor: 0, meta: null, run: null, full: new Map(), selected: null, focus: null, tab: "recent", clock: 0, traces: remembered("traces", true), colours: remembered("colours", true), dedupe: remembered("dedupe", false) };
  const visible = (record) => data.run === null || record.label === data.run;
  const eventOf = (record, q) => `${record.id}:${q.id}`;
  /** The call and question an event id names, when that call is here. */
  function eventCall(event) {
    const call = event ? data.byId.get(Number(String(event).split(":")[0])) : undefined;
    return call ? { call, q: call.questions.find((q) => eventOf(call, q) === event) } : null;
  }
  async function fullRecord(id) {
    if (!data.full.has(id)) { const response = await fetch(`/_/api/records/${id}`); if (!response.ok) throw Error(`Call ${id} could not be read`); data.full.set(id, await response.json()); }
    return data.full.get(id);
  }

  // ---------- the map model: questions and the answers they got ----------
  // Every question and answer is a body: a box around its dot and its text, centred on (x, y). Jev is a fixed body.
  const world = { kinds: new Map(), events: new Map(), families: new Map(), lineages: new Map(), jev: { x: 0, y: 0, w: 76, h: 76, fixed: true }, area: { l: 0, t: 0, r: 0, b: 0 }, shown: "" };
  /** How present a question is: 1 while it is being asked, then fading gradually from FADE_AFTER without a request
   * until it is gone at GONE_AFTER. Time is the latest activity, not the wall clock, so a finished run keeps its
   * final picture instead of emptying. */
  // the wall clock while calls are coming in (so fades run smoothly between polls), held once they stop
  const clockNow = () => Math.min(Date.now(), data.clock + 1500);
  function presence(kind, now = clockNow()) {
    const later = LAYER_LINGER * (kind.depth ?? 0); // every layer of a tree lingers five seconds longer
    const t = clamp((now - kind.lastSeen - FADE_AFTER - later) / (GONE_AFTER - FADE_AFTER), 0, 1);
    const own = 1 - t * t * (3 - 2 * t); // smoothstep: a soft start and a soft end
    return kind.kids?.size ? Math.max(own, ...[...kind.kids].map((kid) => presence(kid, now))) : own; // a question stays while a branch off it does
  }
  const present = () => [...world.kinds.values()].filter((kind) => presence(kind) > 0);
  /** What the layout keeps room for: everything on show, and what faded out in the last few seconds, so the rest
   * stays where it is for a while before the map tidies up. */
  const held = (kind) => presence(kind, clockNow() - HOLD_GONE) > 0;
  const kept = () => [...world.kinds.values()].filter(held);
  /** A question on the map. A question asked after an answer (its request named that answer as its trigger) is a
   * branch off that answer: the same question after "no" and after "yes" are two nodes. With Deduplicate on they are
   * one node, reached from each answer that led to it. */
  function node(q, when, parent = null) {
    const option = landing(q);
    if (option === null) return null;
    const name = kindOf(q.id), key = !parent ? name : data.dedupe ? `${parent.kind.key}>${name}` : `${parent.kind.key}>${parent.name}>${name}`;
    let kind = world.kinds.get(key);
    if (!kind) {
      const from = parent ?? world.jev;
      kind = { key, name, parent, parents: new Set(), depth: parent ? parent.kind.depth + 1 : 0, kids: new Set(), type: q.type, count: 0, options: new Map(), asked: [], x: from.x, y: from.y, w: 0, h: 0, r: 0, asks: "", lastSeen: when, placed: false, revealed: false };
      world.kinds.set(key, kind); parent?.kind.kids.add(kind);
      if (kind.depth === 1) { // a new branch off a first-asked question: that question's colour family, the next shade of it
        const root = parent.kind.key;
        if (!world.families.has(root)) world.families.set(root, { family: world.families.size % 6, branches: 0 });
        const family = world.families.get(root);
        world.lineages.set(key, { family: family.family, shade: 1 + family.branches++ }); // the family's own colour is the root's
      }
    }
    if (parent) kind.parents.add(parent); // every answer that led here; the first is the one it grows from
    if (q.asks) kind.asks = plainQuestion(q.asks); // the latest wording of this question
    if (!held(kind)) { kind.placed = false; for (const b of [kind, ...kind.options.values()]) b.tx = b.ty = undefined; } // coming back long after it went: a fresh spot
    kind.lastSeen = Math.max(kind.lastSeen, when);
    for (let up = parent; up; up = up.kind.parent) up.kind.lastSeen = Math.max(up.kind.lastSeen, when); // the path to a branch stays on the map
    data.clock = Math.max(data.clock, when);
    if (!kind.placed) place(kind);
    for (const name of candidates(q)) candidate(kind, name);
    return { kind, option: candidate(kind, option), q, via: parent ?? undefined };
  }
  /** The answer node a call's trigger names, when that answer is on the map. */
  function parentOf(record) {
    const event = record.trigger ? world.events.get(record.trigger) : undefined;
    return event ? candidate(event.kind, event.name) : null;
  }
  /** Where each of a call's answers lands, and each answer's event id remembered for the calls it may trigger. */
  function targetsOf(record) {
    const parent = data.traces ? parentOf(record) : null, when = finished(record); // traces off: every question straight off Jev
    return record.questions.map((q) => {
      const target = node(q, when, parent);
      if (target) world.events.set(eventOf(record, q), { kind: target.kind, name: target.option.name });
      return target;
    }).filter(Boolean);
  }
  /** The one Invalid dot: every call Jev rejected lands here. It sits in the ring like a question, with no answers. */
  function invalidNode(when) {
    let node = world.kinds.get(INVALID);
    if (!node) { node = { key: INVALID, name: INVALID, parent: null, depth: 0, special: "invalid", count: 0, ids: [], options: new Map(), x: world.jev.x, y: world.jev.y, w: 0, h: 0, r: 0, asks: "Invalid", lastSeen: when, placed: false, revealed: false }; world.kinds.set(INVALID, node); }
    if (!held(node)) { node.placed = false; node.tx = node.ty = undefined; }
    node.lastSeen = Math.max(node.lastSeen, when); data.clock = Math.max(data.clock, when);
    if (!node.placed) place(node);
    return node;
  }
  const refuse = (record, node) => { node.count++; node.ids.push(record.id); };
  /** The answers a question can get, shown before Jev picks them: a choice's options (when there are few enough to
   * read), yes and no, or a ranking's levels. A choice with many options shows only those Jev actually gives. */
  function candidates(q) {
    if (q.noul !== undefined || q.type === "noul") return ["yes", "no"];
    if (q.score !== undefined || q.type === "score") return q.levels ? Array.from({ length: q.levels }, (_, i) => `level ${i}`) : [];
    return q.options && q.options.length <= MAX_CANDIDATES ? q.options : [];
  }
  function candidate(kind, name) {
    let answer = kind.options.get(name);
    if (!answer) { answer = { name, kind, count: 0, ids: [], x: kind.x, y: kind.y, w: 0, h: 0, r: 0, revealed: false }; kind.options.set(name, answer); placeAnswer(answer); }
    return answer;
  }
  /** The probability Jev gave one answer in one call: every option of a choice or level of a ranking, both sides of a yes/no. */
  function probabilityOf(q, name) {
    if (q.noul !== undefined) return name === "yes" ? q.noul : name === "no" ? 1 - q.noul : null;
    const key = q.score !== undefined ? name.replace(/^level /, "") : name;
    if (q.probabilities && typeof q.probabilities[key] === "number") return q.probabilities[key];
    return name === landing(q) ? landedP(q) : null;
  }
  /** The probability Jev gave the answer it landed on (older records carry only the confidence). */
  const landedP = (q) => q.p ?? (q.noul !== undefined ? Math.max(q.noul, 1 - q.noul) : q.confidence ?? null);
  /** A body appears when the ball reaches it; `born` times its growing in. */
  function reveal(body, now = performance.now()) { if (!body.revealed) { body.revealed = true; body.born = now; } }
  function land(record, target) {
    target.kind.count++; target.option.count++; target.option.ids.push(record.id); target.kind.asked.push({ q: target.q, record });
    for (const o of target.kind.options.values()) { const p = probabilityOf(target.q, o.name); if (p !== null) o.latest = p; } // the latest spread across every answer
  }
  /** A new answer lights its dot up; it cools back over two seconds, whatever lands after it. */
  const bump = (option) => { option.hot = performance.now(); };
  function rebuild() {
    if (world.kinds.size) saveLayout(); // what is on show now, for when it comes back
    world.kinds.clear(); world.events.clear(); world.families.clear(); world.lineages.clear(); particles.length = 0; pulses.length = 0; data.clock = 0;
    for (const record of data.records.filter(visible)) {
      if (failed(record)) { refuse(record, invalidNode(finished(record))); continue; }
      for (const target of targetsOf(record)) land(record, target);
    }
    layout();
    // the same history always gives the same picture: questions go round in the order they first appeared, at their
    // final sizes, and start where they belong
    const kinds = present(), roots = kinds.filter((kind) => !kind.parent);
    roots.forEach((kind, i) => { const angle = -Math.PI / 2 + (i * TAU) / roots.length; kind.x = world.jev.x + Math.cos(angle) * reach(); kind.y = world.jev.y + Math.sin(angle) * reach(); kind.placed = true; });
    for (const kind of kinds.filter((k) => k.parent).sort((a, b) => a.depth - b.depth)) place(kind);
    for (const kind of kinds) for (const o of kind.options.values()) placeAnswer(o);
    measure(true); arrange(!restoreLayout()); // where it all last sat, and room found nearby for anything new
    for (const kind of kinds) for (const b of [kind, ...kind.options.values()]) { b.x = b.tx; b.y = b.ty; b.revealed = kind.count > 0; b.born = undefined; }
  }
  /** The free area for the map: clear of the corner, the header and footer, and an open drawer on a wide screen. */
  function layout() {
    const wide = innerWidth > 1100, drawerOpen = document.getElementById("drawer").classList.contains("open") && innerWidth > 900;
    const area = { l: wide ? 388 : 12, t: 72, r: innerWidth - (drawerOpen ? Math.min(460, innerWidth) : 0) - 16, b: innerHeight - (wide ? 56 : Math.min(innerHeight * 0.38, 320) + 70) };
    const dx = (area.l + area.r) / 2 - world.jev.x, dy = (area.t + area.b) / 2 - world.jev.y;
    world.area = area; world.jev.x += dx; world.jev.y += dy;
    for (const kind of world.kinds.values()) for (const b of [kind, ...kind.options.values()]) { b.x += dx; b.y += dy; if (b.tx !== undefined) { b.tx += dx; b.ty += dy; } } // the map moves as one
  }
  const reach = () => Math.min(world.area.r - world.area.l, world.area.b - world.area.t) * 0.34;
  /** A new question goes into the widest gap around Jev; a branch starts just beyond the answer that led to it. */
  function place(kind) {
    if (kind.parent) {
      const a = kind.parent, angle = Math.atan2(a.y - a.kind.y, a.x - a.kind.x);
      kind.x = a.x + Math.cos(angle) * 90; kind.y = a.y + Math.sin(angle) * 90; kind.placed = true;
      return;
    }
    const others = kept().filter((k) => k !== kind && k.placed && !k.parent).map((k) => Math.atan2(k.y - world.jev.y, k.x - world.jev.x)).sort((a, b) => a - b);
    let angle = -Math.PI / 2 + (hash(kind.name) - 0.5) * 0.6;
    if (others.length) {
      let best = -1;
      others.forEach((a, i) => { const next = i + 1 < others.length ? others[i + 1] : others[0] + TAU, gap = next - a; if (gap > best) { best = gap; angle = a + gap / 2; } });
    }
    kind.x = world.jev.x + Math.cos(angle) * reach() * 0.6; kind.y = world.jev.y + Math.sin(angle) * reach() * 0.6; kind.placed = true;
  }
  /** A new answer starts just beyond its question, away from Jev. */
  function placeAnswer(option) {
    const k = option.kind, from = k.parent ?? world.jev, dx = k.x - from.x, dy = k.y - from.y, d = Math.hypot(dx, dy) || 1, spread = (hash(option.name) - 0.5) * 1.4;
    const angle = Math.atan2(dy / d, dx / d) + spread;
    option.x = k.x + Math.cos(angle) * 70; option.y = k.y + Math.sin(angle) * 70;
  }

  // ---------- sizes and the slow shuffle ----------
  const Q_R = 6, Q_SIZE = 12.5, Q_LINE = 16.5, A_SIZE = 11.5, ANSWER_R = 13, INVALID_R = 11, MAX_CANDIDATES = 8, COOL_MS = 2000;
  function textWidth(textValue, size, weight) { ctx.font = `${weight} ${size}px ${colors.body}`; return ctx.measureText(textValue).width; }
  function wrap(textValue, width, maxLines, size, weight) {
    ctx.font = `${weight} ${size}px ${colors.body}`;
    const lines = []; let line = "";
    for (const word of textValue.split(/\s+/)) { const next = line ? `${line} ${word}` : word; if (line && ctx.measureText(next).width > width) { lines.push(line); line = word; } else line = next; }
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…"; }
    return lines;
  }
  /** Grow dots towards their counts and size each box to its dot and its text: at most three lines for a question. */
  function measure(snap = false) {
    const grow = snap ? 1 : 0.12;
    const width = innerWidth < 720 ? 120 : 160;
    for (const kind of present()) {
      if (kind.special) {
        kind.r += (INVALID_R - kind.r) * grow; kind.R = INVALID_R;
        if (kind.wrapKey !== colors.body) { kind.lines = ["Invalid"]; kind.textW = textWidth("Invalid", Q_SIZE, 400); kind.wrapKey = colors.body; }
        kind.w = Math.max(kind.R * 2, kind.textW) + 10; kind.h = kind.R * 2 + 6 + Q_LINE + 4;
        continue;
      }
      kind.r += (Q_R - kind.r) * grow; kind.R = Q_R;
      const key = `${kind.asks}|${width}|${colors.body}`;
      if (kind.wrapKey !== key) { kind.lines = wrap(kind.asks || human(kind.name), width, 3, Q_SIZE, 400); kind.textW = Math.max(...kind.lines.map((l) => textWidth(l, Q_SIZE, 400))); kind.wrapKey = key; }
      kind.w = Math.max(kind.R * 2, kind.textW) + 10; kind.h = kind.R * 2 + 6 + kind.lines.length * Q_LINE + 4;
      for (const o of kind.options.values()) {
        o.r += (ANSWER_R - o.r) * grow; o.R = ANSWER_R; // one size for every answer, reserved before it shows: it carries its latest probability
        const labelText = clip(human(o.name), 28), okey = `${labelText}|${colors.body}`;
        if (o.labelKey !== okey) { o.label = labelText; o.labelW = textWidth(labelText, A_SIZE, 400); o.labelKey = okey; }
        o.w = Math.max(o.R * 2, o.labelW) + 8; o.h = o.R * 2 + 4 + 16;
      }
    }
  }
  const dot = (body) => [body.x, body.y - body.h / 2 + (body.R ?? body.r)]; // where a body's dot sits in its box
  const GAP_X = 12, GAP_Y = 8, CLUSTER_X = 30, CLUSTER_Y = 22, ANSWER_OUT = 34, BRANCH_OUT = 44, NEAR = 10, TURNS = [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]; // something new looks this many 14px steps round where it belongs before the map re-arranges

  /** Where everything should sit. Worked out only when the picture changes (a question comes or goes, an answer or a
   * branch is added, a box outgrows its spot); the bodies then ease there and stay still.
   *
   * Everything already on the map keeps its spot. Something new looks for room close to where it belongs: a first
   * question in its gap round Jev, a branch onward from the answer that led to it, an answer fanned beyond its
   * question. Only when there is no room nearby does the whole map re-arrange: the questions asked first evenly
   * spaced round Jev in the order they already stand, branches outward, parents first, each box stepping out until
   * it clears every box already placed, so nothing overlaps. The view then fits the whole map. */
  /** Where a branch grows from: the answers that led to it (one, or with Deduplicate several), and onward in their
   * direction from their question. Null until they have spots. */
  function anchor(k) {
    const ps = [...k.parents].filter((a) => a.tx !== undefined);
    if (!ps.length) return null;
    const x = ps.reduce((n, a) => n + a.tx, 0) / ps.length, y = ps.reduce((n, a) => n + a.ty, 0) / ps.length, q = k.parent.kind;
    return { x, y, angle: Math.atan2(y - q.ty, x - q.tx), h: Math.max(...ps.map((a) => a.h)) };
  }
  /** The direction a question faces: away from Jev, or from the answers that led to it. */
  function awayAngle(k) {
    const at = k.parent ? anchor(k) : null;
    return Math.atan2(k.ty - (at ? at.y : world.jev.y), k.tx - (at ? at.x : world.jev.x));
  }
  /** An answer's direction from its question: fanned round the way the question faces. */
  const fanOf = (k, o) => { const options = [...k.options.keys()], n = options.length, fan = Math.min(0.55, 1.6 / Math.max(n, 1)); return k.angle + (options.indexOf(o.name) - (n - 1) / 2) * fan; };
  function arrange(full = false) {
    const kinds = kept(), roots = kinds.filter((k) => !k.parent), jev = world.jev;
    world.arranged = shape(); world.unsaved = true;
    if (!kinds.length) return;
    jev.tx = jev.x; jev.ty = jev.y;
    const placed = [jev];
    const cluster = (body) => body.kind ?? body, apart = (o, b) => cluster(o) !== cluster(b); // a question and its answers are one cluster
    const hits = (b) => placed.some((o) => Math.abs(o.tx - b.tx) < (o.w + b.w) / 2 + (apart(o, b) ? CLUSTER_X : GAP_X) && Math.abs(o.ty - b.ty) < (o.h + b.h) / 2 + (apart(o, b) ? CLUSTER_Y : GAP_Y));
    /** The nearest free spot to where a box belongs: a step further out each time, trying a little either side of its
     * direction at each distance before going further, so a crowded answer settles beside its question instead of
     * running off along one line. False when there is none within that many steps. */
    const out = (b, x, y, angle, from, steps = 80, turns = TURNS) => {
      for (let step = 0; step < steps; step++) for (const turn of turns) {
        b.tx = x + Math.cos(angle + turn) * (from + step * 14); b.ty = y + Math.sin(angle + turn) * (from + step * 14);
        if (!hits(b)) { b.from = [x, y]; placed.push(b); return true; }
      }
      b.from = [x, y]; placed.push(b); return false;
    };
    // a question moved by hand stays where it was put, and its answers fan out on its far side
    for (const k of kinds) if (k.pin) { k.tx = jev.tx + k.pin.dx; k.ty = jev.ty + k.pin.dy; k.angle = awayAngle(k); placed.push(k); }
    const pinned = placed.length;
    if (full || !settle()) {
      placed.length = pinned;
      world.pace = world.bounds ? 0.035 : 0.06; // a whole re-arrange eases over slowly
      // a question, then its answers fanned beyond it, each stepping out until clear
      const put = (k, x, y, angle, from) => { if (!k.pin) { k.angle = angle; out(k, x, y, angle, from); } for (const o of k.options.values()) out(o, k.tx, k.ty, fanOf(k, o), (k.h + o.h) / 2 + ANSWER_OUT); };
      // the questions asked first: evenly spaced round Jev, in the order they already stand, turned as little as possible
      const angleOf = (k) => Math.atan2(k.y - jev.y, k.x - jev.x);
      roots.sort((a, b) => angleOf(a) - angleOf(b));
      const slice = TAU / Math.max(roots.length, 1);
      let sx = 0, sy = 0;
      roots.forEach((k, i) => { sx += Math.cos(angleOf(k) - i * slice); sy += Math.sin(angleOf(k) - i * slice); });
      const turn = roots.length > 1 ? Math.atan2(sy, sx) : roots.length ? angleOf(roots[0]) : 0;
      roots.forEach((k, i) => { if (!k.pin) { k.angle = turn + i * slice; out(k, jev.tx, jev.ty, k.angle, reach(), 80, [0]); } for (const o of k.options.values()) out(o, k.tx, k.ty, fanOf(k, o), (k.h + o.h) / 2 + ANSWER_OUT); }); // a first question keeps its place in the circle
      // branches, parents first: onward from the answer that led to them, in that answer's direction; siblings side by side
      const branches = kinds.filter((k) => k.parent).sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : 1));
      for (const k of branches) {
        const at = anchor(k) ?? { x: k.parent.x, y: k.parent.y, angle: Math.atan2(k.parent.y - k.parent.kind.y, k.parent.x - k.parent.kind.x), h: k.parent.h }, siblings = branches.filter((b) => b.parent === k.parent), i = siblings.indexOf(k);
        const angle = at.angle + (i - (siblings.length - 1) / 2) * 0.45; // on in the answer's own direction, so sibling branches spread
        put(k, at.x, at.y, angle, (at.h + k.h) / 2 + BRANCH_OUT);
      }
    } else world.pace = 0.06;
    let l = jev.tx - jev.w / 2, r = jev.tx + jev.w / 2, t = jev.ty - jev.h / 2, b = jev.ty + jev.h / 2;
    for (const body of placed) { l = Math.min(l, body.tx - body.w / 2); r = Math.max(r, body.tx + body.w / 2); t = Math.min(t, body.ty - body.h / 2); b = Math.max(b, body.ty + body.h / 2); }
    world.bounds = { l, r, t, b };

    /** Everything keeps its spot; what is new, or has outgrown its spot, takes the nearest free one close to where it
     * belongs. False when something finds no room nearby. */
    function settle() {
      const near = (body, x, y, angle, from) => out(body, x, y, angle, from, NEAR);
      /** A spot left behind: what it hangs off has moved (or it was remembered from another arrangement), and it is now
       * further from it than it could have been put. A first question can sit anywhere round Jev. */
      const strayed = (body) => {
        const at = body.kind ? { x: body.kind.tx, y: body.kind.ty, h: body.kind.h } : body.parent ? anchor(body) : null;
        if (!at) return false;
        const moved = !body.from || Math.hypot(at.x - body.from[0], at.y - body.from[1]) > 40;
        return moved && Math.hypot(body.tx - at.x, body.ty - at.y) > (at.h + body.h) / 2 + (body.kind ? ANSWER_OUT : BRANCH_OUT) + NEAR * 14 + 40;
      };
      const order = [...kinds].sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : 1)), fresh = [], moving = new Set();
      for (const k of order) {
        // a question moves when it is new, overlaps, has strayed, or the answer it grows from is moving; its answers move with it
        const goes = !k.pin && (k.tx === undefined || [...(k.parents ?? [])].some((a) => moving.has(a)) || hits(k) || strayed(k));
        if (goes) { fresh.push(k); moving.add(k); } else if (!k.pin) placed.push(k);
        for (const o of k.options.values()) {
          if (!goes && o.tx !== undefined && !hits(o) && !strayed(o)) placed.push(o);
          else { fresh.push(o); moving.add(o); }
        }
      }
      for (const body of fresh) {
        if (!body.kind) { // a question: round Jev, or onward from the answer that led to it
          const at = body.parent ? anchor(body) : null;
          if (body.parent && !at) return false;
          body.angle = at ? at.angle : Math.atan2(body.y - jev.y, body.x - jev.x);
          if (!(at ? near(body, at.x, at.y, body.angle, (at.h + body.h) / 2 + BRANCH_OUT) : near(body, jev.tx, jev.ty, body.angle, reach()))) return false;
        } else { // an answer, fanned beyond its question
          const k = body.kind;
          if (k.tx === undefined) return false;
          k.angle ??= Math.atan2(k.ty - jev.ty, k.tx - jev.tx);
          if (!near(body, k.tx, k.ty, fanOf(k, body), (k.h + body.h) / 2 + ANSWER_OUT)) return false;
        }
      }
      return true;
    }
  }
  // ---------- the layout, remembered in this browser across reloads ----------
  const LAYOUT = "jeview.layout", LAYOUT_MAX = 1000;
  const bodyKey = (b) => (b.kind ? `${b.kind.key}::${b.name}` : b.key);
  function savedLayout() { try { return new Map(Object.entries(JSON.parse(localStorage.getItem(LAYOUT) ?? "{}"))); } catch { return new Map(); } }
  /** Each spot as an offset from Jev, so a different window size moves the map as one; a hand-placed question is marked. */
  function saveLayout() {
    world.unsaved = false;
    const saved = savedLayout();
    for (const k of kept()) for (const b of [k, ...k.options.values()]) {
      if (b.tx === undefined) continue;
      const key = bodyKey(b);
      saved.delete(key); saved.set(key, [Math.round(b.tx - world.jev.x), Math.round(b.ty - world.jev.y), b.pin ? 1 : 0]); // newest last
    }
    while (saved.size > LAYOUT_MAX) saved.delete(saved.keys().next().value);
    try { localStorage.setItem(LAYOUT, JSON.stringify(Object.fromEntries(saved))); } catch { /* not remembered, still drawn */ }
  }
  /** Put everything back where it last sat. How many spots came back. */
  function restoreLayout() {
    const saved = savedLayout();
    let restored = 0;
    for (const k of kept()) for (const b of [k, ...k.options.values()]) {
      const spot = saved.get(bodyKey(b));
      if (!spot) continue;
      b.tx = world.jev.x + spot[0]; b.ty = world.jev.y + spot[1]; restored++;
      if (spot[2] && !b.kind) b.pin = { dx: spot[0], dy: spot[1] };
    }
    return restored;
  }
  addEventListener("pagehide", () => { if (world.kinds.size) saveLayout(); });

  /** What the arrangement depends on: which questions and answers are on the map, and the space for it. */
  const shape = () => `${kept().map((k) => `${k.key}:${[...k.options.keys()].join(",")}`).join("|")}#${Math.round(world.area.l)},${Math.round(world.area.r)},${Math.round(world.area.b)}`;
  /** Re-arrange only when the picture changed, or when boxes have grown since (a dot growing in, a longer label). */
  function keepArranged(now) {
    if (world.arranged !== shape()) return arrange();
    if (now - (world.checked ?? 0) < 1000) return;
    world.checked = now;
    const size = kept().reduce((n, k) => n + k.w + k.h + [...k.options.values()].reduce((m, o) => m + o.w + o.h, 0), 0);
    if (Math.abs(size - (world.size ?? 0)) > 8) { world.size = size; arrange(); }
    if (world.unsaved) saveLayout(); // at most once a second
  }
  /** Ease every body towards where it should sit; nothing moves once it is there. */
  function glide() {
    for (const b of present().flatMap((k) => [k, ...k.options.values()])) {
      if (!b.revealed) { b.x = b.tx ?? b.x; b.y = b.ty ?? b.y; continue; } // not on show yet: wait where it will appear
      b.x += ((b.tx ?? b.x) - b.x) * (world.pace ?? 0.06); b.y += ((b.ty ?? b.y) - b.y) * (world.pace ?? 0.06);
    }
  }

  // ---------- motion: calls fly in, answers fly out ----------
  const particles = [], pulses = [], motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  let flash = 0;
  const lerp = (a, b, t) => a + (b - a) * t, ease = (t) => 1 - Math.pow(1 - t, 3);
  function bend(ax, ay, bx, by, amount) { const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay; return [mx - dy * amount, my + dx * amount]; }
  function at(p, u) {
    const pts = p.path(), seg = Math.min(pts.length - 1, Math.floor(u * pts.length)), t = u * pts.length - seg, [a, c, b] = pts[seg];
    return [lerp(lerp(a[0], c[0], t), lerp(c[0], b[0], t), t), lerp(lerp(a[1], c[1], t), lerp(c[1], b[1], t), t)];
  }
  // every path runs from Jev: to a first question, or on through each answer that led to a branch
  const leg = (from, to, amount) => [from, bend(from[0], from[1], to[0], to[1], amount), to];
  // `via` is the answer a call came through, for a question more than one answer leads to; otherwise its first
  const legsTo = (kind, via = kind.parent) => via ? [...legsTo(via.kind), leg(dot(via.kind), dot(via), 0.1), leg(dot(via), dot(kind), 0)] : [leg([world.jev.x, world.jev.y], dot(kind), 0)];
  const stopsTo = (kind, via = kind.parent) => via ? [...stopsTo(via.kind), via, kind] : [kind];
  const legs = (kind, option, via) => [...legsTo(kind, via), leg(dot(kind), dot(option), 0.1)];
  function fly(record, delay) {
    const invalid = failed(record) ? invalidNode(finished(record)) : null;
    const targets = invalid ? [] : targetsOf(record);
    const angle = hash(record.trigger ?? record.id) * TAU, far = Math.hypot(innerWidth, innerHeight) / 2 + 20;
    const from = [world.jev.x + Math.cos(angle) * far, world.jev.y + Math.sin(angle) * far], curve = hash(record.id) > 0.5 ? 0.18 : -0.18;
    particles.push({
      start: performance.now() + delay, duration: 900, tone: failed(record) ? "red" : "ink",
      path: () => { const core = [world.jev.x, world.jev.y]; return [[from, bend(from[0], from[1], core[0], core[1], curve), core]]; },
      done: () => {
        flash = performance.now();
        if (invalid) {
          particles.push({ start: performance.now(), duration: 800, tone: "red", invalid, kind: invalid, path: () => legsTo(invalid),
            done: () => { refuse(record, invalid); reveal(invalid); bump(invalid); pulses.push({ at: () => dot(invalid), start: performance.now(), tone: "red", r: 8 }); renderCorner(); } });
          return;
        }
        targets.forEach((target, i) => particles.push({ // along the whole path, revealing each new stop as it passes
          start: performance.now() + i * 70, duration: 500 * (stopsTo(target.kind, target.via).length + 1), tone: "ink", kind: target.kind, target, stops: [...stopsTo(target.kind, target.via), target.option], path: () => legs(target.kind, target.option, target.via),
          done: () => {
            land(record, target); reveal(target.kind); reveal(target.option); bump(target.option);
            for (const o of target.kind.options.values()) if (!o.revealed && o.revealAt === undefined) o.revealAt = performance.now() + 500; pulses.push({ at: () => dot(target.option), start: performance.now(), tone: "ink", r: 6 }); renderCorner(); },
        }));
      },
    });
  }
  function arrive(records) {
    const animate = motion && !document.hidden;
    records.forEach((record, i) => {
      if (!visible(record)) return;
      if (animate && i >= records.length - 40) fly(record, (i - Math.max(0, records.length - 40)) * 90);
      else if (failed(record)) { const invalid = invalidNode(finished(record)); refuse(record, invalid); reveal(invalid); bump(invalid); }
      else for (const target of targetsOf(record)) { land(record, target); for (const b of [...stopsTo(target.kind, target.via), ...target.kind.options.values()]) reveal(b); bump(target.option); }
    });
  }

  // ---------- drawing ----------
  const canvas = $("#map"), ctx = canvas.getContext("2d"), empty = $("#empty");
  let colors = {}, hover = null;
  // the view over the map: the wheel zooms towards the pointer, a drag pans, a double click resets
  const view = { k: 1, x: 0, y: 0, user: !remembered("autozoom", true) };
  /** Until someone zooms or pans, the view eases to fit the whole map into the free area. */
  function fit() {
    const B = world.bounds, A = world.area;
    if (view.user || !B || hover) return; // never moves under the pointer
    const k = clamp(Math.min((A.r - A.l) / (B.r - B.l + 40), (A.b - A.t) / (B.b - B.t + 40)), 0.35, 1);
    const x = (A.l + A.r) / 2 - ((B.l + B.r) / 2) * k, y = (A.t + A.b) / 2 - ((B.t + B.b) / 2) * k;
    const pace = k < view.k - 0.001 ? 0.06 : 0.025; // room for something new straight away; closing in after things go, gently
    view.k += (k - view.k) * pace; view.x += (x - view.x) * pace; view.y += (y - view.y) * pace;
  }
  const toWorld = (x, y) => [(x - view.x) / view.k, (y - view.y) / view.k];
  // shades within one colour family: lighter or darker, turned a little; measured at least 7 (OKLab ×100) apart in both modes
  const SHADES = [[0, 0], [-0.12, 16], [0.12, -16], [-0.2, -12], [0.2, 12], [0.02, -30]];
  /** A hex colour moved in OKLCH lightness (dL) and hue (dh degrees), brought into sRGB by easing its chroma. */
  function shade(hex, [dL, dh]) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4), srgb = (c) => clamp(c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055, 0, 1);
    const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(m[1].slice(i, i + 2), 16) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = clamp(0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s + dL, 0.32, 0.86), A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
    const h = Math.atan2(B, A) + (dh * Math.PI) / 180;
    const rgb = (C) => {
      const a = C * Math.cos(h), bb = C * Math.sin(h);
      const [l3, m3, s3] = [L + 0.3963377774 * a + 0.2158037573 * bb, L - 0.1055613458 * a - 0.0638541728 * bb, L - 0.0894841775 * a - 1.291485548 * bb].map((x) => x ** 3);
      return [4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3, -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3, -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3];
    };
    let C = Math.hypot(A, B), out = rgb(C);
    while (out.some((c) => c < -0.0005 || c > 1.0005) && C > 0.001) out = rgb((C *= 0.97)); // less saturated until the screen can show it, rather than clipped
    return `#${out.map((c) => Math.round(srgb(c) * 255).toString(16).padStart(2, "0")).join("")}`;
  }
  function readColors() {
    const css = getComputedStyle(document.documentElement), v = (name) => css.getPropertyValue(name).trim();
    colors = { families: [1, 2, 3, 4, 5, 6].map((i) => SHADES.map((step) => shade(v(`--tree-${i}`), step))), paper: v("--paper"), ink: v("--ink"), muted: v("--muted"), dull: v("--dull"), hairline: v("--hairline"), strong: v("--hairline-strong"), accent: v("--accent"), glow: v("--glow"), red: v("--red"), body: v("--body"), display: v("--display"), aura: v("--aura") };
  }
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout();
  }
  const tone = (name) => ({ ink: colors.ink, red: colors.red, accent: colors.accent }[name] ?? colors.ink);
  function stroke(path) { ctx.beginPath(); ctx.moveTo(path[0][0][0], path[0][0][1]); for (const [, c, b] of path) ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); ctx.stroke(); }
  /** Text with a thin halo of the paper colour, so the lines behind it stop at the words. */
  function write(value, x, y) { ctx.lineJoin = "round"; ctx.lineWidth = 4; ctx.strokeStyle = colors.paper; ctx.strokeText(value, x, y); ctx.fillText(value, x, y); }
  /** A plate of the page's colour under a label, so a line passing behind it stops at the words. */
  function plate(x, top, width, height) { const fill = ctx.fillStyle; ctx.fillStyle = colors.paper; ctx.beginPath(); ctx.roundRect(x - width / 2 - 4, top, width + 8, height, 4); ctx.fill(); ctx.fillStyle = fill; }
  function lines(list, x, top, size, color, weight) {
    ctx.font = `${weight} ${size}px ${colors.body}`; ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    plate(x, top, Math.max(...list.map((line) => ctx.measureText(line).width)), list.length * Q_LINE);
    list.forEach((line, i) => write(line, x, top + (i + 0.5) * Q_LINE));
  }
  /** A call's paths: from Jev, through each answer that led to it, to each answer it got. */
  function callPaths(id) {
    const record = data.byId.get(id), paths = [], via = record && data.traces ? parentOf(record) ?? undefined : undefined;
    for (const q of record?.questions ?? []) {
      const event = world.events.get(eventOf(record, q)), option = event?.kind.options.get(event.name);
      if (option?.revealed && presence(event.kind) > 0) paths.push({ kind: event.kind, option, via: event.kind.parents?.has(via) ? via : undefined });
    }
    return paths;
  }
  /** A tree's tint: the question it grew from wears its colour family, and each branch off it a shade of that family,
   * shared by everything that grows from the branch. A question nothing has branched from stays in ink, and so does
   * everything with Colours off. */
  function tint(kind) {
    if (!data.colours) return null;
    if (kind.depth === 0) { const family = world.families.get(kind.key); return family ? colors.families[family.family][0] : null; }
    let k = kind;
    while (k.depth > 1) k = k.parent.kind;
    const lineage = world.lineages.get(k.key);
    return lineage ? colors.families[lineage.family][lineage.shade % SHADES.length] : null;
  }
  const heat = (option, now) => option.hot === undefined ? 0 : clamp(1 - (now - option.hot) / COOL_MS, 0, 1);
  function draw(now) {
    measure();
    keepArranged(now);
    glide();
    fit();
    const names = present().map((k) => k.key).join("|");
    if (names !== world.shown) { world.shown = names; renderCorner(); }
    const { x: cx, y: cy } = world.jev, A = world.area;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.k, view.k);
    const kinds = present();
    // a quiet ticked rim around the map
    const rim = Math.min(A.r - A.l, A.b - A.t) / 2 + 12;
    ctx.lineWidth = 1; ctx.strokeStyle = colors.hairline;
    for (let i = 0; i < 120; i++) { const a = (i / 120) * TAU, long = i % 10 === 0 ? 7 : 3; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * rim, cy + Math.sin(a) * rim); ctx.lineTo(cx + Math.cos(a) * (rim + long), cy + Math.sin(a) * (rim + long)); ctx.stroke(); }

    const chain = data.selected ? callPaths(data.selected.id) : [];
    const lit = new Set(chain.flatMap((p) => [...stopsTo(p.kind, p.via), p.option]));
    const light = (kind) => { lit.add(kind); for (const o of kind.options.values()) lit.add(o); };
    const hovered = hover?.kind === "question" ? hover.node : hover?.kind === "answer" ? hover.node.kind : null; // the Invalid dot fades nothing
    if (hovered) { lit.clear(); light(hovered); } // hovering a question: it and its answers, everything else fades
    else if (data.focus && world.kinds.has(data.focus)) light(world.kinds.get(data.focus));
    for (const k of [...lit]) if (k.options) for (const up of stopsTo(k)) lit.add(up); // a lit branch lights the way to it
    const born = (body) => body.born === undefined ? 1 : clamp((now - body.born) / 350, 0, 1); // growing in after its ball arrives
    const alpha = (item, kind) => presence(kind) * born(item) * (lit.size && !lit.has(item) ? 0.14 : 1);
    // lines: into each question (from Jev, or from the answer that led to it), and out to its answers
    for (const kind of kinds) {
      if (!kind.revealed) continue;
      if (kind.special) { ctx.strokeStyle = colors.red; ctx.lineWidth = 1; ctx.globalAlpha = alpha(kind, kind) * 0.45; stroke(legsTo(kind)); continue; }
      const hue = tint(kind);
      ctx.strokeStyle = hue ?? colors.strong; ctx.lineWidth = 1; ctx.globalAlpha = alpha(kind, kind) * (hue ? 0.55 : 1);
      if (kind.parents?.size) { for (const a of kind.parents) if (a.revealed) stroke([leg(dot(a), dot(kind), 0)]); } // from every answer that led here
      else stroke([legsTo(kind).at(-1)]);
      for (const o of kind.options.values()) {
        if (!o.revealed) continue;
        ctx.globalAlpha = alpha(o, kind) * (0.45 + 0.55 * heat(o, now)) * (hue ? 0.55 : 1); ctx.lineWidth = 0.8;
        stroke([legs(kind, o).at(-1)]);
      }
    }
    // a ball on its way to something new draws the line behind it
    ctx.strokeStyle = colors.strong; ctx.lineWidth = 1;
    for (const p of particles) {
      const u = (now - p.start) / p.duration;
      if (p.invalid && !p.invalid.revealed && u > 0 && u < 1) {
        ctx.globalAlpha = 0.6; ctx.strokeStyle = colors.red; ctx.beginPath();
        for (let t = 0; t <= ease(u); t += 0.02) { const [x, y] = at(p, t); t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.stroke(); ctx.strokeStyle = colors.strong;
        continue;
      }
      if (!p.stops || u <= 0 || u >= 1) continue;
      const e = ease(u), n = p.stops.length;
      p.stops.forEach((stop, i) => { if (i < n - 1 && !stop.revealed && e >= (i + 1) / n) reveal(stop, now); }); // passing through it
      const first = p.stops.findIndex((stop) => !stop.revealed);
      if (first < 0) continue;
      const from = first / n;
      if (e <= from) continue;
      ctx.globalAlpha = presence(p.target.kind) * (hovered && p.kind !== hovered ? 0.14 : 1);
      ctx.beginPath();
      for (let t = from; t <= e; t += 0.02) { const [x, y] = at(p, Math.min(t, e)); t === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.lineTo(...at(p, e)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // the open call: its whole path from Jev, in the one orange, its answers ringed
    if (chain.length && !hovered) {
      ctx.globalAlpha = 1; ctx.strokeStyle = colors.accent; ctx.lineWidth = 1.8;
      for (const p of chain) stroke(legs(p.kind, p.option, p.via));
      for (const p of chain) { const [ox, oy] = dot(p.option); ctx.fillStyle = colors.accent; ctx.globalAlpha = 0.22; ctx.beginPath(); ctx.arc(ox, oy, p.option.r + 7, 0, TAU); ctx.fill(); }
      ctx.globalAlpha = 1;
    }
    // calls in flight, each with a short fading tail: on the lines, under the questions and answers
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i], u = (now - p.start) / p.duration;
      if (u < 0) continue;
      if (u >= 1) { particles.splice(i, 1); p.done(); continue; }
      const e = ease(u);
      for (let k = 7; k >= 0; k--) {
        const [x, y] = at(p, Math.max(0, e - k * 0.018));
        ctx.globalAlpha = (1 - k / 8) * 0.9 * (hovered && p.kind !== hovered ? 0.14 : 1); ctx.fillStyle = tone(p.tone);
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, 2.6 - k * 0.28), 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    // questions: a dot and up to three lines of the question
    for (const kind of kinds) {
      if (!kind.revealed) continue;
      if (kind.special) { // the Invalid dot: red, with how many calls Jev rejected
        const hot = heat(kind, now), [ix, iy] = dot(kind), r = kind.r * (0.6 + 0.4 * presence(kind)) * ease(born(kind)) * (1 + 0.22 * ease(hot));
        ctx.globalAlpha = alpha(kind, kind) * (0.6 + 0.4 * hot); ctx.fillStyle = colors.red; ctx.beginPath(); ctx.arc(ix, iy, r, 0, TAU); ctx.fill();
        ctx.font = `600 ${(9.5 * r) / INVALID_R}px ${colors.body}`; ctx.fillStyle = colors.paper; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(kind.count), ix, iy + 0.5);
        ctx.globalAlpha = alpha(kind, kind); lines(kind.lines, kind.x, iy + kind.R + 6, Q_SIZE, colors.red, 400);
        continue;
      }
      const [kx, ky] = dot(kind), fade = presence(kind), r = kind.r * (0.6 + 0.4 * fade) * ease(born(kind));
      ctx.globalAlpha = alpha(kind, kind); ctx.fillStyle = colors.paper; ctx.strokeStyle = tint(kind) ?? colors.ink; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(kx, ky, r, 0, TAU); ctx.fill(); ctx.stroke();
      if (data.focus === kind.key) { ctx.strokeStyle = colors.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(kx, ky, r + 4, 0, TAU); ctx.stroke(); }
      if (kind !== hovered) lines(kind.lines, kind.x, ky + kind.R + 6, Q_SIZE, colors.ink, 400);
    }
    // answers: a dot sized by how often it came back, and its name
    for (const kind of kinds) {
      for (const o of kind.options.values()) {
        if (!o.revealed && o.revealAt !== undefined && now >= o.revealAt) reveal(o, now);
        if (!o.revealed || o.r < 0.5) continue;
        const hot = heat(o, now), [ox, oy] = dot(o), r = o.r * (0.6 + 0.4 * presence(kind)) * ease(born(o)) * (1 + 0.22 * ease(hot));
        if (hot > 0) {
          ctx.globalAlpha = alpha(o, kind) * hot;
          const aura = ctx.createRadialGradient(ox, oy, r * 0.6, ox, oy, r * 3);
          aura.addColorStop(0, colors.aura); aura.addColorStop(1, "transparent");
          ctx.fillStyle = aura; ctx.beginPath(); ctx.arc(ox, oy, r * 3, 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = alpha(o, kind) * (0.45 + 0.55 * hot);
        ctx.fillStyle = tint(kind) ?? colors.ink; ctx.beginPath(); ctx.arc(ox, oy, r, 0, TAU); ctx.fill();
        // the probability shrinks and grows with its dot
        if (typeof o.latest === "number" && r > ANSWER_R * 0.45) { ctx.font = `600 ${(9.5 * r) / ANSWER_R}px ${colors.body}`; ctx.fillStyle = colors.paper; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(pct(o.latest), ox, oy + 0.5); }
        ctx.globalAlpha = alpha(o, kind) * (0.7 + 0.3 * hot);
        ctx.font = `400 ${A_SIZE}px ${colors.body}`; ctx.fillStyle = lit.has(o) || hot > 0.5 ? colors.ink : colors.muted; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        plate(o.x, oy + o.R + 4 + 8 - 8, o.labelW, 16); write(o.label, o.x, oy + o.R + 4 + 8);
      }
    }
    ctx.globalAlpha = 1;
    // landings
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i], t = (now - p.start) / 900, [px, py] = p.at();
      if (t >= 1) { pulses.splice(i, 1); continue; }
      ctx.strokeStyle = tone(p.tone); ctx.globalAlpha = (1 - t) * 0.8 * (hovered ? 0.3 : 1); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(px, py, p.r + ease(t) * 18, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Jev, above the calls flying in and out of it
    const since = now - flash, breathe = (Math.sin(now / 900) + 1) / 2;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, 34 + breathe * 6);
    halo.addColorStop(0, colors.glow); halo.addColorStop(1, "transparent");
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, 40 + breathe * 6, 0, TAU); ctx.fill();
    if (since < 700) { const t = since / 700; ctx.strokeStyle = colors.accent; ctx.globalAlpha = 1 - t; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, 10 + ease(t) * 34, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.fillStyle = colors.accent; ctx.beginPath(); ctx.arc(cx, cy, 8 + (since < 300 ? (1 - since / 300) * 3 : 0), 0, TAU); ctx.fill();
    ctx.font = `italic 300 15px ${colors.display}`; ctx.fillStyle = colors.ink; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText("Jev", cx, cy + 16);
    ctx.restore();
    if (hovered) card(hovered);
    if (!empty.hidden) { empty.style.left = `${view.x + world.jev.x * view.k}px`; empty.style.top = `${view.y + world.jev.y * view.k + 56}px`; } // under the Jev dot
    requestAnimationFrame(draw);
  }

  /** The hovered question, whole, on a card above everything else: right beside its dot, on the side its line comes
   * in from (its answers fan out the other way). Drawn on the screen, so it reads the same at any zoom. */
  function card(kind) {
    const [kx, ky] = dot(kind), [fx, fy] = kind.parent ? dot(kind.parent) : [world.jev.x, world.jev.y];
    const sx = view.x + kx * view.k, sy = view.y + ky * view.k, sr = kind.R * view.k + 8;
    const full = wrap(kind.asks || human(kind.name), 260, 12, 13, 400), note = kind.pin ? "Click to reset position" : "";
    const w = Math.max(...full.map((l) => textWidth(l, 13, 400)), note ? textWidth(note, 11.5, 400) : 0) + 24, hgt = full.length * 17 + 18 + (note ? 18 : 0);
    const dx = fx - kx, dy = fy - ky;
    let x, y;
    if (Math.abs(dx) > Math.abs(dy)) { x = dx < 0 ? sx - sr - w : sx + sr; y = sy - hgt / 2; }
    else { x = sx - w / 2; y = dy < 0 ? sy - sr - hgt : sy + sr; }
    x = clamp(x, 12, innerWidth - 12 - w); y = clamp(y, 12, innerHeight - 12 - hgt);
    ctx.fillStyle = colors.paper; ctx.strokeStyle = colors.strong; ctx.lineWidth = 1; ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.roundRect(x, y, w, hgt, 10); ctx.fill(); ctx.stroke();
    ctx.font = `400 13px ${colors.body}`; ctx.fillStyle = colors.ink; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    full.forEach((line, i) => ctx.fillText(line, x + 12, y + 9 + (i + 0.5) * 17));
    if (note) { ctx.font = `400 11.5px ${colors.body}`; ctx.fillStyle = colors.dull; ctx.fillText(note, x + 12, y + 9 + (full.length + 0.5) * 17 + 2); }
  }

  // ---------- hover and click on the map ----------
  const inside = (body, x, y, pad = 4) => Math.abs(x - body.x) <= body.w / 2 + pad && Math.abs(y - body.y) <= body.h / 2 + pad;
  function nodeAt(x, y) {
    if (Math.hypot(world.jev.x - x, world.jev.y - y) < 18) return { node: world.jev, kind: "jev" };
    for (const kind of present()) {
      if (kind.special) { if (kind.revealed && inside(kind, x, y)) return { node: kind, kind: "invalid" }; continue; }
      for (const o of kind.options.values()) if (o.revealed && inside(o, x, y)) return { node: o, kind: "answer" };
      if (kind.revealed && inside(kind, x, y)) return { node: kind, kind: "question" };
    }
    return null;
  }
  const tip = $("#tip");
  function showTip(x, y, ...content) { tip.replaceChildren(...content); tip.hidden = false; const w = tip.offsetWidth, hgt = tip.offsetHeight; tip.style.left = `${Math.min(innerWidth - w - 8, x + 14)}px`; tip.style.top = `${Math.max(8, y - hgt - 12)}px`; }
  function hideTip() { tip.hidden = true; }
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    view.user = true; showToggles();
    const k = clamp(view.k * Math.exp(-event.deltaY * 0.0015), 0.2, 4);
    view.x = event.clientX - (event.clientX - view.x) * (k / view.k); view.y = event.clientY - (event.clientY - view.y) * (k / view.k); view.k = k;
  }, { passive: false });
  let drag = null;
  canvas.addEventListener("pointerdown", (event) => {
    const [wx, wy] = toWorld(event.clientX, event.clientY), hit = nodeAt(wx, wy), node = hit?.kind === "question" ? hit.node : null; // a question is picked up, anything else pans
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false, node, grab: node ? [node.x - wx, node.y - wy] : null };
  });
  addEventListener("pointerup", () => {
    if (drag?.moved) canvas.style.cursor = "default";
    if (drag?.moved && drag.node) world.arranged = null; // dropped: its answers and anything under it find room
    setTimeout(() => { drag = null; });
  });
  /** A question moved by hand: it stays where it is put, and its answers swing round to its far side as it goes. */
  function carry(k, event) {
    const [wx, wy] = toWorld(event.clientX, event.clientY), x = wx + drag.grab[0], y = wy + drag.grab[1];
    k.pin = { dx: x - world.jev.x, dy: y - world.jev.y }; k.x = k.tx = x; k.y = k.ty = y; k.angle = awayAngle(k);
    for (const o of k.options.values()) { const a = fanOf(k, o), d = (k.h + o.h) / 2 + ANSWER_OUT; o.tx = x + Math.cos(a) * d; o.ty = y + Math.sin(a) * d; o.from = [x, y]; }
    hover = { node: k, kind: "question" }; world.unsaved = true;
  }
  /** Back to where the map would put it. */
  function release(k) {
    delete k.pin;
    for (const b of [k, ...k.options.values()]) b.tx = b.ty = undefined;
    world.arranged = null;
  }
  canvas.addEventListener("dblclick", () => { view.user = false; showToggles(); }); // back to fitting the whole map
  // zoom in and out about the middle of the map; back to Jev, in the middle
  const middle = () => [(world.area.l + world.area.r) / 2, (world.area.t + world.area.b) / 2];
  function zoomBy(factor) {
    const [mx, my] = middle(), k = clamp(view.k * factor, 0.2, 4);
    view.user = true; showToggles();
    view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k;
  }
  $("#zoom-in").addEventListener("click", () => zoomBy(1.25));
  $("#arrange").addEventListener("click", () => { for (const k of world.kinds.values()) delete k.pin; arrange(true); }); // tidy it all afresh, hand-moved questions too
  $("#zoom-out").addEventListener("click", () => zoomBy(0.8));
  $("#centre").addEventListener("click", () => { const [mx, my] = middle(); view.user = true; showToggles(); view.x = mx - world.jev.x * view.k; view.y = my - world.jev.y * view.k; });
  // the layout menu's switches: traces (chains as branches, or everything straight off Jev), deduplicate, colours and auto zoom
  function showToggles() { for (const [id, on] of [["traces", data.traces], ["dedupe", data.dedupe], ["colours", data.colours], ["autozoom", !view.user]]) $(`#${id}`).setAttribute("aria-checked", String(on)); }
  $("#traces").addEventListener("click", () => { data.traces = !data.traces; remember("traces", data.traces); showToggles(); rebuild(); renderCorner(true); });
  $("#dedupe").addEventListener("click", () => { data.dedupe = !data.dedupe; remember("dedupe", data.dedupe); showToggles(); rebuild(); renderCorner(true); });
  $("#colours").addEventListener("click", () => { data.colours = !data.colours; remember("colours", data.colours); showToggles(); });
  $("#autozoom").addEventListener("click", () => { view.user = !view.user; remember("autozoom", !view.user); showToggles(); });
  showToggles();
  canvas.addEventListener("pointermove", (event) => {
    if (drag && (drag.moved || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4)) {
      drag.moved = true; canvas.style.cursor = "grabbing"; hideTip();
      if (drag.node) return carry(drag.node, event);
      view.user = true; showToggles();
      view.x = drag.vx + event.clientX - drag.x; view.y = drag.vy + event.clientY - drag.y;
      return;
    }
    hover = nodeAt(...toWorld(event.clientX, event.clientY));
    canvas.style.cursor = hover?.kind === "question" ? "grab" : hover ? "pointer" : "default";
    if (!hover || hover.kind === "question") return hideTip(); // a hovered question shows itself whole on the map
    if (hover.kind === "invalid") showTip(event.clientX, event.clientY, h("b", {}, "Invalid"), ` · ${plural(hover.node.count, "call")} Jev rejected`, h("div", { class: "sub" }, "Click to see them"));
    else if (hover.kind === "jev") showTip(event.clientX, event.clientY, h("b", {}, "Jev"), h("div", { class: "sub" }, `${plural(data.records.filter(visible).length, "call")} so far`));
    else { const o = hover.node; showTip(event.clientX, event.clientY, h("b", {}, human(o.name)), ` · chosen ${plural(o.count, "time")}`, h("div", { class: "sub" }, `${typeof o.latest === "number" ? `Jev's latest probability ${pct(o.latest)}. ` : ""}${o.count ? "Click for the calls behind it" : ""}`)); }
  });
  canvas.addEventListener("pointerleave", () => { hover = null; hideTip(); });
  canvas.addEventListener("click", (event) => {
    if (drag?.moved) return; // the end of a pan, not a click
    const hit = nodeAt(...toWorld(event.clientX, event.clientY));
    if (!hit) { if (drawer.classList.contains("open")) closeDrawer(); else focus(null); return; }
    if (hit.kind === "invalid") openList("Invalid calls", "Calls Jev rejected, newest first", [...hit.node.ids].reverse());
    else if (hit.kind === "answer") openList(human(hit.node.name), `${plural(hit.node.count, "time")} the answer to: ${hit.node.kind.asks || human(hit.node.kind.name)}`, [...hit.node.ids].reverse());
    else if (hit.kind === "question") { if (hit.node.pin) release(hit.node); else focus(hit.node.key); } // moved by hand: a click puts it back
    else { data.tab = "recent"; data.focus = null; renderCorner(true); }
  });

  // ---------- the corner: recent calls, and one question at a time ----------
  const corner = $("#corner");
  function focus(key) { data.focus = key; if (key) data.tab = "questions"; renderCorner(true); }
  /** Where a branch grows from, in words: "after no to <question>". */
  const after = (kind) => {
    if (!kind.parent) return "";
    const answers = [...kind.parents].map((a) => `“${human(a.name)}”`), shown = answers.slice(0, 3).join(" or ") + (answers.length > 3 ? ` or ${answers.length - 3} more` : "");
    return `after ${shown} to ${clip(kind.parent.kind.asks || human(kind.parent.kind.name), 48)}`;
  };
  function bins(values, count, lo, hi) { const b = new Array(count).fill(0); for (const v of values) b[Math.min(count - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * count)))]++; return b; }
  /** A small histogram: thin bars, the tallest at full height; each bar says its range and count on hover. */
  function histogram(counts, labelOf, height = 56) {
    const top = Math.max(1, ...counts), width = 300, gap = 2, bar = (width - gap * (counts.length - 1)) / counts.length;
    return h("svg:svg", { class: "hist", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img", "aria-label": counts.map((n, i) => `${labelOf(i)}: ${n}`).join(", ") },
      counts.map((n, i) => { const barHeight = n ? Math.max(2, (n / top) * (height - 2)) : 0; return h("svg:g", { "data-tip": `${labelOf(i)}: ${plural(n, "answer")}` },
        h("svg:rect", { x: i * (bar + gap), y: 0, width: bar, height, class: "hit" }),
        n ? h("svg:rect", { x: i * (bar + gap), y: height - barHeight, width: bar, height: barHeight, rx: 1.5, class: "bar" }) : h("svg:rect", { x: i * (bar + gap), y: height - 1, width: bar, height: 1, class: "base" })); }));
  }
  function share(name, count, total, ids, extra) {
    return h("button", { class: "share", onclick: () => ids.length && openList(human(name), `${plural(count, "time")} the answer to: ${world.kinds.get(data.focus)?.asks ?? ""}`, [...ids].reverse()) },
      h("span", { class: "name" }, human(name), extra ? h("small", {}, extra) : null), h("span", { class: "n" }, `${count} · ${pct(total ? count / total : 0)}`),
      h("span", { class: "track" }, h("i", { style: `width:${total ? (count / total) * 100 : 0}%` })));
  }
  function questionStats(key) {
    const kind = world.kinds.get(key), rows = kind?.asked ?? [], latest = rows.at(-1)?.q;
    const back = h("button", { class: "back", onclick: () => focus(null) }, "← All questions");
    if (!latest) return [back, h("p", { class: "quiet" }, "No answers yet.")];
    const calls = [...new Set(rows.map((r) => r.record))];
    const head = [back, h("p", { class: "eyebrow" }, typeWords(latest)), h("h3", { class: "stats-q" }, questionOf(latest)), kind.parent ? h("p", { class: "stats-meta" }, `Asked ${after(kind)}`) : null,
      h("p", { class: "stats-meta" }, `Asked ${plural(rows.length, "time")} · last ${ago(finished(rows.at(-1).record))} · median ${seconds(median(calls.map((c) => c.elapsedMs)))} per call`)];
    const byAnswer = (option) => rows.filter((r) => landing(r.q) === option).map((r) => r.record.id);
    const confidence = rows.map((r) => r.q.confidence).filter((c) => typeof c === "number");
    const confidenceBlock = confidence.length ? [h("p", { class: "chart-label" }, `Jev's confidence · median ${pct(median(confidence))}`), histogram(bins(confidence, 10, 0, 1), (i) => `${i * 10}–${i * 10 + 10}%`), h("div", { class: "axis" }, h("span", {}, "0%"), h("span", {}, "100%"))] : [];
    if (latest.type === "noul") {
      const p = rows.map((r) => r.q.noul), yes = p.filter((v) => v >= 0.5).length;
      return [head, h("p", { class: "chart-label" }, `Jev's probability of yes · mean ${pct(p.reduce((a, b) => a + b, 0) / p.length)}`),
        histogram(bins(p, 10, 0, 1), (i) => `${i * 10}–${i * 10 + 10}% yes`), h("div", { class: "axis" }, h("span", {}, "0%, no"), h("span", {}, "100%, yes")),
        h("div", { class: "shares" }, share("yes", yes, p.length, byAnswer("yes"), "above 50%"), share("no", p.length - yes, p.length, byAnswer("no"), "below 50%"))];
    }
    if (latest.type === "score") {
      const levels = latest.levels ?? Math.max(...rows.map((r) => Math.ceil(r.q.score))) + 1, scores = rows.map((r) => r.q.score), per = 4, span = Math.max(1, levels - 1);
      return [head, h("p", { class: "chart-label" }, `Where the scores fall · mean ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)}`),
        histogram(bins(scores, span * per, 0, span), (i) => `${(i / per).toFixed(2)}–${((i + 1) / per).toFixed(2)}`), h("div", { class: "axis" }, Array.from({ length: levels }, (_, i) => h("span", {}, `level ${i}`))),
        h("div", { class: "shares" }, Array.from({ length: levels }, (_, i) => share(`level ${i}`, byAnswer(`level ${i}`).length, rows.length, byAnswer(`level ${i}`), "nearest level"))), confidenceBlock];
    }
    const offered = [...new Set([...(latest.options ?? []), ...(kind ? kind.options.keys() : [])])];
    const counts = offered.map((option) => [option, byAnswer(option)]).sort((a, b) => b[1].length - a[1].length);
    return [head, h("p", { class: "chart-label" }, "How often each option came back"), h("div", { class: "shares" }, counts.map(([option, ids]) => share(option, ids.length, rows.length, ids))), confidenceBlock];
  }
  function questionList() {
    const kinds = [...world.kinds.values()].filter((k) => k.count && !k.special).sort((a, b) => presence(b) - presence(a) || b.count - a.count);
    return kinds.length ? h("ol", { class: "qlist" }, kinds.map((kind) => h("li", { class: presence(kind) > 0 ? "" : "idle" }, h("button", { onclick: () => focus(kind.key) },
      h("span", { class: "qtext" }, kind.asks || human(kind.name)),
      kind.parent ? h("span", { class: "qmeta" }, after(kind)) : null,
      h("span", { class: "qmeta" }, `${plural(kind.count, "answer")} · ${plural(kind.options.size, "outcome")}${presence(kind) > 0 ? "" : " · idle"}`))))) : h("p", { class: "quiet" }, "Questions appear here as calls come in.");
  }
  function recentRow(record) {
    const q = record.questions.find((item) => landing(item) !== null);
    return h("li", { "data-id": record.id, class: data.selected?.id === record.id ? "here" : "" }, h("button", { onclick: () => openCall(record.id) },
      h("span", { class: "what" }, h("span", { class: `mark-dot${failed(record) ? " failed" : ""}` }), h("span", {}, headline(record))),
      h("span", { class: "when", "data-at": finished(record) }, ago(finished(record))),
      h("span", { class: "sub" }, failed(record) ? "Jev rejected the call" : [q ? answerWords(q) : "no answer", ...record.questions.filter((item) => item !== q).slice(0, 2).map(answerWords)].join(" · ") + (record.questions.length > 3 ? ` · +${record.questions.length - 3}` : ""))));
  }
  /** New calls pile onto the top of the recent list without redrawing the rows already there. */
  function pileUp(records) {
    const list = corner.querySelector(".recent");
    if (data.tab !== "recent" || !list) return;
    for (const record of records.filter(visible)) list.prepend(recentRow(record));
    while (list.children.length > RECENT) list.lastChild.remove();
    const shown = data.records.filter(visible);
    corner.querySelector("#n-recent").textContent = shown.length.toLocaleString();
    corner.querySelector("#totals").textContent = totals(shown);
  }
  const totals = (shown) => `${plural(shown.length, "call")} · median ${seconds(median(shown.map((r) => r.elapsedMs)))} · ${money(shown.reduce((sum, r) => sum + (r.cost || 0), 0))}`;
  let cornerKey = "";
  function renderCorner(force = false) {
    const shown = data.records.filter(visible), labels = [...new Set(data.records.map((r) => r.label))];
    const key = `${data.tab}|${data.focus}|${data.run}|${shown.length}|${[...world.kinds.values()].reduce((n, k) => n + k.count, 0)}|${world.shown}`;
    if (!force && key === cornerKey) return;
    if (!force && data.tab === "recent" && cornerKey.startsWith(`recent|${data.focus}|${data.run}|`)) { cornerKey = key; return; } // pileUp keeps the list current
    cornerKey = key;
    const scroll = corner.querySelector(".corner-body")?.scrollTop ?? 0; // redraws while calls stream in keep the reader's place
    const tab = (name, words, count) => h("button", { class: "tab", "aria-pressed": String(data.tab === name), onclick: () => { data.tab = name; if (name === "recent") data.focus = null; renderCorner(true); } }, words, h("span", { class: "count", id: `n-${name}` }, count));
    const chip = (value, name) => h("button", { class: "chip", "aria-pressed": String(data.run === value), onclick: () => { data.run = value; rebuild(); closeDrawer(); renderCorner(true); } }, name);
    corner.replaceChildren(h("div", { class: "corner-inner" },
      h("div", { class: "tabs" }, tab("recent", "Recent", shown.length.toLocaleString()), tab("questions", "Questions", [...world.kinds.values()].filter((k) => k.count && !k.special).length)),
      h("p", { class: "stats-meta", id: "totals" }, totals(shown)),
      labels.length > 1 ? h("div", { class: "chips" }, chip(null, "All runs"), labels.map((l) => chip(l, l || "No label"))) : null,
      h("div", { class: "corner-body" }, data.tab === "recent"
        ? (shown.length ? h("ol", { class: "list recent" }, shown.slice(-RECENT).reverse().map(recentRow)) : h("p", { class: "quiet" }, "Calls pile up here as they come in."))
        : data.focus ? questionStats(data.focus) : questionList())));
    const bodyEl = corner.querySelector(".corner-body");
    if (bodyEl && !force) bodyEl.scrollTop = scroll;
  }
  setInterval(() => { for (const el of corner.querySelectorAll("[data-at]")) el.textContent = ago(Number(el.dataset.at)); }, 5000);

  // ---------- the drawer: one call, or the calls behind one answer ----------
  const drawer = $("#drawer"), body = $("#drawer-body");
  // h() flattens lists and drops empty parts, which replaceChildren would print as text
  function openDrawer(...content) { body.replaceChildren(h("div", {}, content)); drawer.classList.add("open"); drawer.inert = false; drawer.setAttribute("aria-hidden", "false"); drawer.scrollTop = 0; layout(); }
  // where you have been in the drawer, newest last, for Back; it starts afresh each time the drawer opens
  const trail = [];
  let here = null;
  function visit(view, back) {
    if (!back && here && drawer.classList.contains("open") && JSON.stringify(here) !== JSON.stringify(view)) trail.push(here);
    here = view; $("#back").hidden = !trail.length;
  }
  $("#back").addEventListener("click", () => { const view = trail.pop(); if (view) view.call ? openCall(view.call, true) : openList(...view.list, true); });
  function closeDrawer() { trail.length = 0; here = null; $("#back").hidden = true; drawer.classList.remove("open"); drawer.inert = true; drawer.setAttribute("aria-hidden", "true"); data.selected = null; markSelected(); layout(); }
  function markSelected() { for (const li of corner.querySelectorAll(".recent li")) li.classList.toggle("here", Number(li.dataset.id) === data.selected?.id); }
  $("#close").addEventListener("click", closeDrawer);
  addEventListener("keydown", (event) => { if (event.key === "Escape") { closeDrawer(); $("#search").hidden = true; for (const [b, p] of POPOVERS) { $(p).hidden = true; $(b).setAttribute("aria-expanded", "false"); } } if (event.key === "/" && document.activeElement?.tagName !== "INPUT") { event.preventDefault(); openSearch(); } });

  /** When a call was made: the time today, or the day and time before that. */
  function clock(at) {
    const when = new Date(at), today = when.toDateString() === new Date().toDateString();
    return today ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : when.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function headline(record) { const first = record.questions[0]; return first ? clip(questionOf(first), 110) : "A call Jev could not read"; }
  function brief(record) {
    const q = record.questions.find((item) => landing(item) !== null);
    if (failed(record) || !q) return [h("span", { class: "mark-dot failed" }), h("span", {}, clip(headline(record), 58), " ", h("b", {}, failed(record) ? "→ failed" : "→ no answer"))];
    return [h("span", { class: "mark-dot" }), h("span", {}, clip(questionOf(q), 58), " ", h("b", {}, `→ ${answerWords(q)}`), record.questions.length > 1 ? ` +${record.questions.length - 1}` : "")];
  }
  function openList(title, subtitle, ids, back = false) {
    visit({ list: [title, subtitle, ids] }, back);
    data.selected = null; markSelected();
    const records = ids.map((id) => data.byId.get(id)).filter(Boolean);
    openDrawer(h("p", { class: "eyebrow" }, "Calls"), h("h2", { class: "d-title" }, title), h("p", { class: "d-meta" }, subtitle),
      records.length ? h("ol", { class: "list" }, records.slice(0, 300).map((record) => h("li", {}, h("button", { onclick: () => openCall(record.id) },
        h("span", { class: "what" }, brief(record)), h("span", { class: "when" }, ago(finished(record))),
        h("span", { class: "sub" }, [record.label || "no run label", `call ${record.id}`].join(" · ")))))) : h("p", { class: "quiet" }, "Nothing here yet."));
  }

  /** The question in plain words: a `field` it points at reads as the field's name. Extra context sits behind a toggle. */
  function questionText(instructions, words = true) {
    const object = instructions && typeof instructions === "object" && !Array.isArray(instructions);
    const rest = object ? Object.entries(instructions).filter(([key]) => key !== "question") : [];
    return [words ? plainQuestion(text(object ? instructions.question ?? "" : instructions)) : null, rest.length ? h("details", { class: "more" }, h("summary", {}, "Context in the question"), doc(Object.fromEntries(rest))) : null];
  }
  const meter = (value, words) => h("div", { class: "conf" }, h("span", { class: "meter" }, h("i", { style: `width:${pct(value)}` })), words);
  function options(list) {
    return list.length ? h("details", { class: "more" }, h("summary", {}, `All ${list.length} ${list[0].level ? "levels" : "options"}`),
      list.map((o) => h("div", { class: `option${o.chosen ? " chosen" : ""}` },
        h("span", { class: "name" }, o.name, o.description ? h("small", {}, text(o.description)) : null),
        h("span", { class: "p" }, typeof o.p === "number" ? pct(o.p) : "–"),
        h("span", { class: "track" }, h("i", { style: `width:${typeof o.p === "number" ? o.p * 100 : 0}%` }))))) : null;
  }
  /** One question's answer. In a call with one question the title already asks it, so it is not repeated; in a call
   * with several, each is numbered. */
  function answerBlock(question, answer, alone, n) {
    const type = question?.type, parts = [h("p", { class: alone ? "q quiet-q" : "q" }, questionText(question?.instructions, !alone))];
    const block = (content) => alone ? h("div", { class: "qa" }, content) : h("div", { class: "qa numbered" }, h("span", { class: "num" }, String(n)), h("div", {}, content));
    if (!answer) return block([parts, h("p", { class: "a" }, "No answer")]);
    if (type === "choice") {
      parts.push(h("p", { class: "a" }, answer.choice === "none" ? "None of the options" : human(answer.choice)), meter(answer.confidence, `Jev's confidence ${pct(answer.confidence)}`),
        options(Object.entries(question.criteria || {}).map(([name, description]) => ({ name: human(name), description, p: answer.probabilities?.[name], chosen: name === answer.choice }))));
    } else if (type === "noul") {
      parts.push(h("p", { class: "a" }, `${pct(answer.noul)} yes`), meter(answer.noul, "Jev's probability that the answer is yes"),
        question.criteria ? options([{ name: "Yes", description: question.criteria.true, p: answer.noul, chosen: answer.noul >= 0.5 }, { name: "No", description: question.criteria.false, p: 1 - answer.noul, chosen: answer.noul < 0.5 }]) : null);
    } else if (type === "score") {
      const levels = question.criteria || [], near = Math.round(answer.score);
      parts.push(h("p", { class: "a" }, text(levels[near] ?? `Level ${near}`)), meter(levels.length > 1 ? answer.score / (levels.length - 1) : 0, `Score ${Number(answer.score).toFixed(2)} of ${Math.max(0, levels.length - 1)} · Jev's confidence ${pct(answer.confidence)}`),
        options(levels.map((description, i) => ({ name: `Level ${i}`, level: true, description, p: answer.probabilities?.[String(i)], chosen: i === near }))));
    } else parts.push(h("pre", { class: "raw" }, JSON.stringify(answer, null, 2)));
    return block(parts);
  }
  function doc(value) {
    if (value === null || typeof value !== "object") return h("div", { class: "value" }, longText(value));
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value);
    if (!entries.length) return h("div", { class: "value quiet" }, "empty");
    return h("div", { class: "doc" }, entries.map(([key, v]) => h("div", { class: "field" }, h("div", { class: "key" }, human(key)), v !== null && typeof v === "object" ? h("div", { class: "nest" }, doc(v)) : h("div", { class: "value" }, longText(v)))));
  }
  function longText(value) {
    const s = value === null ? "–" : typeof value === "string" ? value : String(value);
    if (s.length <= 420) return s;
    const box = h("div", { class: "clip" }, s);
    return [box, h("button", { class: "expand", onclick: (event) => { box.classList.toggle("clip"); event.target.textContent = box.classList.contains("clip") ? "Show all" : "Show less"; } }, "Show all")];
  }
  /** Where a call sits in its chain: the answer that triggered it, and the calls its own answers triggered. */
  function chainLinks(record) {
    const parent = eventCall(record.trigger), children = data.records.filter((r) => r.trigger?.startsWith(`${record.id}:`));
    if (!record.trigger && !children.length) return null;
    const link = (call, words) => h("button", { class: "link", onclick: () => openCall(call.id) }, words);
    return h("div", { class: "chain" },
      record.trigger ? [h("p", { class: "eyebrow" }, "Triggered by"), parent?.q ? link(parent.call, [clip(questionOf(parent.q), 90), " ", h("b", {}, `→ ${answerWords(parent.q)}`)]) : h("p", { class: "quiet" }, `${record.trigger}, which is not recorded here`)] : null,
      children.length ? [h("p", { class: "eyebrow" }, "Led to"), children.map((child) => { const via = eventCall(child.trigger)?.q, q = child.questions[0]; return link(child, [via ? h("b", {}, `${answerWords(via)} → `) : null, clip(q ? questionOf(q) : "a call", 90)]); })] : null);
  }

  async function openCall(id, back = false) {
    const record = data.byId.get(id);
    if (!record) return;
    visit({ call: id }, back);
    data.selected = { id }; markSelected();
    openDrawer(h("p", { class: "eyebrow" }, `Call ${id}`), h("h2", { class: "d-title" }, headline(record)), h("p", { class: "d-meta" }, "Loading…"));
    let full;
    try { full = await fullRecord(id); } catch (error) { body.append(h("div", { class: "notice" }, error.message)); return; }
    if (data.selected?.id !== id) return;
    const questions = full.request?.questions || {}, answers = full.response?.answers || {};
    const panel = h("div", { class: "panel" }), toggles = [];
    const toggle = (labelText, build) => {
      const button = h("button", { class: "ghost small", "aria-pressed": "false", onclick: async () => {
        const opening = button.getAttribute("aria-pressed") !== "true";
        toggles.forEach((b) => b.setAttribute("aria-pressed", "false"));
        panel.replaceChildren();
        if (opening) { button.setAttribute("aria-pressed", "true"); panel.append(h("div", {}, await build())); }
      } }, labelText);
      toggles.push(button);
      return button;
    };
    const copy = (value, labelText) => h("button", { class: "ghost small", onclick: (event) => navigator.clipboard.writeText(value).then(() => { event.target.textContent = "Copied"; setTimeout(() => (event.target.textContent = labelText), 1200); }) }, labelText);
    const errorText = failed(record) ? (full.response?.detail?.message ?? full.response?.error ?? record.error ?? `Status ${record.status}`) : null;
    const entries = Object.entries(questions), alone = entries.length === 1;
    // the state sent with the call, opened under the title
    const state = h("div", { class: "state" }), viewState = h("button", { class: "ghost small", "aria-pressed": "false", onclick: () => {
      const open = state.hidden;
      state.hidden = !open; viewState.setAttribute("aria-pressed", String(open));
      if (open && !state.childElementCount) state.append(doc(full.request?.state));
    } }, "View state");
    state.hidden = true;
    openDrawer(
      h("p", { class: "d-meta" }, [clock(record.at), `answered in ${seconds(record.elapsedMs)}`, typeof record.cost === "number" ? money(record.cost) : null].filter(Boolean).join(" · ")),
      h("div", { class: "d-head" }, h("h2", { class: "d-title" }, alone && record.questions[0] ? questionOf(record.questions[0]) : entries.length ? `${entries.length} questions in one call` : headline(record)), viewState),
      state,
      errorText ? h("div", { class: "notice" }, `Jev did not answer: ${text(errorText)}`) : null,
      entries.map(([qid, question], i) => answerBlock(question, answers[qid], alone, i + 1)),
      chainLinks(record),
      h("div", { class: "actions" },
        toggle("Details", () => h("dl", { class: "facts" },
          h("dt", {}, "Call"), h("dd", {}, String(id)),
          h("dt", {}, "Run label"), h("dd", {}, record.label || "none"),
          h("dt", {}, "Model"), h("dd", {}, record.answeredBy && record.answeredBy !== record.model ? `${record.model} → ${record.answeredBy}` : record.model ?? "–"),
          h("dt", {}, "Input"), h("dd", {}, record.inputTokens === null ? "–" : `${record.inputTokens.toLocaleString()} tokens · ${money(record.cost)}`),
          h("dt", {}, "Time"), h("dd", {}, `${new Date(record.at).toLocaleString()} · ${(record.elapsedMs / 1000).toFixed(2)} s`),
          h("dt", {}, "Size"), h("dd", {}, `${(record.bytes / 1024).toFixed(1)} KiB sent`),
          h("dt", {}, "Status"), h("dd", {}, String(record.status)),
          h("dt", {}, "Trigger"), h("dd", { class: "mono" }, record.trigger ?? "none"),
          h("dt", {}, "Event ids"), h("dd", { class: "mono" }, record.questions.map((q) => eventOf(record, q)).join(", ") || "–"),
          h("dt", {}, "Cache key"), h("dd", { class: "mono", title: "The sha256 of the exact body sent to Jev: the same request always has the same key" }, record.key))),
        toggle("Raw", () => [h("p", { class: "eyebrow" }, "Sent to Jev"), h("pre", { class: "raw" }, JSON.stringify(full.request, null, 2)), copy(JSON.stringify(full.request, null, 2), "Copy request"),
          h("p", { class: "eyebrow", style: "margin-top:16px" }, "Returned by Jev"), h("pre", { class: "raw" }, JSON.stringify(full.response, null, 2)), copy(JSON.stringify(full.response, null, 2), "Copy response")])),
      panel);
  }

  // ---------- chrome: about, search, tooltips ----------
  function about() {
    const m = data.meta; if (!m) return;
    $("#run-line").textContent = `${location.origin}/v1/systemone`;
    $("#about-facts").replaceChildren(h("span", {}, "Each call goes to Jev with the key in settings, and is saved whole in a database ", h("span", { class: "hint", "data-tip": m.database }, "on this computer"), "."));
    $("#nokey").hidden = !!m.keyed;
    $("#empty").hidden = data.records.length > 0;
  }
  // one popover at a time: how to use, or the settings
  const POPOVERS = [["#about", "#about-panel"], ["#settings", "#settings-panel"], ["#layout", "#layout-panel"]];
  function popover(button, panel) {
    const open = $(panel).hidden;
    for (const [b, p] of POPOVERS) { $(p).hidden = true; $(b).setAttribute("aria-expanded", "false"); }
    $(panel).hidden = !open; $(button).setAttribute("aria-expanded", String(open));
    if (open && panel === "#settings-panel") loadSettings();
  }
  $("#about").addEventListener("click", () => popover("#about", "#about-panel"));
  // the layout menu opens under a mouse and closes a moment after it leaves; a tap or the keyboard toggles it
  let layoutClose = 0;
  const layoutOpen = () => !$("#layout-panel").hidden;
  for (const el of [$("#layout"), $("#layout-panel")]) {
    el.addEventListener("pointerenter", (event) => { if (event.pointerType !== "mouse") return; clearTimeout(layoutClose); if (!layoutOpen()) popover("#layout", "#layout-panel"); });
    el.addEventListener("pointerleave", (event) => { if (event.pointerType !== "mouse") return; clearTimeout(layoutClose); layoutClose = setTimeout(() => { if (layoutOpen()) popover("#layout", "#layout-panel"); }, 300); });
  }
  $("#layout").addEventListener("click", (event) => { if (event.pointerType !== "mouse") popover("#layout", "#layout-panel"); });
  $("#settings").addEventListener("click", () => popover("#settings", "#settings-panel"));
  $("#nokey").addEventListener("click", () => { if ($("#settings-panel").hidden) popover("#settings", "#settings-panel"); $("#key-input").focus(); });

  // ---------- settings: the Jev key ----------
  function showSettings(view) {
    $("#key-state").textContent = view.jevKey.set ? `Jev calls use the key ending ${view.jevKey.ending}.` : "No key yet: Jev calls are refused until you add one.";
    $("#nokey").hidden = view.jevKey.set;
    $("#key-remove").hidden = !view.jevKey.set;
    $("#key-input").placeholder = view.jevKey.set ? "Paste a new key to replace it" : "Paste a TypeSafe API key";
  }
  async function loadSettings() { try { showSettings(await (await fetch("/_/api/settings")).json()); } catch { /* the proxy is down; the pulse says so */ } }
  async function saveSettings(jevKey) {
    const error = $("#key-error"); error.hidden = true;
    const response = await fetch("/_/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jevKey }) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { error.textContent = value.error ?? "The key could not be saved."; error.hidden = false; return; }
    $("#key-input").value = ""; showSettings(value);
  }
  $("#key-form").addEventListener("submit", (event) => { event.preventDefault(); const key = $("#key-input").value.trim(); if (key) saveSettings(key); });
  $("#key-remove").addEventListener("click", () => saveSettings(null));
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy]");
    if (button) navigator.clipboard.writeText($("#" + button.dataset.copy).textContent).then(() => { button.textContent = "Copied"; setTimeout(() => (button.textContent = "Copy"), 1200); });
  });
  function openSearch() { $("#search").hidden = false; $("#query").focus(); $("#query").select(); }
  $("#find").addEventListener("click", () => ($("#search").hidden ? openSearch() : ($("#search").hidden = true)));
  let searchTimer;
  $("#query").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $("#query").value.trim();
      if (!q) return closeDrawer();
      const ids = (await (await fetch(`/_/api/search?q=${encodeURIComponent(q)}`)).json()).ids;
      if ($("#query").value.trim() === q) openList(`“${q}”`, `${plural(ids.length, "call")} mention it`, ids.filter((id) => visible(data.byId.get(id) ?? {})));
    }, 250);
  });
  document.addEventListener("pointerover", (event) => {
    const el = event.target.closest?.("[data-tip]"); if (!el) return;
    const r = el.getBoundingClientRect(); tip.replaceChildren(el.getAttribute("data-tip")); tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${r.bottom + 8 + tip.offsetHeight > innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8}px`;
  });
  document.addEventListener("pointerout", (event) => { if (event.target.closest?.("[data-tip]")) hideTip(); });

  // ---------- live ----------
  async function poll() {
    try {
      const response = await fetch(`/_/api/records?since=${data.cursor}`);
      if (!response.ok) throw Error(String(response.status));
      const next = await response.json(), first = data.cursor === 0;
      data.meta = next; data.cursor = next.cursor;
      for (const record of next.records) { data.records.push(record); data.byId.set(record.id, record); }
      if (first) { await document.fonts?.ready; readColors(); rebuild(); renderCorner(true); canvas.classList.add("ready"); const wanted = Number(location.hash.slice(1)); if (wanted && data.byId.has(wanted)) openCall(wanted); }
      else if (next.records.length) { arrive(next.records); pileUp(next.records); renderCorner(); }
      about();
      $("#pulse").className = "pulse on"; $("#pulse").dataset.tip = "Live";
    } catch { $("#pulse").className = "pulse"; $("#pulse").dataset.tip = "The proxy is not answering"; }
    setTimeout(poll, POLL_MS);
  }
  readColors();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  addEventListener("resize", resize);
  resize();
  document.fonts?.ready.then(readColors);
  requestAnimationFrame(draw);
  poll();
})();
