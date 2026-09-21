// Pixel Knight: a tiny side-scroller that Jev plays through Jeview, drawn live in the browser.
//
//   node demo/pixel-knight.ts [--port 4781] [--proxy http://127.0.0.1:4777] [--label pixel-knight] [--pace 0] [--fail 0.03]
//
// Open http://127.0.0.1:4781/ to watch. The game runs here: each turn Jev sees the tiles ahead of the knight (and what
// each button would do) and picks a button; the game moves the knight, the slimes, bats and fireballs, and keeps score.
// Some answers lead on to more questions, each sent with a Jeview-Trigger header naming the answer that led to it, and
// some change the play: a jump Jev doubts is replaced by another button, and a knight on its last heart may drink its
// potion. The page draws each turn as it comes; open Jeview beside it to watch Jev think. It plays only while a page
// is open. Every call goes to the real Jev through Jeview (one to four a turn, about ten cents an hour).
//
// Jev decides the next turn while the page is still drawing this one, staying one turn ahead. --pace adds a pause between
// turns in milliseconds, and --fail says how often a turn also sends a call Jev rejects.
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4781" },
    proxy: { type: "string", default: "http://127.0.0.1:4777" },
    label: { type: "string", default: "pixel-knight" },
    pace: { type: "string", default: "0" },
    fail: { type: "string", default: "0.03" },
  },
});
const port = Number(values.port), proxy = values.proxy.replace(/\/+$/, "");
const url = `${proxy}${values.label ? `/${encodeURIComponent(values.label)}` : ""}/v1/systemone`;
const pace = Number(values.pace), failRate = Number(values.fail);

// ---------- the questions Jev is asked ----------
const RULES = "You play Pixel Knight, a side-scroller. Each turn the knight does one thing: step right, step left, jump (over the next tile, landing two tiles ahead), press X (swing the sword at the next tile), or wait. Reach the flag at the end of the level. Falling into a gap or stepping on spikes costs a heart, and so does touching a slime, a low bat or a fireball. Jumping onto a slime squashes it. Crates and the Slime King block the way: smash a crate with the sword, and hit the Slime King three times. Coins are worth 10 points. With no hearts left, the level starts again. Tips: pick the safe move that gets furthest right. Run when the way ahead is clear. Jump only over a gap, spikes or an enemy right in front, onto a slime to squash it, or for a coin in the air, and only with a safe landing. Swing the sword at a crate, a bat or the Slime King right next to the knight. Step back or wait only to let a fireball or a swooping bat pass.";
const QUESTIONS = {
  danger: { type: "noul", instructions: "Is the knight in danger in `frame`?" },
  progress: { type: "score", instructions: "How close is the knight to the flag in `frame`?", criteria: ["Far: the level has just begun", "Halfway there", "Almost at the flag"] },
  coin: { type: "noul", instructions: "Is there a coin the knight can reach soon in `frame`?" },
  jumpClears: { type: "noul", instructions: "Following `rules`, will a jump land the knight safely in `frame`?" },
  swordHits: { type: "noul", instructions: "Will a swing of the sword hit something in `frame`?" },
  threat: {
    type: "choice",
    instructions: "What is the biggest threat to the knight in `frame`?",
    criteria: { gap: "a gap in the floor", spikes: "spikes", slime: "a slime", bat: "a bat", fireball: "a fireball", boss: "the Slime King" },
  },
  dealWith: {
    type: "choice",
    instructions: "Following `rules`, how should the knight deal with the biggest threat in `frame`?",
    criteria: { jump_over: "jump over it", back_off: "step back and wait", attack: "attack it with the sword", walk_on: "keep walking" },
  },
  potion: { type: "noul", instructions: "The knight is on its last heart. Should it drink its potion now, in `frame`?" },
};

// ---------- the game ----------
const LENGTH = 40;
type Kind = "slime" | "boss" | "crate" | "bat" | "fireball";
type Mob = { id: number; kind: Kind; x: number; high: boolean; hp: number };
type Level = { number: number; floor: string[]; coins: Set<number>; highCoins: Set<number>; mobs: Mob[] };
let ids = 0;
const mob = (kind: Kind, x: number, high = false, hp = 1): Mob => ({ id: ++ids, kind, x, high, hp });

