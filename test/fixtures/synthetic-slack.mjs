/**
 * Synthetic Slack-like page model shared by the fake CDP (deterministic
 * tests) and the local HTTP server (live-transport smoke). One JSON fixture
 * is the single source of truth; this module turns it into an ordered list
 * of elements and, for the server, into HTML.
 *
 * It imitates only the shapes the Slack profile cares about plus decoys the
 * profile must never offer to the model, in one of two shapes. It is not
 * Slack.
 *
 * - "links" (the fixture's default): an English page whose sidebar rows are
 *   `<a href="/client/T…/C…">` links, the composer is "Message #x", and the
 *   send button is "Send now".
 * - "tree": the shape the real Slack web client rendered in 2026 for a
 *   Japanese-locale account, as observed over CDP: `<html lang="ja-JP">`, a
 *   sidebar `role="tree"` of `role="treeitem"` rows that carry the
 *   conversation id in `data-item-key`, wrap their name in a `draggable`
 *   div (which makes Chromium compute an empty accessible name for the row)
 *   and have no link; a contenteditable composer with
 *   `data-qa="texty_input"` and a Japanese label; and a send button with
 *   `data-qa="texty_send_button"` and a Japanese label. Section headers and
 *   direct messages are rows too, so the profile must exclude them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(new URL("./synthetic-slack-page.json", import.meta.url));

/** @typedef {"links"|"tree"} Shape */
export const SHAPES = Object.freeze(["links", "tree"]);

/** Japanese UI strings of the tree shape (synthetic; not copied from a real account). */
const JA = Object.freeze({
  channelSuffix: "（チャンネル）",
  dmSuffix: "（ダイレクトメッセージ）",
  composerSuffix: " へのメッセージ",
  send: "メッセージを送信",
  channelsSection: "チャンネル",
  dmsSection: "ダイレクトメッセージ",
});

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
 * @property {Record<string, string>} [attributes]
 */

/**
 * @typedef {object} SyntheticPage
 * @property {string} title
 * @property {string} team
 * @property {Shape} shape
 * @property {Conversation[]} conversations
 * @property {Decoy[]} decoys
 */

/**
 * @param {{shape?: Shape}} [options]
 * @returns {SyntheticPage}
 */
