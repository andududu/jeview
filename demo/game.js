// Pixel Knight's screen: draws each turn the game server sends while Jev plays, and lights up the button Jev pressed.
const W = 320, H = 180, T = 16, GROUND = 146, STEP = 240, TILE = 105, JUMP = 320; // ms: a step, each tile of a run, a jump
const canvas = document.getElementById("game"), ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

const game = { scene: null, x: 1, hud: null, anim: null, queue: [], cam: 0, particles: [], floaters: [], waiting: null, told: 0 };

// ---------- pixel art ----------
const C = {
  o: "#ff7a1a", S: "#8d95a3", s: "#d4d9e1", K: "#1b1f2a", b: "#3b6fd8", B: "#274c9e", h: "#8a5a2b", w: "#f4f6fb",
  g: "#46c46a", G: "#2c8c49", l: "#9cf0b0", W: "#ffffff", p: "#8b5cf6", P: "#5b36b8", r: "#ff4d4d", y: "#ffd23f", Y: "#d99a00",
};
const KNIGHT = [
  "....oo......",
  "...oooo.....",
  "..SSSSSS....",
  "..SssssS....",
  "..SKKKKS...w",
  "..SSSSSS..w.",
  "...bbbb..w..",
  "..bbbbbbhw..",
  ".bbBbbbbh...",
  ".bb.bbbb....",
  "...bbbb.....",
];
const LEGS = [["...b..b.....", "..KK..KK...."], ["..b....b....", ".KK....KK..."], ["....bb......", "...KKKK....."]];
const SLIME = [
  "....gggg....",
  "..gglggggg..",
  ".gglggggggg.",
  ".gWKgggWKgg.",
  "gggggggggggg",
  "gggggggggggg",
  "GggggggggggG",
  ".GGGGGGGGGG.",
];
const BAT_UP = ["P..........P", "PP........PP", "PPP.pppp.PPP", ".PPpprrppPP.", "...pppppp...", "....p..p...."];
const BAT_DOWN = ["....pppp....", "...pprrpp...", ".PPppppppPP.", "PPPP....PPPP", "PP........PP", "P..........P"];
const CROWN = ["y..y..y..y", "yy.yy.yy.y", "yyyyyyyyyy", "YYYYYYYYYY"];