/** A level: ground with one-tile gaps and spikes, slimes, crates, coins and (later) bats; every third ends in a boss. */
function makeLevel(number: number): Level {
  const floor: string[] = Array(LENGTH).fill("="), coins = new Set<number>(), highCoins = new Set<number>(), mobs: Mob[] = [];
  const boss = number % 3 === 0;
  for (let x = 4; x < LENGTH - (boss ? 5 : 2); x++) {
    const roll = Math.random();
    if (roll < 0.1) { floor[x] = " "; if (Math.random() < 0.5) highCoins.add(x); x++; } // one tile wide, ground after it
    else if (roll < 0.16) { floor[x] = "^"; x++; }
    else if (roll < 0.26) mobs.push(mob("slime", x));
    else if (roll < 0.31) { mobs.push(mob("crate", x)); x++; }
    else if (roll < 0.44) coins.add(x);
    else if (roll < 0.49 && number > 1) mobs.push(mob("bat", x, true));
  }
  if (boss) mobs.push(mob("boss", LENGTH - 3, false, 3));
  return { number, floor, coins, highCoins, mobs };
}

const game = { level: makeLevel(1), x: 1, hearts: 3, coins: 0, score: 0, potion: true, asked: false, turn: 0, checkpoint: 1, best: 1, since: 0, wins: 0, restarts: 0 };
const mobAt = (x: number, high?: boolean) => game.level.mobs.find((m) => m.x === x && (high === undefined || m.high === high));
const blocked = (x: number) => { const m = mobAt(x, false); return !!m && (m.kind === "crate" || m.kind === "boss"); };
const names: Record<Kind, string> = { slime: "a slime", boss: "the Slime King", crate: "a crate", bat: "a bat", fireball: "a fireball" };

/** One tile in words, for Jev. */
function describe(x: number): string {
  if (x < 0) return "the start of the level";
  if (x >= LENGTH) return "past the end of the level";
  const floor = game.level.floor[x] === " " ? "a gap" : game.level.floor[x] === "^" ? "spikes" : "ground";
  const things = game.level.mobs.filter((m) => m.x === x).map((m) =>
    m.kind === "boss" ? `the Slime King, ${m.hp} ${m.hp === 1 ? "hit" : "hits"} from defeat` : m.kind === "bat" ? (m.high ? "a bat flying overhead" : "a bat swooping low") : m.kind === "fireball" ? "a fireball flying towards the knight" : names[m.kind]);
  if (game.level.coins.has(x)) things.push("a coin");
  if (game.level.highCoins.has(x)) things.push("a coin in the air, reached by jumping over this tile");
  if (x === LENGTH - 1) things.push("the flag");
  return [floor, ...things].join(", ");
}
/** Where a jump from here lands: two tiles on, or one when something blocks the second. */
const landing = (x: number) => (x + 2 < LENGTH && !blocked(x + 2) ? x + 2 : !blocked(x + 1) ? Math.min(LENGTH - 1, x + 1) : x);
/** Whether standing on a tile is safe, in words. */
function verdict(x: number): string {
  if (x < 0 || x >= LENGTH) return "not possible";
  if (game.level.floor[x] === " ") return "falls in, costs a heart";
  if (game.level.floor[x] === "^") return "costs a heart";
  const foe = game.level.mobs.find((m) => m.x === x && !m.high && m.kind !== "crate");
  if (foe) return `touches ${names[foe.kind]}, costs a heart`;
  if (x === LENGTH - 1) return "safe, and wins the level";
  return game.level.coins.has(x) ? "safe, and grabs a coin" : "safe";
}
/** How far a run goes: over plain safe ground (coins are picked up), stopping before anything else, at most six tiles. */
function runLength(x: number): number {
  let n = 0;
  while (n < 6 && x + n + 1 < LENGTH && game.level.floor[x + n + 1] === "=" && !mobAt(x + n + 1, false) && !mobAt(x + n + 1, true)) n++;
  return n;
}
/** A slime a jump would land on: squashed. */
const stompable = (x: number) => game.level.floor[x] === "=" ? game.level.mobs.find((m) => m.x === x && m.kind === "slime") : undefined;
/** What each button would do from here, as a game shows its moves, with whether it is safe. */
function moves(x: number) {
  const target = mobAt(x + 1, false) ?? mobAt(x + 1, true), land = landing(x), air = game.level.highCoins.has(x + 1) ? ", grabbing the coin in the air" : "";
  const run = runLength(x), stop = x + run + 1, coins = [...Array(run).keys()].filter((i) => game.level.coins.has(x + i + 1)).length;
  return {
    run: run >= 2 ? `the fastest safe way forward: runs ${run} tiles over safe ground${coins ? `, grabbing ${coins} ${coins === 1 ? "coin" : "coins"}` : ""}, stopping ${stop >= LENGTH ? "at the flag" : `before ${describe(stop)}`}: safe` : null,
    right: blocked(x + 1) ? `blocked by ${names[mobAt(x + 1, false)!.kind]}: nothing happens` : `moves one tile, onto ${describe(x + 1)}: ${verdict(x + 1)}`,
    left: x > 0 ? `steps back onto ${describe(x - 1)}: ${verdict(x - 1)}` : "cannot go further back",
    jump: `jumps over ${describe(x + 1)}${air} and lands on ${describe(land)}: ${land === x ? "nothing happens" : stompable(land) ? "squashes the slime, safe" : verdict(land)}${mobAt(x + 1, true) ? ", but hits the bat on the way, costing a heart" : ""}`,
    press_x: target ? `swings at ${names[target.kind]}: ${target.kind === "boss" && target.hp > 1 ? "hits it" : "defeats it"}` : "swings at nothing: wastes the turn",
    wait: "stays where it is",
  };
}
/** The button question for this turn: each option says what it would do from here. Without jump when a jump was doubted. */
function buttonQuestion(withJump = true) {
  const m = moves(game.x), criteria: Record<string, string> = {};
  if (m.run) criteria.run = `run right: ${m.run}`;
  criteria.right = `step right: ${m.right}`;
  if (withJump) criteria.jump = `jump: ${m.jump}`;
  criteria.press_x = `press X: ${m.press_x}`;
  criteria.left = `step left: ${m.left}`;
  criteria.wait = `wait: ${m.wait}`;
  return withJump
    ? { type: "choice", instructions: "Following `rules`, which button should the knight press now? Each option says what it would do.", criteria }
    : { type: "choice", instructions: "The knight will not jump. Following `rules`, which button should it press instead? Each option says what it would do.", criteria };
}
/** What Jev sees this turn. */
const frame = () => ({
  level: game.level.number, turn: game.turn, hearts: `${game.hearts} of 3`, coins: game.coins, potion: game.potion ? "one" : "none",
  knight: `on tile ${game.x + 1} of ${LENGTH}, standing on ${describe(game.x)}`,
  behind: describe(game.x - 1),
  ahead: [1, 2, 3, 4, 5].map((d) => `${d} ahead: ${describe(game.x + d)}`),
  ...(game.since >= 6 ? { note: `the knight has not moved forward for ${game.since} turns` } : {}),
});

