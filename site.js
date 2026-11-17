// Mounts the assistant inside the existing page. Load it with:
//   <script type="module" src="site.js"></script>
// The page needs the mount markup's ids: #assistant-status, #agent-app and the
// data-ns-slot elements.
import { App } from "./audit.js";

/**
 * Boots the browser runtime in the page's assistant section.
 *
 * It points the runtime at this folder, so the manifest, network and actions load
 * from the same place as the page. AgentLint declares no irreversible actions, so
 * DIALOGS is empty and the runtime's own confirmation review is used for anything
 * that needs one (such as a partner site's action).
 */
export class AssistantMount {
  /**
   * The first chat message once the visitor has a key: what the assistant can do here.
   */
  static GREETING = "I can audit an agentic website for you — paste its base URL and I will fetch its manifest and network files and report what conforms to the Open Agentic Web MVP spec, what does not, and what I could not check. I can also tell you what the spec requires, export a report, or save it to your directory. Nothing is sent to another site without your consent.";

  /**
   * The confirmation dialog's words for each irreversible action. AgentLint has
   * none: run_audit and save_to_directory are writes the visitor can see and redo
   * on the page, so nothing here gets a site dialog.
   */
  static DIALOGS = {};

  /** The engine once start() booted, or null. */
  static engine = null;

  /**
   * Boot the runtime and report the result in the status line.
   *
   * :return: The runtime engine, or null when boot failed.
   */
  static async start() {
    const status = document.querySelector("#assistant-status");
    const siteBase = new URL("./", import.meta.url).href;
    try {
      // Load the runtime here, so a missing or broken runtime is reported too.
      const { boot } = await import("./runtime/index.js");
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
      });
      AssistantMount.engine = booted.engine;
      AssistantMount.defaultReview = booted.engine.onActionConfirm;
      booted.engine.onActionConfirm = AssistantMount.review;
      AssistantMount.defaultConsent = booted.engine.onConsent;
      booted.engine.onConsent = AssistantMount.consent;
      // The live audit call reaches the peer path through this engine.
      if (App.page) App.page.getEngine = () => AssistantMount.engine;
      // Without a key the chat cannot answer yet. This is the same test as the
      // runtime's "API key required" badge in runtime/ui.js.
      const needsKey = !booted.engine.mockLLM
        && (!booted.engine.byokKey || booted.engine.byokKey === "demo");
      status.textContent = needsKey
        ? "Assistant needs your AI provider key. Add it in AI model settings below."
        : "Assistant connected to this page.";
      if (!needsKey) {
        AssistantMount.greet();
      }
      return booted.engine;
    } catch (error) {
      // The page must keep working without the assistant.
      status.textContent = "The assistant could not load. You can still use the page directly.";
      console.error("Assistant startup failed", error);
      return null;
    }
  }

  /**
   * Replace the runtime's general first chat message with GREETING. "New chat" keeps the
   * first message, so the greeting stays for the whole visit.
   */
  static greet() {
    const first = document.querySelector("#ns-msgs .ns-msg.bot");
    if (first) {
      first.textContent = AssistantMount.GREETING;
    }
  }

  /**
   * Ask the visitor to confirm actions before they run. This page has no
   * irreversible actions of its own, so everything — such as a partner site's
   * action — goes to the runtime's own dialog.
   *
   * :param items: The actions waiting for confirmation, each with action, origin,
   *   effect and arguments.
   * :return: True when the visitor confirms.
   */
  static async review(items) {
    const confirmed = await (AssistantMount.defaultReview || (async () => false))(items);
    AssistantMount.keepFocusInChat();
    return confirmed;
  }

  /**
   * Ask the visitor, with the runtime's consent card, whether to contact a partner
   * site — including a live audit call. Focus the card while it waits, then put
   * focus back in the chat.
   *
   * :param info: What the card shows, such as the partner's label and host and the request.
   * :return: The card's answer, unchanged: "allow", "always" or "decline". The runtime
   *   allows the call when this returns nothing.
   */
  static async consent(info) {
    // defaultConsent() adds the card at once. The card has no role, and the stylesheet
    // hides the status line while it waits, so name the card and focus its title.
    const answer = (AssistantMount.defaultConsent || (async () => "decline"))(info);
    AssistantMount.focusConsentCard();
    const decision = await answer;
    // Answering the card removes its buttons, so focus may fall to the page body.
    AssistantMount.keepFocusInChat();
    return decision;
  }

  /**
   * Name the newest consent card after its title, for screen readers. Move focus to that
   * title when focus is in the chat or on the page body, not from the page's own form.
   */
  static focusConsentCard() {
    const cards = document.querySelectorAll("#ns-msgs .ns-consent");
    const card = cards[cards.length - 1];
    const title = card ? card.querySelector(".ns-consent-title") : null;
    if (!title) {
      return;
    }
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", title.textContent);
    // A visitor typing in the page's own form keeps focus, and their keystrokes.
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest("#agent-app")) {
      return;
    }
    // tabIndex -1 lets the title take focus. Enter cannot activate a title, so a stray
    // Enter answers nothing.
    title.tabIndex = -1;
    title.focus();
  }

  /**
   * Put focus back in the chat input when a dialog or the consent card left it on
   * the page body. A chat form disables its controls when it is sent, so focus can
   * fall to the body, and the next Tab would start at the top of the page.
   */
  static keepFocusInChat() {
    if (document.activeElement === document.body || document.activeElement === null) {
      document.querySelector("#ns-input")?.focus();
    }
  }
}

// Boot only in a browser. Node tests import this file to check the words.
if (typeof window !== "undefined") {
  await AssistantMount.start();
}