function sprite(map, x, y, scale = 1, flip = false) {
  for (let j = 0; j < map.length; j++) {
    const row = map[j];
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c === ".") continue;
      ctx.fillStyle = C[c];
      ctx.fillRect(Math.round(x + (flip ? row.length - 1 - i : i) * scale), Math.round(y + j * scale), scale, scale);
    }
  }
}
const hash = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
const lerp = (a, b, t) => a + (b - a) * t, ease = (t) => t * t * (3 - 2 * t), clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- the world ----------
function sky(now) {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#131836"); grad.addColorStop(1, "#3b2d5e");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) { // stars, barely moving
    const x = ((hash(i) * 900 - game.cam * 0.05) % W + W) % W, y = hash(i + 99) * 90, on = Math.sin(now / 700 + i) > -0.6;
    if (on) { ctx.fillStyle = i % 5 ? "#8f93c9" : "#ffffff"; ctx.fillRect(Math.round(x), Math.round(y), 1, 1); }
  }
  const ridge = (speed, base, height, color, seed) => { // far mountains and near hills
    ctx.fillStyle = color;
    for (let x = 0; x <= W; x += 4) {
      const wx = x + game.cam * speed, h = base - height * (0.5 + 0.5 * Math.sin(wx / 37 + seed) * Math.sin(wx / 91 + seed * 2));
      ctx.fillRect(x, Math.round(h), 4, H - Math.round(h));
    }
  };
  ridge(0.15, 118, 40, "#231c45", 1); ridge(0.35, 132, 26, "#2d2553", 4);
  for (let i = 0; i < 5; i++) { // clouds
    const x = ((i * 97 + 40 - game.cam * 0.2 + now / 400) % (W + 60) + W + 60) % (W + 60) - 40, y = 18 + hash(i + 7) * 40;
    ctx.fillStyle = "rgba(190, 180, 255, 0.10)"; ctx.fillRect(Math.round(x), Math.round(y), 34, 6); ctx.fillRect(Math.round(x) + 8, Math.round(y) - 4, 18, 4);
  }
}
function tiles(scene, now) {
  for (let t = Math.floor(game.cam / T) - 1; t <= Math.ceil((game.cam + W) / T) + 1; t++) {
    if (t < 0 || t >= scene.floor.length) continue;
    const x = Math.round(t * T - game.cam), f = scene.floor[t];
    if (f === " ") { ctx.fillStyle = "#0a0b16"; ctx.fillRect(x, GROUND + 2, T, H); continue; }
    ctx.fillStyle = "#6b4a2b"; ctx.fillRect(x, GROUND, T, H - GROUND);
    ctx.fillStyle = "#5a3d22"; for (let i = 0; i < 5; i++) ctx.fillRect(x + Math.floor(hash(t * 7 + i) * 14), GROUND + 6 + Math.floor(hash(t * 13 + i) * 26), 2, 2);
    ctx.fillStyle = "#46c46a"; ctx.fillRect(x, GROUND, T, 3); ctx.fillStyle = "#2c8c49"; ctx.fillRect(x, GROUND + 3, T, 1);
    if (f === "^") for (let i = 0; i < 4; i++) { // spikes
      ctx.fillStyle = "#d4d9e1";
      for (let r = 0; r < 6; r++) ctx.fillRect(x + i * 4 + Math.floor(r / 3), GROUND - 1 - r, Math.max(1, 4 - 2 * Math.floor(r / 3) - (r % 3 ? 1 : 0)), 1);
      ctx.fillStyle = "#8d95a3"; ctx.fillRect(x + i * 4, GROUND - 1, 4, 1);
    }
  }
  const last = scene.floor.length - 1, fx = Math.round(last * T - game.cam); // the flag
  ctx.fillStyle = "#d4d9e1"; ctx.fillRect(fx + 3, GROUND - 46, 2, 46);
  ctx.fillStyle = "#ffd23f"; ctx.fillRect(fx + 2, GROUND - 48, 4, 3);
  ctx.fillStyle = "#ff5c00";
  for (let i = 0; i < 14; i++) { const wave = Math.round(Math.sin(now / 160 + i / 3) * 1.5), hgt = Math.round(10 * (1 - i / 14)); ctx.fillRect(fx + 5 + i, GROUND - 44 + Math.floor((10 - hgt) / 2) + wave, 1, hgt); }
}
function coin(x, y, now, seed) {
  const w = Math.max(1, Math.round(Math.abs(Math.cos(now / 220 + seed)) * 6));
  const cx = Math.round(x + 8 - w / 2), cy = Math.round(y + Math.sin(now / 300 + seed) * 1.5);
  ctx.fillStyle = "#d99a00"; ctx.fillRect(cx, cy, w, 8);
  ctx.fillStyle = "#ffd23f"; ctx.fillRect(cx + (w > 2 ? 1 : 0), cy + 1, Math.max(1, w - 2), 6);
  if (w > 3) { ctx.fillStyle = "#fff6c2"; ctx.fillRect(cx + 1, cy + 1, 1, 3); }
}
function mob(m, x, lowness, now) {
  const px = Math.round(x * T - game.cam);
  if (m.kind === "slime") { const squash = Math.abs(Math.sin(now / 260 + m.id)) * 1.5; sprite(SLIME, px + 2, GROUND - 8 + squash, 1); }
  else if (m.kind === "boss") {
    const bob = Math.round(Math.sin(now / 300) * 1.5);
    sprite(SLIME, px - 4, GROUND - 16 + bob, 2); sprite(CROWN, px + 3, GROUND - 22 + bob, 1);
    for (let i = 0; i < m.hp; i++) { ctx.fillStyle = "#ff4d6d"; ctx.fillRect(px + 2 + i * 6, GROUND - 30 + bob, 4, 3); }
  } else if (m.kind === "crate") {
    ctx.fillStyle = "#6b4726"; ctx.fillRect(px + 1, GROUND - 14, 14, 14);
    ctx.fillStyle = "#9b6a3c"; ctx.fillRect(px + 2, GROUND - 13, 12, 12);
    ctx.fillStyle = "#6b4726"; for (let i = 0; i < 12; i++) { ctx.fillRect(px + 2 + i, GROUND - 13 + i, 1, 1); ctx.fillRect(px + 13 - i, GROUND - 13 + i, 1, 1); }
  } else if (m.kind === "bat") {
    const y = lerp(GROUND - 40, GROUND - 14, lowness) + Math.sin(now / 120 + m.id) * 2;
    sprite(Math.floor(now / 140 + m.id) % 2 ? BAT_UP : BAT_DOWN, px + 2, y, 1);
  } else if (m.kind === "fireball") {
    const y = GROUND - 9;
    ctx.fillStyle = "#ff7a1a"; ctx.beginPath(); ctx.arc(px + 8, y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffd23f"; ctx.beginPath(); ctx.arc(px + 7, y, 2.2, 0, Math.PI * 2); ctx.fill();
    if (Math.random() < 0.6) game.particles.push({ x: x * T + 12, y: y + (Math.random() - 0.5) * 4, vx: 0.4 + Math.random() * 0.4, vy: (Math.random() - 0.5) * 0.3, life: 18, color: Math.random() < 0.5 ? "#ff7a1a" : "#ffd23f" });
  }
}
function knight(x, y, now, walking, swinging, hidden) {
  if (hidden) return;
  const px = Math.round(x * T - game.cam) + 2, py = Math.round(GROUND - 13 + y);
  sprite(KNIGHT, px, py);
  const legs = y < -1 ? LEGS[2] : walking ? LEGS[1 + (Math.floor(now / 90) % 2) * -1 + 0] : LEGS[0];
  sprite(walking && Math.floor(now / 90) % 2 ? LEGS[1] : legs, px, py + KNIGHT.length);
  if (swinging > 0) { // the sword's arc
    ctx.strokeStyle = `rgba(255, 255, 255, ${swinging})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px + 12, py + 7, 9, -1.2, 1.1); ctx.stroke();
  }
}
function thinking(x, now) { // a bubble over the knight while Jev decides
  const px = Math.round(x * T - game.cam) + 8, py = GROUND - 30;
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)"; ctx.fillRect(px - 9, py - 6, 20, 10); ctx.fillRect(px - 8, py - 7, 18, 12); ctx.fillRect(px - 2, py + 5, 2, 2); ctx.fillRect(px - 4, py + 8, 1, 1);
  for (let i = 0; i < 3; i++) { ctx.fillStyle = Math.floor(now / 250) % 3 >= i ? "#1b1f2a" : "#b4b4c8"; ctx.fillRect(px - 5 + i * 5, py - 1, 3, 3); }
}
function burst(x, y, colors, count = 14) {
  for (let i = 0; i < count; i++) { const a = Math.random() * Math.PI * 2, s = 0.6 + Math.random() * 1.6; game.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.8, life: 26 + Math.random() * 14, color: colors[i % colors.length], gravity: 0.08 }); }
}
function floater(text, x, y, color) { game.floaters.push({ text, x, y, color, born: performance.now() }); }

// ---------- a turn, drawn ----------
const NAMES = { run: "RUN", right: "RIGHT", left: "LEFT", jump: "JUMP", press_x: "X", wait: "WAIT" };
const PAD = { run: "right", right: "right", left: "left", jump: "jump", press_x: "press_x", wait: "wait" }; // run holds the right button
const pct = (p) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "–");
const words = (s) => String(s ?? "").replace(/_/g, " ");

function begin(message) {
  const before = game.scene;
  fetch(`/shown?turn=${message.turn}`, { method: "POST" }).catch(() => {}); // the game works out the next turn meanwhile
  const move = message.button === "run" ? Math.max(STEP, Math.abs(message.to - message.from) * TILE) : message.button === "jump" ? JUMP : STEP;
  game.anim = { move,
    message, start: performance.now(), done: false, effects: false, speed: 1 + Math.min(2, game.queue.length * 0.7), // quicker when turns queue up
    before: new Map((before?.mobs ?? []).map((m) => [m.id, m])), coins: new Set(before?.coins ?? []), highCoins: new Set(before?.highCoins ?? []),
    end: move + (message.fell ? 420 : message.hurt ? 300 : message.x !== message.to ? 180 : 0),
  };
  game.waiting = null; banner(null);
  press(message);
  tell(message);
}
function press({ button, said }) {
  for (const b of document.querySelectorAll(".pad button")) b.classList.remove("on", "maybe");
  const final = document.querySelector(`.pad [data-b="${PAD[button] ?? button}"]`);
  if (said.doubt !== null && said.chosen !== button) { // Jev reached for jump, then thought better of it
    const first = document.querySelector(`.pad [data-b="${PAD[said.chosen] ?? said.chosen}"]`);
    first?.classList.add("maybe");
    setTimeout(() => { first?.classList.remove("maybe"); final?.classList.add("on"); }, 220);
  } else final?.classList.add("on");
  setTimeout(() => final?.classList.remove("on"), 700);
}
function tell({ turn, button, said }) {
  game.told = turn;
  $("said").innerHTML = said.doubt !== null && said.chosen !== button
    ? `Jev reached for <b>${NAMES[said.chosen]}</b>, doubted it (${pct(said.doubt)} safe), and pressed <b>${NAMES[button]}</b>`
    : `Jev pressed <b>${NAMES[button]}</b> · ${pct(said.sure)} sure`;
  const thoughts = [];
  if (said.danger !== null && said.danger >= 0.5) thoughts.push(`Senses danger (${pct(said.danger)})`);
  if (said.potion) thoughts.push("Drinks the potion on its last heart");
  $("thoughts").replaceChildren(...thoughts.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
}
function logTurn({ turn, events }) {
  const li = document.createElement("li");
  li.innerHTML = `<small>${turn}</small>`;
  li.append(`The knight ${events.join(", ") || "stood still"}.`);
  $("log").prepend(li);
  while ($("log").children.length > 6) $("log").lastChild.remove();
}
function showHud(hud) {
  if (!hud) return;
  $("hud").innerHTML = `<span class="hearts">${"♥".repeat(Math.max(0, hud.hearts))}${"♡".repeat(Math.max(0, 3 - hud.hearts))}</span><span>LEVEL ${hud.level}</span><span>COINS ${hud.coins}</span><span>SCORE ${hud.score}</span><span class="grow"></span><span>${hud.potion ? "POTION" : ""}</span>`;
}
function banner(title, sub = "") {
  const el = $("banner");
  if (!title) { el.classList.remove("on"); return; }
  el.querySelector("b").textContent = title; el.querySelector("span").textContent = sub; el.classList.add("on");
}

/** Where the knight is, t ms into a turn. */
function knightAt(a, t) {
  const m = a.message, e = clamp(t / a.move, 0, 1);
  if (t <= a.move) {
    const x = lerp(m.from, m.to, e); // a steady pace, so steps and runs flow into each other
    const y = m.button === "jump" && m.to !== m.from ? -Math.sin(Math.PI * e) * 26 : 0;
    return { x, y, walking: m.button !== "jump" && m.to !== m.from };
  }
  if (m.fell) { const f = clamp((t - a.move) / 260, 0, 1); return f < 1 ? { x: m.to, y: f * f * 70 } : { x: m.x, y: 0, blink: true }; }
  if (m.x !== m.to) { const f = clamp((t - a.move) / 160, 0, 1); return { x: lerp(m.to, m.x, f), y: -Math.sin(Math.PI * f) * 7 }; }
  return { x: m.to, y: 0, blink: m.hurt };
}

function effects(a) { // the moment the move lands: what was defeated, collected or lost
  const m = a.message, now = new Set(m.scene.mobs.map((x) => x.id));
  for (const [id, old] of a.before) if (!now.has(id)) burst(old.x * T + 8, old.kind === "bat" ? GROUND - 30 : GROUND - 6, old.kind === "crate" ? ["#9b6a3c", "#6b4726"] : old.kind === "fireball" ? ["#ff7a1a", "#ffd23f"] : ["#46c46a", "#9cf0b0", "#ffffff"]);
  for (const c of a.coins) if (!m.scene.coins.includes(c)) { burst(c * T + 8, GROUND - 10, ["#ffd23f", "#fff6c2"], 8); floater("+10", c * T + 4, GROUND - 22, "#ffd23f"); }
  for (const c of a.highCoins) if (!m.scene.highCoins.includes(c)) { burst(c * T + 8, GROUND - 40, ["#ffd23f", "#fff6c2"], 8); floater("+10", c * T + 4, GROUND - 52, "#ffd23f"); }
  if (m.hurt) { floater(m.fell ? "OOPS" : "OUCH", m.to * T, GROUND - 34, "#ff4d6d"); }
  if (m.events.includes("squashed a slime")) { burst(m.to * T + 8, GROUND - 4, ["#46c46a", "#9cf0b0", "#ffffff"]); floater("SQUASH +20", m.to * T, GROUND - 30, "#9cf0b0"); }
  if (m.events.some((e) => e.startsWith("defeated"))) floater(m.events.find((e) => e.startsWith("defeated the Slime King")) ? "+200" : "+20", (m.from + 1) * T, GROUND - 30, "#9cf0b0");
  showHud(m.hud);
}
function finish(a) {
  const m = a.message;
  game.scene = m.scene; game.x = m.x;
  logTurn(m);
  if (m.outcome) {
    banner(m.outcome === "flag" ? "LEVEL CLEAR!" : "OUT OF HEARTS", m.outcome === "flag" ? `+100 · on to level ${m.next.number}` : `level ${m.next.number} starts again`);
    game.anim = { hold: true, until: performance.now() + 1600, next: m.next };
    return;
  }
  game.anim = null;
}

// ---------- the loop ----------
function frame(now) {
  requestAnimationFrame(frame);
  if (!game.anim && game.queue.length) {
    while (game.queue.length > 6) { const skip = game.queue.shift(); game.scene = skip.next ?? skip.scene; game.x = skip.next ? 1 : skip.x; showHud(skip.hud); } // catching up after the tab slept
    begin(game.queue.shift());
  }
  const a = game.anim;
  if (a?.hold && now >= a.until) { game.scene = a.next; game.x = 1; banner(`LEVEL ${a.next.number}`, "go!"); setTimeout(() => { if (!game.anim && !game.waiting) banner(null); }, 900); game.anim = null; }
  if (!game.scene) return;
  let scene = game.scene, k = { x: game.x, y: 0 }, t = 0;
  if (a && !a.hold) {
    t = (now - a.start) * a.speed; scene = a.message.scene;
    k = knightAt(a, t);
    if (!a.effects && t >= a.move) { a.effects = true; effects(a); }
    if (t >= a.end) { finish(a); }
  }
  const target = clamp(k.x * T - W * 0.35, 0, scene.floor.length * T - W);
  game.cam += (target - game.cam) * 0.12;

  sky(now);
  tiles(scene, now);
  const e = a && !a.hold ? ease(clamp(t / a.move, 0, 1)) : 1;
  const passed = a && !a.hold ? lerp(a.message.from, a.message.to, clamp(t / a.move, 0, 1)) : Infinity; // coins go as the knight reaches them
  const coins = a && !a.hold ? new Set([...a.coins].filter((c) => !(c <= passed + 0.5 && !scene.coins.includes(c)))) : new Set(scene.coins);
  const high = a && !a.hold && t < a.move / 2 ? a.highCoins : new Set(scene.highCoins);
  for (const c of coins) coin(c * T - game.cam, GROUND - 13, now, c);
  for (const c of high) coin(c * T - game.cam, GROUND - 42, now, c);
  for (const m of scene.mobs) {
    const before = a && !a.hold ? a.before.get(m.id) : null;
    const x = before ? lerp(before.x, m.x, e) : m.x, low = before ? lerp(before.high ? 0 : 1, m.high ? 0 : 1, e) : m.high ? 0 : 1;
    mob(m, x, low, now);
  }
  if (a && !a.hold && t < a.move) for (const [id, old] of a.before) if (!scene.mobs.some((m) => m.id === id)) mob(old, old.x, old.high ? 0 : 1, now); // until the hit lands
  const swing = a && !a.hold && a.message.button === "press_x" ? clamp(1 - t / 260, 0, 1) : 0;
  knight(k.x, k.y, now, !!k.walking, swing, k.blink && Math.floor(now / 70) % 2 === 0);
  if (!a && !game.waiting) thinking(game.x, now);

  for (const p of game.particles) { p.x += p.vx; p.y += p.vy; p.vy += p.gravity ?? 0; p.life--; ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x - game.cam), Math.round(p.y), 2, 2); }
  game.particles = game.particles.filter((p) => p.life > 0);
  ctx.font = "bold 8px ui-monospace, Menlo, monospace"; ctx.textAlign = "center";
  for (const f of game.floaters) {
    const age = (now - f.born) / 900;
    ctx.globalAlpha = clamp(1 - age, 0, 1); ctx.fillStyle = "#000"; ctx.fillText(f.text, Math.round(f.x + 8 - game.cam), Math.round(f.y - age * 16) + 1);
    ctx.fillStyle = f.color; ctx.fillText(f.text, Math.round(f.x + 8 - game.cam), Math.round(f.y - age * 16)); ctx.globalAlpha = 1;
  }
  game.floaters = game.floaters.filter((f) => now - f.born < 900);
}
requestAnimationFrame(frame);

// ---------- the stream of turns ----------
const events = new EventSource("/events");
events.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "hello") {
    game.scene = message.scene; game.x = message.x; showHud(message.hud);
    $("jeview").href = message.jeview;
  } else if (message.type === "waiting") {
    game.waiting = message.reason; banner("WAITING FOR JEV", message.reason); $("said").textContent = message.reason;
  } else if (message.type === "turn") game.queue.push(message);
  else if (message.type === "thought" && message.turn === game.told) { // a side question answered after the move
    const li = document.createElement("li");
    li.textContent = `Sees ${words(message.sees)}${message.plan ? `, would ${words(message.plan)}` : ""}`;
    $("thoughts").append(li);
  }
};
events.onerror = () => { if (!game.anim) banner("PAUSED", "the game server is not running"); };
events.onopen = () => { if (!game.waiting) banner(null); };
