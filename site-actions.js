// site-actions.js — registers AgentLint's page operations as website_* actions the
// assistant can call. Each wraps a method on App.page in audit.js, the same object
// the form uses, so agent and visitor share one state.
import { App } from "./audit.js";

/**
 * Register the actions with the runtime's registry.
 *
 * :param actions: The object with register() the runtime passes in.
 */
export async function registerActions(actions) {
  const page = () => {
    if (!App.page) throw new Error("The audit page is not loaded.");
    return App.page;
  };

  actions.register({
    name: "get_audit_state",
    description: "Read the page's audit state: the URL currently under audit, the last full report, the audit history and the saved directory entries.",
    effect: "read",
    availability: "local-only",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => page().getAuditState(),
  });

  actions.register({
    name: "run_audit",
    description: "Audit an agentic website for Open Agentic Web MVP 0.2 conformance: fetch its agent-manifest.json and each network definition it names, validate the spec's required fields and the Neuro SAN data model, and compare allowed_peers with the peers the networks actually call. callPeer additionally calls the network through this runtime's own peer path — the visitor may be asked for consent — and reports whether it loaded and answered. Returns {ok:false, reason} for anything that is not an absolute http(s) URL.",
    effect: "write",
    availability: "local-only",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The absolute http(s) base URL of the site to audit — the folder that should hold agent-manifest.json (the part of a network URL before the final segment).",
        },
        network: {
          type: "string",
          description: "Optional: the network name to check and to call, when the manifest lists several or when checking one by name.",
        },
        callPeer: {
          type: "boolean",
          description: "Optional: true only when the visitor explicitly asked for a live call. Then the network is contacted through the runtime's peer path; the visitor may see a consent card.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: (args) => page().runAudit(args),
  });

  actions.register({
    name: "export_report",
    description: "Return the last audit report serialized as a JSON string, for saving or quoting. Refuses when no audit has run.",
    effect: "read",
    availability: "local-only",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => page().exportReport(),
  });

  actions.register({
    name: "save_to_directory",
    description: "Append the last audit report's summary to the page's local directory of audited sites. Refuses when no audit has run or the same report is already saved.",
    effect: "write",
    availability: "local-only",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => page().saveToDirectory(),
  });
}