function hurt(events: string[], what: string) { game.hearts--; events.push(what); }

/** The knight presses a button. */
function act(button: string, events: string[]) {
  const { x, level } = game;
  if (button === "run") {
    const run = runLength(x);
    for (let i = 1; i <= run; i++) if (level.coins.delete(x + i)) { game.coins++; game.score += 10; events.push("grabbed a coin"); }
    game.x = x + Math.max(run, 1);
    events.unshift(`ran ${Math.max(run, 1)} tiles`);
  } else if (button === "right") { if (blocked(x + 1)) events.push("bumped into " + names[mobAt(x + 1, false)!.kind]); else { game.x = Math.min(LENGTH - 1, x + 1); events.push("stepped right"); } }
  else if (button === "left") { game.x = Math.max(0, x - 1); events.push("stepped left"); }
  else if (button === "jump") {
    const bat = mobAt(x + 1, true);
    if (bat) { level.mobs.splice(level.mobs.indexOf(bat), 1); hurt(events, "jumped into a bat"); }
    if (level.highCoins.delete(x + 1)) { game.coins++; game.score += 10; events.push("grabbed a coin in mid-air"); }
    game.x = landing(x);
    events.push("jumped");
    const squashed = game.x !== x ? stompable(game.x) : undefined;
    if (squashed) { level.mobs.splice(level.mobs.indexOf(squashed), 1); game.score += 20; events.push("squashed a slime"); }
  } else if (button === "press_x") {
    const target = mobAt(x + 1, false) ?? mobAt(x + 1, true);
    if (!target) events.push("swung at nothing");
    else if (target.kind === "boss" && --target.hp > 0) { game.score += 30; events.push(`hit the Slime King (${target.hp} to go)`); }
    else { level.mobs.splice(level.mobs.indexOf(target), 1); game.score += target.kind === "boss" ? 200 : target.kind === "crate" ? 5 : 20; events.push(`defeated ${names[target.kind]}`); }
  } else events.push("waited");
}

