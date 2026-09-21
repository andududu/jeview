// Support Desk: a made-up support inbox that Jev triages through Jeview, drawn live in the browser.
//
//   node demo/support-desk.ts [--port 4782] [--proxy http://127.0.0.1:4777] [--label support-desk] [--pace 2600] [--fail 0.03]
//
// Open http://127.0.0.1:4782/ to watch. Made-up customers write in, one every --pace milliseconds or so. Jev reads each
// message once (what it is about, how urgent, is the customer upset, could a help article answer it), and some answers
// lead on to more questions, each sent with a Jeview-Trigger header naming the answer that led to it: the topic decides
// which team takes it, a topic Jev was unsure of is read again with the customer's account beside it, an upset customer
// may be offered a credit, a message an article could answer gets the article, and one about nothing we do is checked
// for spam. Now and then Jev is also asked whether the customer may leave or what language the message is in, and
// --fail says how often a message also sends a call Jev rejects. Open Jeview beside it to watch Jev think. It runs only while a page is open,
// and every call goes to the real Jev through Jeview (two to four a message, about ten cents an hour).
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4782" },
    proxy: { type: "string", default: "http://127.0.0.1:4777" },
    label: { type: "string", default: "support-desk" },
    pace: { type: "string", default: "2600" },
    fail: { type: "string", default: "0.03" },
  },
});
const port = Number(values.port), proxy = values.proxy.replace(/\/+$/, ""), pace = Number(values.pace), failRate = Number(values.fail);
const url = `${proxy}${values.label ? `/${encodeURIComponent(values.label)}` : ""}/v1/systemone`;

// ---------- the questions Jev is asked ----------
const GUIDELINES = "We make Tally, invoicing software for small teams. Plans: Free, Pro and Team. Engineering takes anything broken: errors, crashes, data that is wrong or missing. Billing takes charges, refunds, invoices and plan changes. Product takes ideas and feature requests. Support takes how-to questions, account changes and everything else. A message is urgent when the customer cannot work or is losing money, and not urgent when it is an idea or a general question. Offer a credit only to a paying customer whom we let down: charged wrongly, or unable to work for a day or more. Never offer a credit to a Free customer, or for a feature we do not have.";
const ARTICLES = { reset_password: "Reset your password", invite_teammates: "Invite teammates and set their roles", export_data: "Export invoices to CSV or PDF", change_plan: "Change or cancel your plan", connect_bank: "Connect a bank account", none: "none of these answers it" };
const QUESTIONS = {
  topic: { type: "choice", instructions: "What is `ticket` about, reading `support_guidelines`?", criteria: { bug: "something is broken", billing: "a charge, refund, invoice or plan", how_to: "how to do something", feature_request: "an idea or a feature we do not have", account: "a change to the account or its access", other: "anything else" } },
  urgency: { type: "score", instructions: "How urgent is `ticket`?", criteria: ["Not urgent: an idea or a general question", "Should be answered today", "Urgent: the customer cannot work or is losing money"] },
  upset: { type: "noul", instructions: "Does the customer who wrote `ticket` sound upset?" },
  selfServe: { type: "noul", instructions: "Could a help centre article answer `ticket` on its own?" },
  topicAgain: { type: "choice", instructions: "Reading `ticket` again with the customer's `account` beside it, what is it about, following `support_guidelines`?", criteria: { bug: "something is broken", billing: "a charge, refund, invoice or plan", how_to: "how to do something", feature_request: "an idea or a feature we do not have", account: "a change to the account or its access", other: "anything else" } },
  team: { type: "choice", instructions: "Which team should handle `ticket`, reading `support_guidelines`?", criteria: { support: "Support", engineering: "Engineering", billing: "Billing", product: "Product" } },
  credit: { type: "noul", instructions: "Should the customer who wrote `ticket` be offered a credit, reading `support_guidelines`?" },
  article: { type: "choice", instructions: "Which help centre article answers `ticket`?", criteria: ARTICLES },
  churn: { type: "score", instructions: "How likely is the customer who wrote `ticket` to cancel soon?", criteria: ["Unlikely", "Possible", "Likely"] },
  spam: { type: "noul", instructions: "Is `ticket` spam?" },
  language: { type: "choice", instructions: "Which language is `ticket` written in?", criteria: { english: "English", spanish: "Spanish", german: "German", french: "French" } },
};

