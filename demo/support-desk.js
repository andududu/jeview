// Support Desk's screen: each customer's message as a chat, the decisions Jev makes about it as chips under it, in the
// order they come, and the desk's reply: a template filled in with what Jev decided.
const $ = (id) => document.getElementById(id);
const TEAMS = { support: "Support", engineering: "Engineering", billing: "Billing", product: "Product" };
const TOPICS = { bug: "bug", billing: "billing", how_to: "how-to", feature_request: "feature request", account: "account", other: "other" };
const URGENCY = [["not urgent", ""], ["answer today", "today"], ["urgent", "urgent"]];
const LANGUAGES = { spanish: "Spanish", german: "German", french: "French" };
const KEPT = 14; // conversations on the page
const pct = (p) => `${Math.round(p * 100)}%`;
const threads = new Map(), counts = { support: 0, engineering: 0, billing: 0, product: 0 };

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}
const bold = (words) => el("b", "", words);
const initials = (name) => name.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase();

// ---------- the teams across the top ----------
for (const [key, name] of Object.entries(TEAMS)) {
  $("teams").append(el("div", "team", el("div", "top", el("span", "name", name), el("span", "count", "0")), el("span", "last", "")));
  $("teams").lastChild.dataset.team = key;
}
function handTo(team, thread) {
  const card = document.querySelector(`.team[data-team="${team}"]`);
  if (!card) return;
  card.querySelector(".count").textContent = String(++counts[team]);
  card.querySelector(".last").textContent = `${thread.from}: ${thread.message}`;
  card.classList.add("lit"); setTimeout(() => card.classList.remove("lit"), 1200);
}

// ---------- one conversation ----------
function open(ticket) {
  $("waiting")?.remove();
  const chips = el("div", "chips", el("span", "reading", "Jev is reading", el("i"), el("i"), el("i")));
  const node = el("article", "thread",
    el("div", "row", el("span", "avatar", initials(ticket.from)), el("div", "bubble", el("p", "who", ticket.from, el("small", "", ticket.plan)), el("p", "text", ticket.message))),
    chips);
  const thread = { ...ticket, node, chips, reply: null, said: {} };
  node.dataset.id = ticket.id;
  threads.set(ticket.id, thread);
  $("feed").append(node);
  while ($("feed").children.length > KEPT) { const oldest = $("feed").firstElementChild; threads.delete(Number(oldest.dataset.id)); oldest.remove(); }
  return thread;
}
function chip(thread, className, ...words) { thread.chips.querySelector(".reading")?.remove(); const node = el("span", `chip ${className}`, ...words); thread.chips.append(node); return node; }

/** The desk's reply, written again whenever Jev decides something more: a template, filled in with the decisions. */
function reply(thread) {
  const { team, upset = 0, urgency = 0, article, credit, spam } = thread.said, first = thread.from.split(" ")[0];
  if (!team && !spam) return;
  let words, className = "bubble reply";
  if (spam) { words = "Marked as spam. No reply sent."; className = "bubble note"; }
  else {
    const name = TEAMS[team] ?? "Support", sorry = upset >= 0.5 ? `I'm sorry about this, ${first}. ` : `Thanks, ${first}. `;
    const handed = urgency >= 1.5 ? `I've marked this urgent and ${name} is on it now.` : urgency >= 0.5 ? `${name} will get back to you today.` : `I've passed this to ${name}.`;
    words = sorry + (article ? `This guide should answer it: “${article}”. If it doesn't, reply here and ${name} will help.` : handed) + (credit ? " I've also added a credit to your account." : "");
  }
  if (!thread.reply) { thread.reply = el("div", "row out", el("div", className, words), spam ? null : el("span", "avatar desk", "T")); thread.node.append(thread.reply); }
  else { const bubble = thread.reply.firstElementChild; bubble.className = className; bubble.textContent = words; }
}

// ---------- what the desk server tells us ----------
const heard = {
  ticket: (m) => open(m),
  read(m, thread) {
    Object.assign(thread.said, { topic: m.topic, upset: m.upset, urgency: m.urgency ?? 0 });
    thread.topicChip = chip(thread, "", bold(TOPICS[m.topic] ?? m.topic), m.sure === null ? "" : ` · ${pct(m.sure)} sure`);
    const [words, className] = URGENCY[Math.max(0, Math.min(2, Math.round(m.urgency ?? 0)))];
    chip(thread, className, words);
    if (m.upset >= 0.5) chip(thread, "upset", `upset · ${pct(m.upset)}`);
    if (m.selfServe >= 0.5) chip(thread, "article", "an article could answer it");
  },
  reread(m, thread) { thread.topicChip?.classList.add("was"); thread.said.topic = m.topic; chip(thread, "", "read again: ", bold(TOPICS[m.topic] ?? m.topic)); },
  routed(m, thread) { thread.said.team = m.team; chip(thread, "team", `→ ${TEAMS[m.team] ?? m.team}`); handTo(m.team, thread); },
  credit(m, thread) { thread.said.credit = m.offer >= 0.5; chip(thread, m.offer >= 0.5 ? "credit" : "", m.offer >= 0.5 ? `credit offered · ${pct(m.offer)}` : `no credit · ${pct(1 - m.offer)}`); },
  article(m, thread) { thread.said.article = m.article; chip(thread, "article", `“${m.article}”`); },
  churn(m, thread) { if (m.score >= 1) chip(thread, m.score >= 1.5 ? "urgent" : "today", m.score >= 1.5 ? "likely to cancel" : "may cancel"); },
  spam(m, thread) { thread.said.spam = true; chip(thread, "urgent", `spam · ${pct(m.spam)}`); },
  language(m, thread) { chip(thread, "", LANGUAGES[m.language] ?? m.language); },
};
function hear(message) {
  if (message.type === "waiting") { if (!threads.size && $("waiting")) $("waiting").textContent = message.reason; return; }
  const thread = message.type === "ticket" ? null : threads.get(message.id);
  if (message.type !== "ticket" && !thread) return; // about a conversation that has scrolled away
  heard[message.type]?.(message, thread);
  if (thread) reply(thread);
}

const events = new EventSource("/events");
events.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.type !== "hello") return hear(message);
  $("jeview").href = message.jeview;
  $("feed").replaceChildren(el("p", "waiting", "Waiting for the first customer…")); $("feed").firstChild.id = "waiting"; threads.clear();
  for (const team of Object.keys(counts)) { counts[team] = 0; const card = document.querySelector(`.team[data-team="${team}"]`); card.querySelector(".count").textContent = "0"; card.querySelector(".last").textContent = ""; }
  for (const earlier of message.recent) hear(earlier); // what happened before this page opened
};