export function loadSyntheticPage({ shape } = {}) {
  const page = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  return { ...page, shape: shape ?? page.shape ?? "links" };
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
 * The link text of a sidebar row in the links shape.
 * @param {Conversation} c
 */
export function sidebarLabel(c) {
  return c.kind === "dm" ? `${c.name} (direct message)` : `${c.name} (channel)`;
}

/**
 * The visible text of a sidebar row in the tree shape (the bare name, as Slack renders it).
 * @param {Conversation} c
 */
export function sidebarRowText(c) {
  return c.name;
}

/**
 * @param {Conversation} c
 * @param {Shape} [shape]
 */
export function composerLabel(c, shape = "links") {
  if (shape === "tree") return `${c.name}${JA.composerSuffix}`;
  return c.kind === "dm" ? `Message ${c.name}` : `Message #${c.name}`;
}

/** @param {Shape} [shape] */
export function sendLabel(shape = "links") {
  return shape === "tree" ? JA.send : "Send now";
}

/**
 * @param {Conversation} c
 * @param {Shape} shape
 */
function titleLabel(c, shape) {
  if (shape === "tree") return `${c.name}${c.kind === "dm" ? JA.dmSuffix : JA.channelSuffix}`;
  return sidebarLabel(c);
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
 * @property {"heading"|"link"|"treeitem"|"textbox"|"button"|"statictext"} role
 * @property {string} name the accessible name the fake browser reports (empty for tree rows, as Chromium does)
 * @property {string|null} text the static text below the element, or null when it has none
 * @property {string|null} href where activating the element navigates (links and tree rows)
 * @property {string|null} value
 * @property {boolean} disabled
 * @property {Record<string, string>} attributes element attributes the fake DOM reports
 */

/**
 * @param {SyntheticPage} page
 * @param {{path: string, draft: string, messages: string[]}} state
 * @returns {{conversation: Conversation|null, title: string, elements: Element[]}}
 */
export function buildElements(page, { path, draft, messages }) {
  const { shape } = page;
  const conversation = conversationForPath(page, path);
  const title = conversation ? `${titleLabel(conversation, shape)} - ${page.title}` : page.title;
  /** @type {Element[]} */
  const elements = [];
  elements.push({
    key: "heading",
    role: "heading",
    name: conversation ? `#${conversation.name}` : "Not a conversation",
    text: conversation ? `#${conversation.name}` : "Not a conversation",
    href: null,
    value: null,
    disabled: false,
    attributes: {},
  });
  if (shape === "tree") {
    elements.push(...treeRows(page, conversation));
  } else {
    for (const c of page.conversations) {
      elements.push({
        key: `sidebar:${c.id}`,
        role: "link",
        name: sidebarLabel(c),
        text: sidebarLabel(c),
        href: conversationPath(page, c),
        value: null,
        disabled: false,
        attributes: {},
      });
    }
  }
  if (conversation) {
    elements.push({
      key: "composer",
      role: "textbox",
      name: composerLabel(conversation, shape),
      text: draft,
      href: null,
      value: draft,
      disabled: false,
      attributes: shape === "tree" ? { "data-qa": "texty_input", contenteditable: "true", "aria-multiline": "true" } : {},
    });
    elements.push({
      key: "send",
      role: "button",
      name: sendLabel(shape),
      text: sendLabel(shape),
      href: null,
      value: null,
      disabled: draft.trim().length === 0,
      attributes: shape === "tree" ? { "data-qa": "texty_send_button" } : {},
    });
  }
  for (const d of page.decoys) {
    elements.push({
      key: `decoy:${d.key}`,
      role: d.role,
      name: d.name,
      text: d.role === "textbox" ? "" : d.name,
      href: d.href ?? null,
      value: d.role === "textbox" ? "" : null,
      disabled: false,
      attributes: { ...(d.attributes ?? {}) },
    });
  }
  messages.forEach((text, i) => {
    elements.push({ key: `message:${i}`, role: "statictext", name: text, text, href: null, value: null, disabled: false, attributes: {} });
  });
  return { conversation, title, elements };
}

/**
 * The sidebar of the tree shape: a section header row, the channel rows, a
 * second header, then the direct-message rows. Rows have no accessible
 * name (Chromium drops name-from-contents through the draggable wrapper);
 * headers are named by aria-label and carry a non-conversation key.
 *
 * @param {SyntheticPage} page
 * @param {Conversation|null} current
 * @returns {Element[]}
 */
function treeRows(page, current) {
  /** @type {Element[]} */
  const rows = [];
  /** @param {string} key @param {string} label */
  const header = (key, label) =>
    rows.push({
      key: `section:${key}`,
      role: "treeitem",
      name: label,
      text: null,
      href: null,
      value: null,
      disabled: false,
      attributes: { "data-qa": "virtual-list-item", "data-item-key": `section-${key}`, "aria-label": label, "aria-expanded": "true" },
    });
  /** @param {Conversation} c */
  const row = (c) =>
    rows.push({
      key: `sidebar:${c.id}`,
      role: "treeitem",
      name: "",
      text: sidebarRowText(c),
      href: conversationPath(page, c),
      value: null,
      disabled: false,
      attributes: { "data-qa": "virtual-list-item", "data-item-key": c.id, "aria-current": current?.id === c.id ? "true" : "false" },
    });
  header("channels", JA.channelsSection);
  for (const c of page.conversations) if (c.kind === "channel") row(c);
  header("dms", JA.dmsSection);
  for (const c of page.conversations) if (c.kind === "dm") row(c);
  return rows;
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/** @param {Record<string, string>} attributes */
function attributeMarkup(attributes) {
  return Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
}

/**
 * @param {SyntheticPage} page
 * @param {Element[]} elements
 */
function renderSidebar(page, elements) {
  if (page.shape !== "tree") {
    return `<nav aria-label="Conversations"><ul>
${elements
  .filter((e) => e.key.startsWith("sidebar:"))
  .map((e) => `<li><a href="${escapeHtml(e.href ?? "#")}" aria-label="${escapeHtml(e.name)}">${escapeHtml(e.name)}</a></li>`)
  .join("\n")}
</ul></nav>`;
  }
  const rows = elements
    .filter((e) => e.role === "treeitem")
    .map((e) => {
      const attrs = attributeMarkup({ role: "treeitem", tabindex: "-1", ...e.attributes });
      if (e.text === null) return `<div${attrs}></div>`;
      // A draggable wrapper, an icon, the name in nested spans, a hidden span,
      // and an empty suffix: the structure that hides the row's name from
      // Chromium's name-from-contents computation.
      return `<div${attrs} data-nav="${escapeHtml(e.href ?? "")}">
<div data-qa="channel-sidebar-channel" draggable="true"><svg aria-hidden="true" width="16" height="16"></svg><span data-qa="channel_sidebar_name_${escapeHtml(e.text)}"><span>${escapeHtml(e.text)}</span></span><span hidden>unread</span><span data-qa="sidebar-channel-suffix"></span></div>
</div>`;
    })
    .join("\n");
  return `<nav><div role="tree" aria-label="${escapeHtml(JA.channelsSection)}">
${rows}
</div></nav>`;
}

/**
 * Render the page as static HTML with a small inline script so the composer
 * and send button behave like a message form and, in the tree shape, so a
 * click on a sidebar row navigates the way Slack's rows do (client-side
 * only; nothing is stored anywhere).
 *
 * @param {SyntheticPage} page
 * @param {string} path
 * @returns {string}
 */
export function renderHtml(page, path) {
  const { shape } = page;
  const { conversation, title, elements } = buildElements(page, { path, draft: "", messages: [] });
  const sidebar = renderSidebar(page, elements);
  const decoys = page.decoys
    .map((d) => {
      const attrs = attributeMarkup(d.attributes ?? {});
      if (d.role === "link") return `<li><a href="${escapeHtml(d.href ?? "#")}" aria-label="${escapeHtml(d.name)}"${attrs}>${escapeHtml(d.name)}</a></li>`;
      if (d.role === "textbox") return `<li><input type="text" aria-label="${escapeHtml(d.name)}" placeholder="${escapeHtml(d.name)}"${attrs}></li>`;
      return `<li><button type="button" class="decoy" aria-label="${escapeHtml(d.name)}"${attrs}>${escapeHtml(d.name)}</button></li>`;
    })
    .join("\n");
  const composerAttrs = attributeMarkup(shape === "tree" ? { "data-qa": "texty_input" } : {});
  const sendAttrs = attributeMarkup(shape === "tree" ? { "data-qa": "texty_send_button" } : {});
  const main = conversation
    ? `<h1>#${escapeHtml(conversation.name)}</h1>
<ol id="messages" aria-label="Messages"></ol>
<div id="composer" role="textbox" contenteditable="true" aria-multiline="true" aria-label="${escapeHtml(composerLabel(conversation, shape))}"${composerAttrs}></div>
<button id="send" type="button" aria-label="${escapeHtml(sendLabel(shape))}"${sendAttrs} disabled>${escapeHtml(sendLabel(shape))}</button>`
    : `<h1>Not a conversation</h1><p>This path is not a conversation of the synthetic workspace.</p>`;
  return `<!doctype html>
<html lang="${shape === "tree" ? "ja-JP" : "en"}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: sans-serif; margin: 0; display: grid; grid-template-columns: 220px 1fr 220px; min-height: 100vh; }
nav, aside { padding: 12px; background: #f3f3f3; }
main { padding: 12px; }
ul, ol { list-style: none; padding: 0; }
li { margin: 6px 0; }
[role="treeitem"] { padding: 4px 0; }
[role="treeitem"][aria-current="true"] { background: #ddd; }
#composer { min-height: 60px; border: 1px solid #888; padding: 8px; white-space: pre-wrap; }
#messages li { padding: 4px 0; border-bottom: 1px solid #ddd; }
</style>
</head>
<body>
${sidebar}
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
  Array.prototype.forEach.call(document.querySelectorAll("[role=treeitem][data-nav]"), function (row) {
    row.addEventListener("click", function () {
      window.location.assign(row.getAttribute("data-nav"));
    });
  });
})();
</script>
</body>
</html>
`;
}