// ---------- the customers, all made up ----------
type Plan = "Free" | "Pro" | "Team";
const MESSAGES: [string, Plan, string][] = [
  ["Maya R.", "Pro", "The invoice PDF comes out blank since this morning. I have three clients waiting on invoices today."],
  ["Tom B.", "Team", "We were charged twice for September. Please refund one of them."],
  ["Priya S.", "Free", "How do I add my accountant so she can see the invoices but not change them?"],
  ["Lukas W.", "Pro", "Es wäre toll, wenn man Rechnungen auch auf Deutsch verschicken könnte."],
  ["Dana K.", "Team", "THIRD time I am writing about this. Bank sync has been dead for two days and nobody answers. We cannot reconcile anything."],
  ["Oli P.", "Free", "Forgot my password and the reset email never arrives."],
  ["Sam T.", "Pro", "Could you add a dark mode? My eyes would thank you."],
  ["Inés M.", "Pro", "Hola, ¿cómo puedo exportar todas mis facturas del año a un CSV?"],
  ["Rob H.", "Team", "I need to move the account to a new owner, our founder is leaving at the end of the month."],
  ["Grace L.", "Pro", "Your app deleted a draft invoice I spent an hour on. This is unacceptable."],
  ["Noah F.", "Free", "Is there a discount for charities?"],
  ["Crypto Deals", "Free", "Congratulations!! You have been selected to DOUBLE your bitcoin. Click here within 24 hours."],
  ["Hana Y.", "Team", "Totals on the VAT report do not match the invoices. We file on Friday, so this is quite pressing."],
  ["Ben C.", "Pro", "How do I change my plan from monthly to yearly?"],
  ["Aisha N.", "Pro", "Love the product. One idea: recurring invoices that skip weekends."],
  ["Marco D.", "Team", "The app logs me out every five minutes since the update. It is driving the whole team mad."],
  ["Lena V.", "Free", "Can I use Tally for two companies with one login?"],
  ["Pete J.", "Pro", "I cancelled last month and you still took the payment. I want my money back."],
  ["Yuki A.", "Team", "Where do I find the API key for the accounting integration?"],
  ["Claire O.", "Pro", "Please change the email on my account to the new one in my signature."],
  ["Ahmed Z.", "Team", "Payment links return a 500 error. Customers cannot pay us. Please help, this is costing us money right now."],
  ["Sofia G.", "Free", "Would you be open to a partnership? We run a bookkeeping course."],
  ["Will E.", "Pro", "The mobile app shows yesterday's numbers, the website is right. Not urgent, just odd."],
  ["Nadia Q.", "Team", "Bonjour, nous avons été facturés pour 12 utilisateurs alors que nous sommes 9."],
  ["Jon S.", "Pro", "Honestly thinking of switching to a competitor. Too many small bugs lately and support takes days."],
  ["Eva T.", "Free", "How do I connect my bank account?"],
];
let next = Math.floor(Math.random() * MESSAGES.length), ids = 0;
/** The next customer to write in: the messages go round in order, from a random start. */
function incoming() {
  const [from, plan, message] = MESSAGES[next++ % MESSAGES.length]!;
  return { id: ++ids, from, plan, message, at: Date.now() };
}
/** What the desk knows about a customer, shown to Jev when it reads a message a second time. */
const account = (plan: Plan) => ({ plan, paying: plan !== "Free", customer_for: `${1 + Math.floor(Math.random() * 30)} months`, open_tickets: Math.floor(Math.random() * 3) });

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