/** Everything else moves: slimes creep, bats swoop, fireballs fly; now and then a fireball comes in from the right. */
function world(events: string[]) {
  const level = game.level;
  for (const m of level.mobs) {
    if (m.kind === "slime" && game.turn % 2 === 0) { const nx = m.x - 1; if (nx >= 0 && level.floor[nx] === "=" && !mobAt(nx) && nx !== game.x) m.x = nx; }
    if (m.kind === "bat") { m.x -= 1; m.high = !m.high; }
    if (m.kind === "fireball") {
      if (game.x <= m.x && game.x >= m.x - 2) { m.x = -99; hurt(events, "was hit by a fireball"); } // it flies through the knight's tile
      else m.x -= 2;
    }
  }
  level.mobs = level.mobs.filter((m) => m.x >= 0);
  if (level.number > 1 && Math.random() < 0.07) level.mobs.push(mob("fireball", Math.min(LENGTH - 1, game.x + 7)));
}

/** Where the knight ended up: gaps, spikes, enemies and coins. Says when the level is won or lost. */
function resolve(events: string[]): "flag" | "out" | null {
  const level = game.level;
  if (level.floor[game.x] === " ") { hurt(events, "fell into a gap"); game.x = game.checkpoint; }
  else if (level.floor[game.x] === "^") { hurt(events, "stepped on spikes"); game.x = Math.max(0, game.x - 1); }
  const foe = level.mobs.find((m) => m.x === game.x && !m.high && m.kind !== "crate");
  if (foe) { hurt(events, `was hit by ${names[foe.kind]}`); if (foe.kind !== "boss") level.mobs.splice(level.mobs.indexOf(foe), 1); game.x = Math.max(0, game.x - 1); }
  if (level.coins.delete(game.x)) { game.coins++; game.score += 10; events.push("grabbed a coin"); }
  if (level.floor[game.x] === "=" && !mobAt(game.x)) game.checkpoint = game.x;
  if (game.x > game.best) { game.best = game.x; game.since = 0; } else game.since++;
  if (game.x >= LENGTH - 1) { game.score += 100; game.wins++; events.push(`reached the flag! On to level ${level.number + 1}`); return "flag"; }
  if (game.hearts <= 0) { game.restarts++; events.push(`is out of hearts: level ${level.number} starts again`); return "out"; }
  return null;
}
/** A new level after the flag, or the same one afresh after the hearts run out. */
function advance(outcome: "flag" | "out") {
  game.level = makeLevel(outcome === "flag" ? game.level.number + 1 : game.level.number);
  game.x = game.checkpoint = game.best = 1; game.since = 0; game.potion = true;
  if (outcome === "out") game.hearts = 3;
}

// ---------- what the page is sent ----------
const scene = () => ({
  number: game.level.number, floor: game.level.floor.join(""), coins: [...game.level.coins], highCoins: [...game.level.highCoins],
  mobs: game.level.mobs.map(({ id, kind, x, high, hp }) => ({ id, kind, x, high, hp })),
});
const hud = () => ({ level: game.level.number, hearts: game.hearts, coins: game.coins, score: game.score, potion: game.potion, turn: game.turn, wins: game.wins, restarts: game.restarts });

// ---------- asking Jev ----------
type Answer = { choice?: string; confidence?: number; noul?: number; score?: number };
type Reply = { answers: Record<string, Answer>; events: Record<string, string> };
/** One call through Jeview; `trigger` is the event id of the answer it follows from. Null when Jev did not answer. */
async function ask(state: unknown, questions: Record<string, unknown>, trigger?: string): Promise<Reply | null> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(trigger ? { "jeview-trigger": trigger } : {}) },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
  });
  return response.ok ? (await response.json()) as Reply : null;
}

/** One turn: Jev decides and the game moves on. Only the questions that change the move hold it up (a jump Jev doubts,
 * the potion); the rest are asked alongside and their answers sent to the page when they come. What the page needs. */
