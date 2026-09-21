// A demo for Jeview: Jev plays Pixel Knight, a made-up side-scroller, through Jeview. Every frame of the level is one
// call: which button to press, is the knight in danger, how close is the flag, is there a coin in reach. Some answers
// lead on to more questions, each sent with a Jeview-Trigger header naming the answer that led to it: a jump asks
// whether it will clear what is ahead, danger asks what the threat is and then how to deal with it. A few questions
// come only now and then, so they fade from the map between visits, and a few calls are ones Jev rejects. Everything
// goes to the real Jev through Jeview, which costs about ten cents an hour at the default pace. Ctrl-C stops it.
//
// The level is not simulated yet: each frame is a scene picked at random, with the knight moving on towards the flag.
//
//   node scripts/demo.ts [--proxy http://127.0.0.1:4777] [--label pixel-knight] [--pace 1500] [--fail 0.05]
//
// --pace is the average gap between frames in milliseconds, and --fail how often a call is one Jev rejects.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    proxy: { type: "string", default: "http://127.0.0.1:4777" },
    label: { type: "string", default: "pixel-knight" },
    pace: { type: "string", default: "1500" },
    fail: { type: "string", default: "0.05" },
  },
});
const url = `${values.proxy.replace(/\/+$/, "")}${values.label ? `/${encodeURIComponent(values.label)}` : ""}/v1/systemone`;
const pace = Number(values.pace), failRate = Number(values.fail);

const RULES = "You play Pixel Knight, a made-up side-scroller. Reach the flag at the end of each level. Jump over gaps, spikes and fireballs. Press X to swing your sword at an enemy right next to you. Touching an enemy or spikes costs a heart; with no hearts left the level starts again. Coins are worth 10 points.";
const QUESTIONS = {
  button: {
    type: "choice",
    instructions: "Following `rules`, which button should the knight press in `frame`?",
    criteria: { right: "step forward", left: "step back", jump: "jump up and forward", press_x: "swing the sword", wait: "stand still for a moment" },
  },
  danger: { type: "noul", instructions: "Is the knight in danger in `frame`?" },
  progress: {
    type: "score",
    instructions: "How close is the knight to the flag in `frame`?",
    criteria: ["Far: the level has just begun", "Halfway there", "Almost at the flag"],
  },
  coin: { type: "noul", instructions: "Can the knight grab a coin from where it stands in `frame`?" },
  // what the answers lead to
  jumpClears: { type: "noul", instructions: "Will a jump clear what is ahead of the knight in `frame`?" },
  swordHits: { type: "noul", instructions: "Will a swing of the sword hit something in `frame`?" },
  threat: {
    type: "choice",
    instructions: "What is the biggest threat to the knight in `frame`?",
    criteria: { gap: "a gap in the floor", spikes: "spikes", slime: "a slime", bat: "a bat", fireball: "a fireball", boss: "the boss" },
  },
  dealWith: {
    type: "choice",
    instructions: "Following `rules`, how should the knight deal with the biggest threat in `frame`?",
    criteria: { jump_over: "jump over it", back_off: "step back and wait", attack: "attack it with the sword", run_past: "run past it quickly" },
  },
  weakSpot: {
    type: "choice",
    instructions: "Where should the knight aim at the Slime King in `frame`?",
    criteria: { crown: "the wobbly crown", eyes: "the big eyes", belly: "the glowing belly" },
  },
  // asked only now and then
  potion: { type: "noul", instructions: "Should the knight drink its potion now, in `frame`?" },
  save: { type: "noul", instructions: "Is `frame` a good moment to save the game?" },
  secret: { type: "noul", instructions: "Could there be a secret passage near the knight in `frame`?" },
};
// scenes: what is ahead of the knight, above it and under its feet
const SCENES: [string, string, string][] = [
  ["a gap three tiles wide", "nothing", "the edge of the gap"],
  ["a green slime right in front", "nothing", "solid ground"],
  ["spikes on the floor, one tile ahead", "a coin", "solid ground"],
  ["a clear path", "a coin", "solid ground"],
  ["a bat swooping down", "the bat", "solid ground"],
  ["a fireball flying towards the knight", "nothing", "solid ground"],
  ["a wooden crate", "a floating platform with a coin", "solid ground"],
  ["a cracked wall", "a torch", "solid ground"],
  ["the Slime King, a giant slime wearing a crown", "nothing", "the boss arena"],
  ["the flag, two tiles ahead", "nothing", "solid ground"],
];

