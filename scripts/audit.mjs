// Runs the AgentLint auditor from Node against a site's base URL and prints the
// report — the same code the browser page and the run_audit action execute.
// Node's fetch does not enforce CORS, so cross-origin CORS results come from the
// raw Access-Control-Allow-Origin header rather than the browser's enforcement.
//
// Usage: node scripts/audit.mjs <site-base-url> [network-name] [--caller-origin <url>]
import { Auditor } from "../audit.js";

const args = process.argv.slice(2);
const positional = [];
let callerOrigin = "http://agentlint.invalid";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--caller-origin" && args[i + 1]) {
    callerOrigin = args[++i];
  } else {
    positional.push(args[i]);
  }
}
const [input, network] = positional;
if (!input) {
  console.error("Usage: node scripts/audit.mjs <site-base-url> [network-name] [--caller-origin <url>]");
  process.exit(2);
}

let base;
try {
  const parsed = new URL(input);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("not http(s)");
  parsed.hash = "";
  base = parsed.href.replace(/\/$/, "");
} catch {
  console.error(`"${input}" is not an absolute http(s) base URL.`);
  process.exit(2);
}

const auditor = new Auditor({ fetchImpl: (...a) => fetch(...a), pageOrigin: callerOrigin, isBrowser: false });
const report = await auditor.run({ input, base, network: network || null });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.verdict.result === "fail" ? 1 : 0;
