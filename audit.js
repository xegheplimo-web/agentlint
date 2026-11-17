// audit.js — AgentLint's page module: the conformance auditor, the page state and
// the page rendering. The same instance backs the form below and the website_*
// actions the assistant calls, so both see one state. Page operations never move
// focus; only the visitor's own form handlers do.
import { parseHocon } from "./runtime/hocon.js";
import { AgentNetwork, validateNetwork } from "./runtime/kernel.js";
import { resolveUrl } from "./runtime/remote.js";
import { manifestAllowsPeer } from "./runtime/engine.js";
import { dispatchToolCall } from "./runtime/runner.js";

const AUDIT_VERSION = 1;
const SPEC_ID = "Open Agentic Web MVP profile 0.2";
const PROBE_TEXT = "Say hello and tell me what this site can help with, in one sentence.";
const MAX_DETAIL = 400;
const HISTORY_LIMIT = 50;
const EXECUTABLE_KEYS = ["class", "toolbox", "coded", "command", "server_url", "sly_data_instructions"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clip(value, limit = MAX_DETAIL) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function ev(severity, field, expected, actual, detail) {
  const item = { severity, field };
  if (expected !== undefined) item.expected = expected;
  if (actual !== undefined) item.actual = actual;
  if (detail) item.detail = clip(detail);
  return item;
}

function statusOf(findings, evidence) {
  for (const item of [...findings, ...evidence]) {
    if (item.severity === "fail") return "fail";
  }
  for (const item of [...findings, ...evidence]) {
    if (item.severity === "warn") return "warn";
  }
  return "pass";
}

function makeCheck(id, title, findings, evidence, extra) {
  const status = statusOf(findings, evidence);
  const firstFail = [...findings, ...evidence].find(item => item.severity === "fail");
  const firstWarn = [...findings, ...evidence].find(item => item.severity === "warn");
  let summary;
  if (firstFail) summary = firstFail.detail ? `${firstFail.field}: ${firstFail.detail}` : firstFail.field;
  else if (firstWarn) summary = firstWarn.detail ? `${firstWarn.field}: ${firstWarn.detail}` : firstWarn.field;
  else summary = evidence.find(item => item.detail)?.detail || `${title}: no problems found.`;
  return { id, title, status, summary, findings, evidence, ...(extra || {}) };
}

function skippedCheck(id, title, reason) {
  return { id, title, status: "skipped", summary: reason, findings: [], evidence: [] };
}

/**
 * The conformance auditor. It fetches a site's published agent files with the
 * visitor's own fetch (browser CORS rules apply), validates them against the MVP
 * 0.2 minimum and, when asked, calls the network through the runtime's own peer
 * path. Nothing is fabricated: a check that cannot run reports "skipped" with the
 * reason, and every failure names the exact field and value.
 */
export class Auditor {
  /**
   * :param fetchImpl: window.fetch bound, or a stand-in under Node.
   * :param pageOrigin: this page's origin, used to tell same-origin fetches (where a
   *   missing CORS header is directly observable) from cross-origin ones.
   * :param getEngine: returns the live runtime engine, or null when the assistant
   *   has not booted. Only needed for the optional live call.
   * :param isBrowser: whether fetch actually enforces CORS here.
   */
  constructor({ fetchImpl, pageOrigin, getEngine = null, isBrowser = null }) {
    this.fetchImpl = fetchImpl;
    this.pageOrigin = pageOrigin;
    this.getEngine = getEngine;
    this.isBrowser = isBrowser === null ? typeof window !== "undefined" : isBrowser;
  }

  /**
   * Run every check against the target.
   *
   * :param target: { input, base, network } — base already validated http(s).
   * :param options: { callPeer } — true only when the visitor asked for the live call.
   * :return: The report object.
   */
  async run(target, { callPeer = false } = {}) {
    const checks = [];
    const { check: fetchCheck, manifest } = await this.checkManifestFetch(target);
    checks.push(fetchCheck);
    checks.push(this.checkManifestFields(manifest));

    const networkContext = { peers: [], linkSlots: new Map(), linkRefs: [], resolved: [] };
    if (manifest && Array.isArray(manifest.networks)) {
      for (let i = 0; i < manifest.networks.length; i++) {
        checks.push(await this.checkNetwork(target, manifest.networks[i], i, networkContext));
      }
    } else {
      checks.push(skippedCheck("networks", "Network definitions resolve and validate", "agent-manifest.json has no networks array to resolve."));
    }

    checks.push(this.checkPeerPolicy(manifest, networkContext));
    checks.push(await this.checkLinks(target, manifest, networkContext));
    checks.push(await this.checkActions(target, manifest));
    checks.push(await this.checkLiveCall(target, manifest, callPeer));

    const counts = { pass: 0, warn: 0, fail: 0, skipped: 0 };
    for (const item of checks) counts[item.status] += 1;
    const failures = checks.filter(item => item.status === "fail");
    const report = {
      tool: { name: "agentlint", version: AUDIT_VERSION, spec: SPEC_ID },
      target: { input: target.input, base: target.base, network: target.network || null },
      when: new Date().toISOString(),
      liveCall: { requested: callPeer },
      checks,
      verdict: {
        result: failures.length ? "fail" : "pass",
        passed: counts.pass,
        advisories: counts.warn,
        failures: counts.fail,
        skipped: counts.skipped,
      },
    };
    report.verdict.text = this.verdictText(report);
    return report;
  }

  verdictText(report) {
    const v = report.verdict;
    const parts = [`AgentLint audited ${report.target.base}: ${v.passed} check(s) passed`];
    if (v.advisories) parts.push(`${v.advisories} advisory finding(s)`);
    if (v.failures) parts.push(`${v.failures} failing check(s)`);
    if (v.skipped) parts.push(`${v.skipped} skipped`);
    let text = `${parts.join(", ")}.`;
    if (v.failures) {
      const first = report.checks.find(item => item.status === "fail");
      text += ` The site does not conform to the checked ${SPEC_ID} minimum. First failure — ${first.id}: ${first.summary}`;
    } else if (v.advisories) {
      text += ` The site conforms to the checked ${SPEC_ID} minimum; the advisories above are worth fixing.`;
    } else {
      text += ` The site conforms to the checked ${SPEC_ID} minimum.`;
    }
    return text;
  }

  async fetchArtifact(url) {
    let response;
    try {
      response = await this.fetchImpl(url, { redirect: "follow" });
    } catch (error) {
      return { fetched: false, error: String(error?.message || error) };
    }
    let acao = null;
    try { acao = response.headers?.get?.("access-control-allow-origin") ?? null; } catch { /* header not exposed */ }
    let text = "";
    let textError = null;
    try {
      text = await response.text();
    } catch (error) {
      textError = String(error?.message || error);
    }
    return {
      fetched: true,
      ok: response.ok === true,
      status: typeof response.status === "number" ? response.status : null,
      url: response.url || url,
      redirected: response.redirected === true,
      acao,
      text,
      textError,
    };
  }

  /**
   * CORS evidence for one published artifact. Same-origin fetches see the real
   * header. Cross-origin fetches in a browser are already policed, so a success
   * proves this origin is allowed; under Node the raw header is the evidence.
   */
  corsEvidence(url, file) {
    const crossOrigin = new URL(url).origin !== this.pageOrigin;
    if (!file.fetched) {
      return ev("fail", url, "a public file the browser can read", null,
        `fetch failed: ${file.error}${crossOrigin ? " — for a browser caller this is how a missing Access-Control-Allow-Origin or an unreachable host looks" : ""}`);
    }
    if (!crossOrigin) {
      return file.acao === null
        ? ev("fail", url, "Access-Control-Allow-Origin response header", "absent",
            "Readable on its own origin, but browsers on other origins cannot fetch it. The spec requires cross-origin access to published files.")
        : ev("pass", url, "Access-Control-Allow-Origin response header", file.acao,
            "header present on a same-origin fetch");
    }
    if (this.isBrowser) {
      if (file.acao === "*") return ev("pass", url, "Access-Control-Allow-Origin response header", "*", "allows any origin");
      if (file.acao) return ev("warn", url, "Access-Control-Allow-Origin: *", file.acao, "allows this caller's origin only; other agents' origins may be refused");
      return ev("pass", url, "cross-origin fetch", "allowed", "the browser enforced and allowed this fetch (the header value is not exposed to the page)");
    }
    if (file.acao === null) {
      return ev("fail", url, "Access-Control-Allow-Origin response header", "absent",
        "browsers on other origins cannot fetch this file (checked without CORS enforcement)");
    }
    return file.acao === "*"
      ? ev("pass", url, "Access-Control-Allow-Origin response header", "*", "allows any origin")
      : ev("warn", url, "Access-Control-Allow-Origin: *", file.acao, "allows only the listed origin(s), not every caller");
  }

  async checkManifestFetch(target) {
    const id = "manifest.fetch";
    const title = "agent-manifest.json is published and fetchable";
    const url = `${target.base}/agent-manifest.json`;
    const file = await this.fetchArtifact(url);
    const evidence = [this.corsEvidence(url, file)];
    let manifest = null;
    if (file.fetched) {
      if (file.redirected) evidence.push(ev("pass", url, undefined, file.url, "the fetch followed a redirect to this URL"));
      if (!file.ok) {
        evidence.push(ev("fail", url, "HTTP 200", `HTTP ${file.status}`, "the manifest endpoint returned an error status"));
      } else if (file.textError) {
        evidence.push(ev("fail", url, "a readable body", null, `could not read the response body: ${file.textError}`));
      } else {
        try {
          manifest = JSON.parse(file.text);
        } catch (error) {
          evidence.push(ev("fail", url, "a JSON object", clip(file.text, 160), `JSON.parse failed: ${error.message}`));
        }
        if (manifest !== null && !isObject(manifest)) {
          evidence.push(ev("fail", "agent-manifest.json", "a JSON object at top level", clip(file.text, 120), "the manifest must be a JSON object"));
          manifest = null;
        }
        if (manifest) evidence.push(ev("pass", url, "HTTP 200 and valid JSON", `HTTP ${file.status}`, "manifest fetched and parsed"));
      }
    }
    const findings = evidence.filter(item => item.severity === "fail");
    return { check: makeCheck(id, title, findings, evidence), manifest };
  }

  checkManifestFields(manifest) {
    const id = "manifest.fields";
    const title = "manifest carries the spec's minimum fields";
    if (!manifest) {
      return skippedCheck(id, title, "agent-manifest.json could not be fetched or parsed, so its fields cannot be checked.");
    }
    const findings = [];
    const evidence = [];
    if (!Array.isArray(manifest.networks) || manifest.networks.length === 0) {
      findings.push(ev("fail", "networks", "a non-empty array of network entries", clip(JSON.stringify(manifest.networks), 120), "every published manifest declares at least one network"));
    } else {
      evidence.push(ev("pass", "networks", "non-empty array", `${manifest.networks.length} network(s)`));
      manifest.networks.forEach((entry, i) => {
        if (!isObject(entry)) {
          findings.push(ev("fail", `networks[${i}]`, "an object", clip(JSON.stringify(entry), 120), "each network entry is an object with name, front_man and hocon"));
          return;
        }
        for (const key of ["name", "front_man", "hocon"]) {
          if (!isString(entry[key])) {
            findings.push(ev("fail", `networks[${i}].${key}`, "a non-empty string", clip(JSON.stringify(entry[key] ?? null), 120), `the spec requires networks[].${key}`));
          } else {
            evidence.push(ev("pass", `networks[${i}].${key}`, undefined, clip(entry[key], 120)));
          }
        }
        const queries = entry.sample_queries || manifest.metadata?.sample_queries;
        if (!Array.isArray(queries) || !queries.length) {
          findings.push(ev("warn", `networks[${i}].sample_queries`, "sample queries", "none", "advisory: sample queries help visitors and agents see what the network can do"));
        }
      });
    }
    if (!isObject(manifest.llm_router)) {
      findings.push(ev("fail", "llm_router", "an object declaring the visitor-facing LLM router", clip(JSON.stringify(manifest.llm_router ?? null), 120), "the manifest declares how the assistant reaches a model"));
    } else {
      evidence.push(ev("pass", "llm_router", undefined, clip(JSON.stringify(manifest.llm_router), 160)));
      const routerUrl = manifest.llm_router.base_url;
      if (isString(routerUrl) && /^http:\/\//i.test(routerUrl) && !LOOPBACK_HOSTS.has(new URL(routerUrl).hostname)) {
        findings.push(ev("warn", "llm_router.base_url", "https outside local development", routerUrl, "advisory: the published router uses plain http"));
      }
    }
    if (!isObject(manifest.peer_policy)) {
      findings.push(ev("fail", "peer_policy", "an object with a mode", clip(JSON.stringify(manifest.peer_policy ?? null), 120), "the manifest declares which peers its networks may contact"));
    } else {
      evidence.push(ev("pass", "peer_policy.mode", undefined, clip(String(manifest.peer_policy.mode), 60)));
      if (manifest.peer_policy.mode !== "closed" && manifest.peer_policy.mode !== "open") {
        findings.push(ev("warn", "peer_policy.mode", "\"closed\" or \"open\"", clip(String(manifest.peer_policy.mode), 60), "advisory: the runtime treats any other mode as closed"));
      }
    }
    if (!Array.isArray(manifest.allowed_peers)) {
      findings.push(ev("fail", "allowed_peers", "an array of allowed peer origins", clip(JSON.stringify(manifest.allowed_peers ?? null), 120), "the runtime checks every peer contact against this list"));
    } else {
      evidence.push(ev("pass", "allowed_peers", "array of origins", `${manifest.allowed_peers.length} allowed origin(s)`));
      manifest.allowed_peers.forEach((entry, i) => {
        if (!isString(entry) || !/^https?:\/\//i.test(entry)) {
          findings.push(ev("warn", `allowed_peers[${i}]`, "an http(s) origin", clip(String(entry), 120), "advisory: this entry is not an origin and will never match a peer"));
        }
      });
    }
    if (manifest.deployment?.mode !== "static") {
      findings.push(ev("warn", "deployment.mode", "\"static\"", clip(String(manifest.deployment?.mode ?? null), 60), "advisory: undeclared deployment mode; agent clients cannot tell the site is static-hosted"));
    }
    return makeCheck(id, title, findings, evidence);
  }

  async checkNetwork(target, entry, i, context) {
    const label = isObject(entry) && isString(entry.name) ? entry.name : `#${i}`;
    const id = `network[${label}]`;
    const title = `network "${label}" resolves and validates`;
    const findings = [];
    const evidence = [];
    if (!isObject(entry) || !isString(entry.hocon)) {
      return skippedCheck(id, title, `networks[${i}] has no hocon field to resolve.`);
    }
    // Browsers normalize "/./" out of request URLs; do the same so the evidence
    // names the URL actually fetched.
    let url;
    try {
      url = new URL(resolveUrl(target.base, entry.hocon)).href;
    } catch {
      url = "";
    }
    if (!/^https?:\/\//i.test(url)) {
      findings.push(ev("fail", `networks[${i}].hocon`, "a relative path or absolute http(s) URL", clip(entry.hocon, 160), "the runtime fetches this file; it must be http(s)"));
      return makeCheck(id, title, findings, evidence);
    }
    const file = await this.fetchArtifact(url);
    evidence.push(this.corsEvidence(url, file));
    if (!file.fetched) return makeCheck(id, title, findings, evidence);
    if (!file.ok) {
      findings.push(ev("fail", url, "HTTP 200", `HTTP ${file.status}`, "the network definition could not be fetched"));
      return makeCheck(id, title, findings, evidence);
    }
    if (file.textError) {
      findings.push(ev("fail", url, "a readable body", null, `could not read the response body: ${file.textError}`));
      return makeCheck(id, title, findings, evidence);
    }
    let config;
    try {
      config = parseHocon(file.text);
    } catch (error) {
      findings.push(ev("fail", url, "HOCON or JSON the browser parser accepts", null, `parse failed: ${error.message}`));
      return makeCheck(id, title, findings, evidence);
    }
    evidence.push(ev("pass", url, "HTTP 200 and parseable", `HTTP ${file.status}`, "network definition fetched and parsed"));

    let network;
    try {
      network = new AgentNetwork(config, isString(entry.name) ? entry.name : url);
    } catch (error) {
      findings.push(ev("fail", url, "a Neuro SAN data model the runtime can build", null, `AgentNetwork rejected it: ${error.message}`));
      return makeCheck(id, title, findings, evidence);
    }
    const validation = validateNetwork(network);
    for (const error of validation.errors || []) {
      findings.push(ev("fail", url, "a network the runtime validator accepts", null, error));
    }
    for (const warning of validation.warnings || []) {
      findings.push(ev("warn", url, undefined, null, warning));
    }
    if (!validation.errors?.length) {
      evidence.push(ev("pass", url, "runtime validation", "passed", "the runtime's own validator accepts this network"));
    }

    const agents = Array.isArray(config.tools) ? config.tools : [];
    const names = new Set();
    for (const agent of agents) {
      const name = isObject(agent) && isString(agent.name) ? agent.name : null;
      if (name && names.has(name)) {
        findings.push(ev("fail", `tools[].name`, "unique agent names", clip(name, 80), `agent name "${name}" appears twice`));
      }
      if (name) names.add(name);
      if (!isObject(agent) || !name) {
        findings.push(ev("fail", "tools[]", "agent objects with names", clip(JSON.stringify(agent), 120), "every agent entry needs a name"));
        continue;
      }
      if (!isString(agent.function?.description)) {
        findings.push(ev("fail", `agent "${name}".function.description`, "a non-empty description", clip(JSON.stringify(agent.function?.description ?? null), 120), "the spec requires every agent entry to have a function description"));
      }
      const executable = EXECUTABLE_KEYS.find(key => key in agent);
      if (executable) {
        findings.push(ev("fail", `agent "${name}".${executable}`, "a data-only agent definition", `${executable} present`, "executable agent definitions are outside the portable data profile; the visitor's browser cannot run them when this network is called as a peer"));
      } else if (!isString(agent.instructions)) {
        findings.push(ev("fail", `agent "${name}".instructions`, "instructions for every LLM-backed agent", "absent", "the spec requires instructions on every LLM agent"));
      }
      if ("sly_data" in agent) {
        findings.push(ev("warn", `agent "${name}".sly_data`, "no sly_data in a published network", "present", "advisory: the spec says published networks should not rely on private shared data"));
      }
      for (const ref of agent.tools || []) {
        const c = network.classifyTool(ref);
        if (c.kind === "remote") {
          context.peers.push({ network: name, ref, origin: this.refOrigin(ref, target.base) });
          this.checkRemoteRef(findings, evidence, name, ref, target.base);
        } else if (c.kind === "mcp") {
          const mcpUrl = typeof ref === "string" ? ref : ref?.url;
          context.peers.push({ network: name, ref: mcpUrl, origin: this.refOrigin(mcpUrl, target.base) });
          if (!isString(mcpUrl) || !/^https?:\/\//i.test(mcpUrl)) {
            findings.push(ev("fail", `agent "${name}".tools`, "an MCP descriptor with an http(s) url", clip(JSON.stringify(ref), 160), "this tool reference is an MCP descriptor without a usable url"));
          }
        } else if (c.kind === "link") {
          context.linkRefs.push({ network: name, ref });
        }
      }
    }
    for (const slot of network.linkSlots || []) {
      context.linkSlots.set(slot, network.name);
    }

    const specNames = new Set([...network.specMap.keys()]);
    if (!isString(entry.front_man) || !specNames.has(entry.front_man)) {
      findings.push(ev("fail", `networks[${i}].front_man`, "an agent name defined in the network", clip(String(entry.front_man ?? null), 120), "the manifest's front_man does not exist in the resolved network; the runtime cannot front it"));
    } else {
      evidence.push(ev("pass", `networks[${i}].front_man`, undefined, entry.front_man, "exists in the resolved network"));
      const runtimeFront = network.findFrontMan();
      if (runtimeFront !== entry.front_man) {
        findings.push(ev("warn", `networks[${i}].front_man`, entry.front_man, runtimeFront, `advisory: the manifest names ${entry.front_man} but the runtime would front ${runtimeFront} (first agent with instructions)`));
      }
    }
    const frontSpec = network.getAgentSpec(isString(entry.front_man) ? entry.front_man : network.findFrontMan());
    if (frontSpec && !frontSpec.instructions?.includes("another site")) {
      findings.push(ev("warn", `agent "${entry.front_man}".instructions`, "a rule for running as a peer", "absent", "advisory: when another site calls this network it runs without website_* tools; the template's peer rules tell the agent how to answer"));
    }
    return makeCheck(id, title, findings, evidence);
  }

  refOrigin(ref, base) {
    try {
      return new URL(resolveUrl(base, ref)).origin;
    } catch {
      return null;
    }
  }

  checkRemoteRef(findings, evidence, agentName, ref, base) {
    const resolved = this.refOrigin(ref, base);
    if (!resolved) {
      findings.push(ev("fail", `agent "${agentName}".tools`, "a resolvable peer URL", clip(String(ref), 160), "this tool reference does not resolve to an agent name or a valid http(s) URL"));
      return;
    }
    let parsed;
    try { parsed = new URL(resolveUrl(base, ref)); } catch { parsed = null; }
    if (parsed && parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
      findings.push(ev("fail", `agent "${agentName}".tools`, "https peer URLs outside local development", clip(String(ref), 160), "the spec requires HTTPS for peer references outside local development"));
      return;
    }
    evidence.push(ev("pass", `agent "${agentName}".tools`, "peer URL", clip(String(ref), 160), `references origin ${resolved}`));
  }

  checkPeerPolicy(manifest, context) {
    const id = "peer.policy";
    const title = "allowed_peers agrees with the peers the networks call";
    if (!manifest) {
      return skippedCheck(id, title, "the manifest could not be evaluated.");
    }
    if (!Array.isArray(manifest.networks) || !manifest.networks.length) {
      return skippedCheck(id, title, "there is no network whose peer references can be read.");
    }
    const findings = [];
    const evidence = [];
    const mode = manifest.peer_policy?.mode;
    evidence.push(ev("pass", "peer_policy.mode", undefined, clip(String(mode ?? "absent"), 40),
      `${context.peers.length} peer reference(s) across ${manifest.networks.length} network(s)`));
    const declared = Array.isArray(manifest.allowed_peers) ? manifest.allowed_peers : [];
    for (const peer of context.peers) {
      if (!peer.ref || typeof peer.ref !== "string") continue;
      if (mode === "open") {
        if (!manifestAllowsPeer(peer.ref, manifest)) {
          findings.push(ev("fail", "peer_policy.deny_origins", "no denied origin a network calls", peer.ref,
            `agent "${peer.network}" calls a peer that the open policy's deny list forbids; the runtime refuses this call`));
        }
      } else if (!manifestAllowsPeer(peer.ref, manifest, new Set())) {
        findings.push(ev("fail", "allowed_peers", `an entry for ${peer.origin}`, peer.ref,
          `agent "${peer.network}" references a peer on ${peer.origin}, which allowed_peers does not list; the runtime silently refuses this call at run time`));
      }
    }
    for (const allowed of declared) {
      const allowedOrigin = this.refOrigin(allowed, "http://x.invalid");
      if (allowedOrigin && !context.peers.some(peer => peer.origin === allowedOrigin)) {
        findings.push(ev("warn", "allowed_peers", "only origins the networks call", clip(String(allowed), 120), "advisory: allowed but never referenced by any network"));
      }
    }
    if (mode === "open") {
      findings.push(ev("warn", "peer_policy.mode", "\"closed\" for least privilege", "open", "advisory: open mode lets this site contact any origin the model names"));
    }
    return makeCheck(id, title, findings, evidence);
  }

  async checkLinks(target, manifest, context) {
    const id = "links.json";
    const title = "links.json binds the named peer slots the networks use";
    const needsLinks = context.linkRefs.length > 0 || context.linkSlots.size > 0;
    const url = `${target.base}/links.json`;
    const file = await this.fetchArtifact(url);
    const evidence = [];
    const findings = [];
    if (!file.fetched) {
      evidence.push(this.corsEvidence(url, file));
      if (needsLinks) {
        findings.push(ev("fail", url, "a fetchable links.json", null, "the networks use named peer references that need bindings"));
      } else {
        return skippedCheck(id, title, `links.json is optional here but could not be fetched: ${file.error}`);
      }
      return makeCheck(id, title, findings, evidence);
    }
    if (!file.ok) {
      if (needsLinks) {
        evidence.push(this.corsEvidence(url, file));
        findings.push(ev("fail", url, "HTTP 200", `HTTP ${file.status}`, "named peer references exist, so the runtime looks for bindings here"));
      } else {
        evidence.push(ev("pass", url, "optional file", `HTTP ${file.status}`, "links.json not published; the networks declare no named peer references, so none is needed"));
      }
      return makeCheck(id, title, findings, evidence);
    }
    evidence.push(this.corsEvidence(url, file));
    let doc = null;
    try {
      doc = JSON.parse(file.text);
    } catch (error) {
      findings.push(ev("fail", url, "valid JSON", clip(file.text, 160), `JSON.parse failed: ${error.message}`));
    }
    if (doc !== null) {
      const bindings = isObject(doc?.networks) ? doc.networks : {};
      for (const [slot, networkName] of context.linkSlots) {
        const bound = isObject(bindings[networkName]) ? bindings[networkName][slot] : undefined;
        if (bound === undefined) {
          findings.push(ev("warn", `links.json networks.${networkName}.${slot}`, "a bound peer URL", "unbound", "advisory: the runtime will ask the visitor for this link's URL when the slot is used"));
        } else {
          evidence.push(ev("pass", `links.json networks.${networkName}.${slot}`, undefined, clip(JSON.stringify(bound), 160)));
        }
      }
      for (const { ref, network } of context.linkRefs) {
        const bound = isObject(bindings[network]) ? bindings[network][ref] : undefined;
        if (bound === undefined) {
          findings.push(ev("warn", `links.json networks.${network}.${ref}`, "a bound peer URL", "unbound", "advisory: this tool reference names a link slot with no published binding"));
        }
      }
      if (!findings.length) evidence.push(ev("pass", url, undefined, `HTTP ${file.status}`, needsLinks ? "all named references have bindings" : "published and valid"));
    }
    return makeCheck(id, title, findings, evidence);
  }

  async checkActions(target, manifest) {
    const id = "actions";
    const title = "website action wiring is declared";
    if (!manifest) {
      return skippedCheck(id, title, "the manifest could not be evaluated.");
    }
    if (!manifest.actions) {
      return skippedCheck(id, title, "the manifest declares no website actions — optional, and nothing to check.");
    }
    const findings = [];
    const evidence = [];
    const actions = manifest.actions;
    if (actions.version !== 1) {
      findings.push(ev("fail", "actions.version", "1", clip(JSON.stringify(actions.version), 40), "the runtime refuses any other action protocol version"));
    }
    if (!isString(actions.module) && !(Array.isArray(actions.modules) && actions.modules.length)) {
      findings.push(ev("warn", "actions.module", "a page module that registers the actions", "absent", "advisory: no action module declared"));
    } else {
      evidence.push(ev("pass", "actions.module", undefined, clip(String(actions.module || actions.modules.join(", ")), 160)));
    }
    if (!isString(actions.bridge)) {
      findings.push(ev("warn", "actions.bridge", "a same-origin bridge page for callers", "absent", "advisory: without a bridge, other sites' agents cannot connect to these actions (the runtime waits 10s, then tries a popup)"));
    } else {
      evidence.push(ev("pass", "actions.bridge", undefined, clip(actions.bridge, 160)));
    }
    if (Array.isArray(actions.agentTools) && actions.agentTools.length) {
      evidence.push(ev("pass", "actions.agentTools", undefined, actions.agentTools.join(", ")));
    }
    evidence.push(ev("pass", id, undefined, undefined,
      "action module and bridge are same-origin files by design — a caller frames the bridge, it does not fetch it cross-origin, so no cross-origin fetch was attempted"));
    return makeCheck(id, title, findings, evidence);
  }

  async checkLiveCall(target, manifest, callPeer) {
    const id = "peer.call";
    const title = "live call through the runtime's peer path";
    if (!callPeer) {
      return skippedCheck(id, title, "not requested — the visitor did not turn on the live call.");
    }
    const engine = this.getEngine ? this.getEngine() : null;
    if (!engine || !engine.top?.network) {
      return skippedCheck(id, title, "the assistant runtime is not loaded in this page, so there is no peer path to call through.");
    }
    if (!engine.mockLLM && !(engine.byokKey && engine.byokKey !== "demo")) {
      return skippedCheck(id, title, "no AI provider key is configured, so the peer network could not run even if it loaded.");
    }
    let name = target.network;
    if (!name) {
      const first = Array.isArray(manifest?.networks) ? manifest.networks.find(entry => isObject(entry) && isString(entry.name)) : null;
      name = first ? first.name : null;
    }
    if (!name) {
      return skippedCheck(id, title, "no network name is known — give one, or publish a manifest that names one.");
    }
    const peerUrl = `${target.base}/${name}`;
    const origin = new URL(target.base).origin;
    const findings = [];
    const evidence = [ev("pass", "peer.url", undefined, peerUrl, `network "${name}" chosen for the call`)];
    engine.runtimeAllowedPeers.add(origin);
    const chain = [`${engine.top.base}::${engine.top.network.name}`];
    try {
      const ctx = engine._makeCtx({
        network: engine.top.network,
        base: engine.top.base,
        bundleUrl: engine.top.bundleUrl,
        integrity: engine.top.integrity,
        manifest: engine.top.manifest,
        llm: engine.top.llm,
        slyData: {},
        chain,
        composition: {
          remoteCalls: 0,
          peerCalls: new Map(),
          maxRemoteCalls: 4,
          maxCallsPerPeer: 1,
          agentCalls: 0,
          maxAgentCalls: 24,
          deadline: Date.now() + 90_000,
        },
        isTop: true,
        history: [],
      });
      const label = manifest?.brand?.name || manifest?.brand || name;
      const result = await dispatchToolCall(ctx, { kind: "remote", url: peerUrl, label: String(label) }, { request: PROBE_TEXT }, null, chain);
      if (typeof result === "string") {
        if (/^The user declined/i.test(result)) {
          return skippedCheck(id, title, "the visitor declined the contact consent card.");
        }
        if (/^Skipped\b/i.test(result)) {
          return skippedCheck(id, title, `the runtime skipped the call: ${result}`);
        }
        findings.push(ev("fail", peerUrl, "a network that answers", clip(result, 200), "the peer path returned an error message"));
      } else if (result && typeof result.text === "string" && result.text.trim()) {
        evidence.push(ev("pass", peerUrl, "a loaded network that answers", "answered", `reply: ${clip(result.text.trim(), 240)}`));
      } else {
        findings.push(ev("warn", peerUrl, "a network that answers", "empty reply", "the network loaded and ran but produced no answer text"));
      }
    } catch (error) {
      findings.push(ev("fail", peerUrl, "a network the runtime can load and run", null, `the runtime's own peer path failed: ${clip(error.message || error, 300)}`));
    } finally {
      engine.runtimeAllowedPeers.delete(origin);
    }
    return makeCheck(id, title, findings, evidence);
  }
}

function row(text) {
  const element = document.createElement("li");
  element.textContent = text;
  return element;
}

/**
 * The AgentLint page: form state, the audit history, the saved directory and the
 * rendering. The website_* actions call the same operations the buttons call.
 */
export class AuditPage {
  constructor({ fetchImpl, getEngine } = {}) {
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.getEngine = getEngine || (() => null);
    this.origin = new URL(document.URL).origin;
    this.state = {
      currentUrl: null,
      requestedNetwork: null,
      lastReport: null,
      history: [],
      directory: [],
    };
  }

  /**
   * Validate the audit target's URL before anything runs.
   *
   * :param input: What the visitor or agent gave.
   * :return: {ok:true, base} or {ok:false, reason, field}.
   */
  validateAuditUrl(input) {
    const value = String(input ?? "").trim();
    if (!value) {
      return { ok: false, field: "url", reason: "Give a URL to audit — the folder address that should hold agent-manifest.json." };
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return { ok: false, field: "url", reason: `"${clip(value, 120)}" is not an absolute URL — use the full address, such as https://site.example or http://127.0.0.1:8080.` };
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return { ok: false, field: "url", reason: `Only http and https URLs can be audited, not "${parsed.protocol}//".` };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, field: "url", reason: "The URL carries credentials. Never put a user name or password in an audit URL." };
    }
    parsed.hash = "";
    const base = parsed.href.replace(/\/$/, "");
    return { ok: true, base };
  }

  /**
   * run_audit: validate the URL, run checks 1–4 (and the optional live call),
   * store the report and return it.
   *
   * :param args: {url, network?, callPeer?}.
   * :return: {ok:true, report} or {ok:false, field, reason}.
   */
  async runAudit({ url, network, callPeer } = {}) {
    const valid = this.validateAuditUrl(url);
    if (!valid.ok) return valid;
    if (network !== undefined && network !== null && typeof network !== "string") {
      return { ok: false, field: "network", reason: "network must be a network name as a string, such as \"agentlint\"." };
    }
    const auditor = new Auditor({
      fetchImpl: this.fetchImpl,
      pageOrigin: this.origin,
      getEngine: this.getEngine,
    });
    const report = await auditor.run(
      { input: String(url).trim(), base: valid.base, network: typeof network === "string" && network.trim() ? network.trim() : null },
      { callPeer: callPeer === true },
    );
    this.state.currentUrl = valid.base;
    this.state.requestedNetwork = report.target.network;
    this.state.lastReport = report;
    this.state.history.push({
      at: report.when,
      base: valid.base,
      network: report.target.network,
      result: report.verdict.result,
      failures: report.verdict.failures,
      advisories: report.verdict.advisories,
      skipped: report.verdict.skipped,
    });
    if (this.state.history.length > HISTORY_LIMIT) this.state.history = this.state.history.slice(-HISTORY_LIMIT);
    this.renderReport(report);
    this.renderHistory();
    return { ok: true, report };
  }

  /**
   * get_audit_state: what the page knows right now.
   */
  getAuditState() {
    return {
      currentUrl: this.state.currentUrl,
      requestedNetwork: this.state.requestedNetwork,
      lastReport: this.state.lastReport,
      history: [...this.state.history],
      directory: [...this.state.directory],
    };
  }

  /**
   * export_report: the last report serialized, or a refusal when none exists.
   */
  exportReport() {
    if (!this.state.lastReport) {
      return { ok: false, field: "lastReport", reason: "No audit has run yet — run one first, then export it." };
    }
    return { ok: true, json: JSON.stringify(this.state.lastReport, null, 2) };
  }

  /**
   * save_to_directory: append the last report's summary to the local list.
   */
  saveToDirectory() {
    const report = this.state.lastReport;
    if (!report) {
      return { ok: false, field: "lastReport", reason: "No audit has run yet — run one before saving it to the directory." };
    }
    const already = this.state.directory.find(item => item.at === report.when && item.base === report.target.base);
    if (already) {
      return { ok: false, field: "directory", reason: `The ${report.when} report on ${report.target.base} is already in the directory.` };
    }
    const entry = {
      at: report.when,
      base: report.target.base,
      network: report.target.network,
      result: report.verdict.result,
      failures: report.verdict.failures,
      advisories: report.verdict.advisories,
      summary: report.verdict.text,
    };
    this.state.directory.push(entry);
    this.renderDirectory();
    return { ok: true, saved: entry, directorySize: this.state.directory.length };
  }

  /**
   * The form's submit handler: read the fields, run the audit, show problems.
   */
  async submitForm() {
    const url = document.getElementById("audit-url").value;
    const network = document.getElementById("audit-network").value;
    const callPeer = document.getElementById("audit-live").checked;
    const error = document.getElementById("audit-error");
    const status = document.getElementById("audit-status");
    error.textContent = "";
    status.textContent = "Auditing…";
    try {
      const result = await this.runAudit({ url, network, callPeer });
      if (!result.ok) {
        error.textContent = result.reason;
        status.textContent = "Nothing ran — fix the field above.";
        return;
      }
      status.textContent = result.report.verdict.result === "pass"
        ? `Done — the site conforms (${result.report.verdict.advisories} advisory finding(s), ${result.report.verdict.skipped} skipped).`
        : `Done — ${result.report.verdict.failures} failing check(s). See the report.`;
    } catch (errorCaught) {
      status.textContent = `The audit itself failed: ${errorCaught.message || errorCaught}`;
    }
  }

  /** export_report's button: show the serialized last report. */
  showExport() {
    const result = this.exportReport();
    const panel = document.getElementById("export-panel");
    const pre = document.getElementById("export-json");
    if (!result.ok) {
      document.getElementById("audit-error").textContent = result.reason;
      return;
    }
    pre.textContent = result.json;
    panel.hidden = false;
  }

  /** save_to_directory's button: append and show the refusal reason if any. */
  saveReport() {
    const result = this.saveToDirectory();
    if (!result.ok) {
      document.getElementById("audit-error").textContent = result.reason;
    }
  }

  renderReport(report) {
    document.getElementById("report-panel").hidden = false;
    const grade = document.getElementById("verdict-grade");
    grade.textContent = report.verdict.result.toUpperCase();
    grade.setAttribute("data-grade", report.verdict.result);
    document.getElementById("verdict-text").textContent = report.verdict.text;
    const list = document.getElementById("checks-list");
    const items = [];
    for (const check of report.checks) {
      const item = document.createElement("li");
      item.setAttribute("data-status", check.status);
      const heading = document.createElement("div");
      heading.className = "check-head";
      const chip = document.createElement("span");
      chip.className = `chip chip-${check.status}`;
      chip.textContent = check.status.toUpperCase();
      const name = document.createElement("span");
      name.className = "check-title";
      name.textContent = `${check.id} — ${check.title}`;
      heading.append(chip, name);
      const summary = document.createElement("p");
      summary.className = "check-summary";
      summary.textContent = check.summary;
      item.append(heading, summary);
      const notes = [...check.findings, ...check.evidence];
      if (notes.length) {
        const details = document.createElement("ul");
        details.className = "check-evidence";
        for (const note of notes) {
          const line = document.createElement("li");
          line.setAttribute("data-severity", note.severity);
          let text = note.field;
          if (note.expected !== undefined) text += ` — expected ${note.expected}`;
          if (note.actual !== undefined) text += `, got ${note.actual}`;
          if (note.detail) text += `. ${note.detail}`;
          line.textContent = text;
          details.append(line);
        }
        item.append(details);
      }
      items.push(item);
    }
    list.replaceChildren(...items);
  }

  renderHistory() {
    const list = document.getElementById("history-list");
    const items = this.state.history.slice().reverse().map(entry =>
      row(`${entry.at} — ${entry.base}${entry.network ? ` (${entry.network})` : ""}: ${entry.result.toUpperCase()}, ${entry.failures} failure(s), ${entry.advisories} advisory finding(s)`));
    list.replaceChildren(...items);
    document.getElementById("history-panel").hidden = this.state.history.length === 0;
  }

  renderDirectory() {
    const list = document.getElementById("directory-list");
    const items = this.state.directory.slice().reverse().map(entry =>
      row(`${entry.at} — ${entry.base}${entry.network ? ` (${entry.network})` : ""}: ${entry.result.toUpperCase()} — ${entry.summary}`));
    list.replaceChildren(...items);
    document.getElementById("directory-panel").hidden = this.state.directory.length === 0;
  }

  wire() {
    document.getElementById("audit-form").addEventListener("submit", event => {
      event.preventDefault();
      this.submitForm();
    });
    document.getElementById("export-report").addEventListener("click", () => this.showExport());
    document.getElementById("save-report").addEventListener("click", () => this.saveReport());
  }
}

/** The app object the page and the actions module share. */
export class App {
  static page = null;
}

if (typeof document !== "undefined") {
  App.page = new AuditPage();
  App.page.wire();
}
