// Jeview: a local visualizer for Jev, with a live view of every call (README.md).
//   node jeview.ts [--port 4777] [--dir ~/.local/share/jeview]
// Open http://127.0.0.1:4777/, add your Jev key (the key icon), and send Jev requests to http://127.0.0.1:4777/v1/systemone
// (or /<label>/v1/systemone) instead of https://api.typesafe.ai/v1/systemone. --jev-endpoint points it at a local mock.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createJeview } from "./src/jeview.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "4777" }, dir: { type: "string", default: join(homedir(), ".local/share/jeview") }, "jev-endpoint": { type: "string" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Usage: node jeview.ts [--port 4777] [--dir ~/.local/share/jeview] [--jev-endpoint URL]");
const { server, store } = createJeview({ dir: values.dir, port, ...(values["jev-endpoint"] ? { jevEndpoint: values["jev-endpoint"] } : {}) });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.close(); process.exit(0); });
// a port that is taken, most often by a Jeview already running, is said in a sentence
server.on("error", (error: NodeJS.ErrnoException) => { console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use. If Jeview is already running, open http://127.0.0.1:${port}/; otherwise start this one on another port: --port ${port + 1}` : `Jeview could not start: ${error.message}`); process.exit(1); });
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ viewer: `http://127.0.0.1:${port}/`, send_jev_requests_to: `http://127.0.0.1:${port}/v1/systemone`, jev_key: store.setting("jevKey") ? "set" : "not set: add it in the viewer (the key icon, top right)", database: store.database, recorded: store.count() })));