type Answer = { choice?: string; confidence?: number; noul?: number; score?: number };
type Reply = { answers: Record<string, Answer>; events: Record<string, string> };

// the knight's run: it moves on towards the flag, level by level, and loses a heart now and then
const run = { level: 1, position: 0, hearts: 3, coins: 0 };
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
function frame() {
  run.position += 1 + Math.floor(Math.random() * 3);
  if (run.position >= 20) { run.level += 1; run.position = 0; }
  if (Math.random() < 0.15) run.hearts = run.hearts > 1 ? run.hearts - 1 : 3;
  if (Math.random() < 0.3) run.coins += 1;
  const [ahead, above, below] = run.position >= 17 ? SCENES.at(-1)! : run.level % 3 === 0 && run.position >= 12 ? SCENES.at(-2)! : pick(SCENES.slice(0, -2));
  return { level: `1-${run.level}`, knight: { position: `${run.position} of 20 tiles`, hearts: `${run.hearts} of 3`, coins: run.coins, potion: "one" }, ahead, above, below };
}

/** One call through Jeview; `trigger` is the event id of the answer it follows from. Null when Jev did not answer. */
async function ask(state: unknown, questions: Record<string, unknown>, trigger?: string): Promise<Reply | null> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(trigger ? { "jeview-trigger": trigger } : {}) },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
  });
  return response.ok ? (await response.json()) as Reply : null;
}

/** One frame: four questions at once, then what their answers lead to. */
async function play() {
  const state = { rules: RULES, frame: frame() };
  const first = await ask(state, { button: QUESTIONS.button, danger: QUESTIONS.danger, progress: QUESTIONS.progress, coin: QUESTIONS.coin });
  if (!first) return;
  const after: Promise<unknown>[] = [];
  const button = first.answers.button?.choice;
  if (button === "jump") after.push(ask(state, { jump_clears: QUESTIONS.jumpClears }, first.events.button));
  if (button === "press_x") after.push(ask(state, { sword_hits: QUESTIONS.swordHits }, first.events.button));
  // in danger: what is the threat, and then how to deal with it (the boss has a weak spot instead)
  if ((first.answers.danger?.noul ?? 0) >= 0.5) {
    after.push(ask(state, { threat: QUESTIONS.threat }, first.events.danger).then((threat) => {
      if (!threat) return;
      return threat.answers.threat?.choice === "boss"
        ? ask(state, { weak_spot: QUESTIONS.weakSpot }, threat.events.threat)
        : ask(state, { deal_with: QUESTIONS.dealWith }, threat.events.threat);
    }));
  }
  await Promise.all(after);
}

/** One of the questions asked only now and then. */
async function rare() {
  const [id, question] = pick([["potion", QUESTIONS.potion], ["save", QUESTIONS.save], ["secret", QUESTIONS.secret]] as const);
  await ask({ rules: RULES, frame: frame() }, { [id]: question });
}

/** A call Jev rejects: a question of a type it does not know. */
const rejected = () => ask({ rules: RULES, frame: frame() }, { combo: { type: "combo", instructions: "Up, up, down, down, left, right, left, right, B, A?" } });

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
console.log(`Jev is playing Pixel Knight through ${url}, one frame every ${pace} ms or so. Ctrl-C stops it.`);
for (;;) {
  const roll = Math.random();
  (roll < failRate ? rejected() : roll < failRate + 0.08 ? rare() : play()).catch((error: Error) => console.error(`demo: ${error.message}`));
  await new Promise((resolve) => setTimeout(resolve, pace * (0.5 + Math.random())));
}