async function turn() {
  game.turn++;
  const state = { rules: RULES, frame: frame() };
  if (Math.random() < failRate) void ask(state, { combo: { type: "combo", instructions: "Up, up, down, down, left, right, left, right, B, A?" } }).catch(() => null); // Jev rejects it
  const first = await ask(state, { button: buttonQuestion(), danger: QUESTIONS.danger, progress: QUESTIONS.progress, coin: QUESTIONS.coin });
  if (!first) return null;
  const events: string[] = [], chosen = first.answers.button?.choice ?? "wait";
  const said = { chosen, sure: first.answers.button?.confidence ?? null, danger: first.answers.danger?.noul ?? null, doubt: null as number | null, potion: false };
  let button = chosen;
  const number = game.turn, thought = (words: Record<string, unknown>) => broadcast({ type: "thought", turn: number, ...words });
  // alongside, not waited for: will the sword hit, and in danger, what is the threat and how to deal with it
  if (chosen === "press_x") void ask(state, { sword_hits: QUESTIONS.swordHits }, first.events.button).catch(() => null);
  if ((said.danger ?? 0) >= 0.5) {
    void ask(state, { threat: QUESTIONS.threat }, first.events.danger).then(async (threat) => {
      const sees = threat?.answers.threat?.choice;
      if (!threat || !sees) return;
      const plan = (await ask(state, { deal_with: QUESTIONS.dealWith }, threat.events.threat))?.answers.deal_with?.choice ?? null;
      thought({ sees, plan });
    }).catch(() => null);
  }
  const hold: Promise<unknown>[] = [];
  // a jump Jev was unsure of is checked first, and replaced if it doubts it
  if (button === "jump" && (said.sure ?? 1) < 0.6) {
    hold.push((async () => {
      const clears = await ask(state, { jump_clears: QUESTIONS.jumpClears }, first.events.button);
      const safe = clears?.answers.jump_clears?.noul;
      if (!clears || typeof safe !== "number" || safe >= 0.35) return;
      const choice = (await ask(state, { instead: buttonQuestion(false) }, clears.events.jump_clears))?.answers.instead?.choice;
      if (choice) { said.doubt = safe; button = choice; }
    })());
  }
  // down to the last heart: the potion? (asked once each time)
  if (game.hearts > 1) game.asked = false;
  if (game.hearts === 1 && game.potion && !game.asked) {
    game.asked = true;
    hold.push(ask(state, { potion: QUESTIONS.potion }).then((reply) => {
      if ((reply?.answers.potion?.noul ?? 0) >= 0.5) { game.potion = false; game.hearts = 2; said.potion = true; events.push("drank the potion"); }
    }));
  }
  await Promise.all(hold);
  const from = game.x, hearts = game.hearts;
  act(button, events);
  const to = game.x;
  world(events);
  const outcome = resolve(events);
  const message = { type: "turn", turn: game.turn, button, said, events, from, to, x: game.x, fell: events.includes("fell into a gap"), hurt: game.hearts < hearts, outcome, scene: scene(), hud: hud() };
  if (!outcome) return message;
  advance(outcome);
  return { ...message, next: scene(), hud: hud() };
}

// ---------- the page ----------
const watchers = new Set<ServerResponse>();
const broadcast = (message: unknown) => { const line = `data: ${JSON.stringify(message)}\n\n`; for (const watcher of watchers) watcher.write(line); };
// the latest turn a page has started to draw; the game stays at most one turn ahead of it
let shown = 0, shownAt = 0;
const FILES: Record<string, [string, string]> = { "/": ["index.html", "text/html; charset=utf-8"], "/game.js": ["game.js", "text/javascript; charset=utf-8"] };
const server = createServer((req, res) => {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return void res.writeHead(403).end();
  const path = new URL(req.url ?? "/", "http://game").pathname, file = FILES[path];
  if (file) { res.writeHead(200, { "content-type": file[1], "cache-control": "no-store" }); return void res.end(readFileSync(new URL(file[0], import.meta.url))); }
  if (path === "/shown" && req.method === "POST") {
    const turn = Number(new URL(req.url ?? "/", "http://game").searchParams.get("turn"));
    if (Number.isInteger(turn)) { shown = Math.max(shown, turn); shownAt = Date.now(); }
    return void res.writeHead(204).end();
  }
  if (path === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "hello", scene: scene(), x: game.x, hud: hud(), jeview: `${proxy}/` })}\n\n`);
    watchers.add(res); shown = game.turn; shownAt = Date.now();
    req.on("close", () => watchers.delete(res));
    return;
  }
  res.writeHead(404).end();
});
server.listen(port, "127.0.0.1", () => console.log(`Pixel Knight: open http://127.0.0.1:${port}/ to watch Jev play (through ${url}). Ctrl-C stops it.`));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// ---------- play, while someone watches ----------
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
for (;;) {
  if (!watchers.size) { await sleep(400); continue; }
  if (game.turn > shown && Date.now() - shownAt < 4000) { await sleep(15); continue; } // one turn ahead of the page is enough
  let message;
  try { message = await turn(); } catch (error) { message = { type: "waiting", reason: `Jeview is not answering at ${proxy}: ${(error as Error).message}` }; }
  broadcast(message ?? { type: "waiting", reason: "Jev did not answer. Is a Jev key set in Jeview's settings?" });
  if (message?.type !== "turn") await sleep(3000); else if (pace) await sleep(pace);
}
