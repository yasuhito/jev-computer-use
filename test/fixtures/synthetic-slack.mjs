/**
 * Synthetic Slack-like page model shared by the fake CDP (deterministic
 * tests) and the local HTTP server (live-transport smoke). One JSON fixture
 * is the single source of truth; this module turns it into an ordered list
 * of elements and, for the server, into HTML.
 *
 * It imitates only the shapes the Slack profile cares about (sidebar
 * conversation links, a "Message #x" composer, a "Send now" button) plus
 * decoys the profile must never offer to the model. It is not Slack.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(new URL("./synthetic-slack-page.json", import.meta.url));

/**
 * @typedef {object} Conversation
 * @property {string} id
 * @property {string} name
 * @property {"channel"|"dm"} kind
 */

/**
 * @typedef {object} Decoy
 * @property {string} key
 * @property {"link"|"textbox"|"button"} role
 * @property {string} name
 * @property {string} [href]
 */

/**
 * @typedef {object} SyntheticPage
 * @property {string} title
 * @property {string} team
 * @property {Conversation[]} conversations
 * @property {Decoy[]} decoys
 */

/** @returns {SyntheticPage} */
export function loadSyntheticPage() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

/**
 * @param {SyntheticPage} page
 * @param {string} path
 * @returns {Conversation|null}
 */
export function conversationForPath(page, path) {
  const match = /^\/client\/([A-Z0-9]+)\/([A-Z0-9]+)\/?$/.exec(path);
  if (!match || match[1] !== page.team) return null;
  return page.conversations.find((c) => c.id === match[2]) ?? null;
}

/**
 * @param {Conversation} c
 */
export function sidebarLabel(c) {
  return c.kind === "dm" ? `${c.name} (direct message)` : `${c.name} (channel)`;
}

/**
 * @param {Conversation} c
 */
export function composerLabel(c) {
  return c.kind === "dm" ? `Message ${c.name}` : `Message #${c.name}`;
}

/**
 * @param {SyntheticPage} page
 * @param {Conversation} c
 */
export function conversationPath(page, c) {
  return `/client/${page.team}/${c.id}`;
}

/**
 * One element in document order. `key` is stable across renders.
 * @typedef {object} Element
 * @property {string} key
 * @property {"heading"|"link"|"textbox"|"button"|"statictext"} role
 * @property {string} name
 * @property {string|null} href
 * @property {string|null} value
 * @property {boolean} disabled
 */

/**
 * @param {SyntheticPage} page
 * @param {{path: string, draft: string, messages: string[]}} state
 * @returns {{conversation: Conversation|null, title: string, elements: Element[]}}
 */
export function buildElements(page, { path, draft, messages }) {
  const conversation = conversationForPath(page, path);
  const title = conversation ? `${sidebarLabel(conversation)} - ${page.title}` : page.title;
  /** @type {Element[]} */
  const elements = [];
  elements.push({
    key: "heading",
    role: "heading",
    name: conversation ? `#${conversation.name}` : "Not a conversation",
    href: null,
    value: null,
    disabled: false,
  });
  for (const c of page.conversations) {
    elements.push({
      key: `sidebar:${c.id}`,
      role: "link",
      name: sidebarLabel(c),
      href: conversationPath(page, c),
      value: null,
      disabled: false,
    });
  }
  if (conversation) {
    elements.push({
      key: "composer",
      role: "textbox",
      name: composerLabel(conversation),
      href: null,
      value: draft,
      disabled: false,
    });
    elements.push({
      key: "send",
      role: "button",
      name: "Send now",
      href: null,
      value: null,
      disabled: draft.trim().length === 0,
    });
  }
  for (const d of page.decoys) {
    elements.push({
      key: `decoy:${d.key}`,
      role: d.role,
      name: d.name,
      href: d.href ?? null,
      value: d.role === "textbox" ? "" : null,
      disabled: false,
    });
  }
  messages.forEach((text, i) => {
    elements.push({ key: `message:${i}`, role: "statictext", name: text, href: null, value: null, disabled: false });
  });
  return { conversation, title, elements };
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/**
 * Render the page as static HTML with a small inline script so the composer
 * and send button behave like a message form (client-side only; nothing is
 * stored anywhere).
 *
 * @param {SyntheticPage} page
 * @param {string} path
 * @returns {string}
 */
export function renderHtml(page, path) {
  const { conversation, title, elements } = buildElements(page, { path, draft: "", messages: [] });
  const sidebar = elements
    .filter((e) => e.key.startsWith("sidebar:"))
    .map((e) => `<li><a href="${escapeHtml(e.href ?? "#")}" aria-label="${escapeHtml(e.name)}">${escapeHtml(e.name)}</a></li>`)
    .join("\n");
  const decoys = page.decoys
    .map((d) => {
      if (d.role === "link") return `<li><a href="${escapeHtml(d.href ?? "#")}" aria-label="${escapeHtml(d.name)}">${escapeHtml(d.name)}</a></li>`;
      if (d.role === "textbox") return `<li><input type="text" aria-label="${escapeHtml(d.name)}" placeholder="${escapeHtml(d.name)}"></li>`;
      return `<li><button type="button" class="decoy" aria-label="${escapeHtml(d.name)}">${escapeHtml(d.name)}</button></li>`;
    })
    .join("\n");
  const main = conversation
    ? `<h1>#${escapeHtml(conversation.name)}</h1>
<ol id="messages" aria-label="Messages"></ol>
<div id="composer" role="textbox" contenteditable="true" aria-multiline="true" aria-label="${escapeHtml(composerLabel(conversation))}"></div>
<button id="send" type="button" aria-label="Send now" disabled>Send</button>`
    : `<h1>Not a conversation</h1><p>This path is not a conversation of the synthetic workspace.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: sans-serif; margin: 0; display: grid; grid-template-columns: 220px 1fr 220px; min-height: 100vh; }
nav, aside { padding: 12px; background: #f3f3f3; }
main { padding: 12px; }
ul, ol { list-style: none; padding: 0; }
li { margin: 6px 0; }
#composer { min-height: 60px; border: 1px solid #888; padding: 8px; white-space: pre-wrap; }
#messages li { padding: 4px 0; border-bottom: 1px solid #ddd; }
</style>
</head>
<body>
<nav aria-label="Conversations"><ul>
${sidebar}
</ul></nav>
<main>
${main}
</main>
<aside aria-label="Decoys"><ul>
${decoys}
</ul></aside>
<script>
(function () {
  var composer = document.getElementById("composer");
  var send = document.getElementById("send");
  var messages = document.getElementById("messages");
  if (composer && send && messages) {
    composer.addEventListener("input", function () {
      send.disabled = composer.textContent.trim() === "";
    });
    send.addEventListener("click", function () {
      var li = document.createElement("li");
      var p = document.createElement("p");
      p.textContent = composer.textContent;
      li.appendChild(p);
      messages.appendChild(li);
      composer.textContent = "";
      send.disabled = true;
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll("button.decoy"), function (button) {
    button.addEventListener("click", function () {
      document.title = "DECOY CLICKED: " + button.getAttribute("aria-label");
    });
  });
})();
</script>
</body>
</html>
`;
}