/** One message: Jev reads it, and what it answers leads on. The page hears of each decision as it is made. */
async function triage() {
  const ticket = incoming(), { id } = ticket, state = { support_guidelines: GUIDELINES, ticket: { from: ticket.from, plan: ticket.plan, message: ticket.message } };
  remember({ type: "ticket", ...ticket });
  if (Math.random() < failRate) void ask(state, { mood_ring: { type: "maybe", instructions: "Is `ticket` a question type Jev knows?" } }).catch(() => null); // Jev rejects it
  const first = await ask(state, { topic: QUESTIONS.topic, urgency: QUESTIONS.urgency, upset: QUESTIONS.upset, self_serve: QUESTIONS.selfServe });
  if (!first) return false;
  const read = first.answers, upset = read.upset?.noul ?? 0, selfServe = read.self_serve?.noul ?? 0;
  let topic = read.topic?.choice ?? "other", from = first.events.topic;
  remember({ type: "read", id, topic, sure: read.topic?.confidence ?? null, urgency: read.urgency?.score ?? null, upset, selfServe });
  const after: Promise<unknown>[] = [];
  // the topic decides the team; a topic Jev was unsure of is read again first, with the customer's account beside it
  after.push((async () => {
    if ((read.topic?.confidence ?? 1) < 0.6) {
      const again = await ask({ ...state, account: account(ticket.plan) }, { topic_again: QUESTIONS.topicAgain }, from);
      const choice = again?.answers.topic_again?.choice;
      if (again && choice) { from = again.events.topic_again; if (choice !== topic) remember({ type: "reread", id, was: topic, topic: choice }); topic = choice; }
    }
    // a message about nothing we do may not be from a customer at all: spam goes to no team, and gets no reply
    if (topic === "other") {
      const spam = (await ask(state, { spam: QUESTIONS.spam }, from))?.answers.spam?.noul;
      if (typeof spam === "number" && spam >= 0.5) return remember({ type: "spam", id, spam });
    }
    const team = (await ask(state, { team: QUESTIONS.team }, from))?.answers.team?.choice;
    if (team) remember({ type: "routed", id, team });
  })());
  if (upset >= 0.5) after.push(ask({ ...state, account: account(ticket.plan) }, { credit: QUESTIONS.credit }, first.events.upset).then((reply) => {
    const offer = reply?.answers.credit?.noul;
    if (typeof offer === "number") remember({ type: "credit", id, offer });
  }));
  if (selfServe >= 0.5) after.push(ask(state, { article: QUESTIONS.article }, first.events.self_serve).then((reply) => {
    const article = reply?.answers.article?.choice;
    if (article && article !== "none") remember({ type: "article", id, article: ARTICLES[article as keyof typeof ARTICLES] ?? article });
  }));
  // asked only now and then, so they fade from Jeview's map between visits
  const roll = Math.random();
  if (roll < 0.1) after.push(ask(state, { churn: QUESTIONS.churn }).then((reply) => { const score = reply?.answers.churn?.score; if (typeof score === "number") remember({ type: "churn", id, score }); }));
  else if (roll < 0.17) after.push(ask(state, { language: QUESTIONS.language }).then((reply) => { const language = reply?.answers.language?.choice; if (language && language !== "english") remember({ type: "language", id, language }); }));
  await Promise.all(after.map((step) => step.catch(() => null)));
  return true;
}

// ---------- the page ----------
const watchers = new Set<ServerResponse>(), recent: Record<string, unknown>[] = [];
const broadcast = (message: unknown) => { const line = `data: ${JSON.stringify(message)}\n\n`; for (const watcher of watchers) watcher.write(line); };
/** Every decision goes to the pages that are open, and the latest are kept for a page that opens later. */
function remember(message: Record<string, unknown>) { recent.push(message); while (recent.length > 120) recent.shift(); broadcast(message); }
const FILES: Record<string, [string, string]> = { "/": ["support-desk.html", "text/html; charset=utf-8"], "/support-desk.js": ["support-desk.js", "text/javascript; charset=utf-8"] };
const server = createServer((req, res) => {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return void res.writeHead(403).end();
  const path = new URL(req.url ?? "/", "http://desk").pathname, file = FILES[path];
  if (file) { res.writeHead(200, { "content-type": file[1], "cache-control": "no-store" }); return void res.end(readFileSync(new URL(file[0], import.meta.url))); }
  if (path === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "hello", jeview: `${proxy}/`, recent })}\n\n`);
    watchers.add(res);
    req.on("close", () => watchers.delete(res));
    return;
  }
  res.writeHead(404).end();
});
server.listen(port, "127.0.0.1", () => console.log(`Support Desk: open http://127.0.0.1:${port}/ to watch Jev triage the inbox (through ${url}). Ctrl-C stops it.`));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// ---------- customers write in, while someone watches ----------
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
for (;;) {
  if (!watchers.size) { await sleep(400); continue; }
  // messages overlap, as in a real inbox: the next customer does not wait for Jev to finish with this one
  void triage().then((answered) => { if (!answered) broadcast({ type: "waiting", reason: "Jev did not answer. Is a Jev key set in Jeview (the key icon, top right)?" }); })
    .catch((error: Error) => broadcast({ type: "waiting", reason: `Jeview is not answering at ${proxy}: ${error.message}` }));
  await sleep(pace * (0.7 + Math.random() * 0.6));
}
