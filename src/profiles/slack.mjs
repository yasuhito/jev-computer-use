/**
 * SlackProfile: Slack Web semantics and safety policy for the generic
 * CdpAdapter. It recognizes exactly three candidate kinds and permits
 * exactly three typed actions:
 *
 * - destination: a channel in the Slack web client on the same origin as
 *   the page, either a channel link or a sidebar tree row, plus the one
 *   exactly allowlisted self-DM identity in a sidebar tree row; action: click.
 *   Channel rows carry their C id and the self-DM row its D id in
 *   `data-item-key`; the current client renders these rows without links and
 *   Chromium leaves their accessible names empty, so the names come from the
 *   rows' contents.
 * - composer: the conversation's message textbox, by its English accessible
 *   name or by Slack's locale-independent `data-qa="texty_input"` hook;
 *   actions: click (focus) and insertText (the caller's exact text).
 * - send: the composer's submit button, by its English accessible name or
 *   by `data-qa="texty_send_button"`; action: click, and only when the
 *   button is enabled.
 *
 * Slack renders a standard Unicode emoji, in the composer and in a posted
 * message, as an image whose accessibility text is empty or descriptive, so
 * the profile's inlineText proves which emoji such an image stands for from
 * its attributes (see slackEmojiText); only the closed SLACK_EMOJI set is
 * provable.
 *
 * Reactions, uploads, downloads, deletion, external links, sign-in or
 * sign-out, workspace and account settings, search, threads, every other
 * direct message, sidebar sections, and every other control are never
 * recognized, so the model is never offered them and no action can reach
 * them.
 */
import { parseUrl } from "./profile.mjs";

/** @typedef {import("./profile.mjs").Profile} Profile */
/** @typedef {import("./profile.mjs").ObservedTarget} ObservedTarget */
/** @typedef {import("./profile.mjs").ObservedNode} ObservedNode */
/** @typedef {import("./profile.mjs").Candidate} Candidate */

/** Slack web client channel path: /client/<team>/<channel>. */
export const SLACK_CLIENT_PATH = /^\/client\/(T[A-Z0-9]{2,})\/(C[A-Z0-9]{2,})\/?$/;

/** Any Slack web client conversation path; captures the team. */
const SLACK_CLIENT_TEAM_PATH = /^\/client\/(T[A-Z0-9]{2,})(?:\/|$)/;

/** A sidebar row's `data-item-key` when the row is a channel (not a DM, group, or section). */
export const SLACK_CHANNEL_ITEM_KEY = /^C[A-Z0-9]{2,}$/;

/** The sole direct-message name that the profile permits as a destination. */
export const SLACK_SELF_DM_NAME = "Yasuhito Takamiya (自分)";

/** A sidebar row's `data-item-key` when it identifies a direct message. */
export const SLACK_DM_ITEM_KEY = /^D[A-Z0-9]{2,}$/;

/** Slack web client self-DM path: /client/<team>/<D id>. */
const SLACK_SELF_DM_PATH = /^\/client\/(T[A-Z0-9]{2,})\/(D[A-Z0-9]{2,})\/?$/;

/** Composer textboxes are named "Message #channel", "Message Alice", ... */
export const SLACK_COMPOSER_NAME = /^message\b/i;

/** Slack's locale-independent test hook on the composer textbox. */
export const SLACK_COMPOSER_QA = "texty_input";

/** The submit control of the composer. */
export const SLACK_SEND_NAME = /^send(\s+now)?$/i;

/** Slack's locale-independent test hook on the composer's send button. */
export const SLACK_SEND_QA = "texty_send_button";

/**
 * The standard Slack emoji the profile can prove, by shortcode, with the
 * exact Unicode text each stands for: the line prefixes of the QA² report.
 * The set is closed; an emoji image naming anything else is unproven.
 */
export const SLACK_EMOJI = Object.freeze(
  new Map([
    ["bust_in_silhouette", "👤"],
    ["scales", "⚖️"],
    ["date", "📅"],
  ]),
);

/** An attribute value that is exactly one Slack shortcode. */
const SLACK_SHORTCODE = /^:([a-z0-9_+'-]+):$/;
const EMOJI_IDENTITY_ATTRIBUTES = ["data-id", "data-stringify-text", "data-stringify-emoji", "alt"];
/** A localized emoji name: colon-wrapped letters, digits, and shortcode punctuation. */
const LOCALIZED_EMOJI_NAME = /^:[\p{L}\p{N}_+'-]+:$/u;
const NON_ASCII = /\P{ASCII}/u;

/**
 * Whether an emoji element's `alt` is a localized name to skip rather than
 * an identity field (see slackEmojiText).
 *
 * @param {Readonly<Record<string, string>>} attributes
 */
function hasLocalizedAlt(attributes) {
  const alt = attributes.alt;
  return (
    alt !== undefined &&
    attributes["data-stringify-type"] === "emoji" &&
    SLACK_EMOJI.has(SLACK_SHORTCODE.exec(attributes["data-stringify-emoji"] ?? "")?.[1] ?? "") &&
    LOCALIZED_EMOJI_NAME.test(alt) &&
    NON_ASCII.test(alt)
  );
}

/**
 * The Unicode text a Slack emoji element stands for, proven from its
 * attributes. An element is an emoji element when it is an `<img>` or
 * carries `data-stringify-type="emoji"` or `data-stringify-emoji`; every
 * other element is left to the adapter (undefined). Its nonempty `data-id`,
 * `data-stringify-text`, `data-stringify-emoji`, and `alt` identity fields
 * must be exact, agreeing shortcodes in SLACK_EMOJI; at least one is required.
 * An unknown, custom, combined, or disagreeing shortcode is unproven (null).
 * The one exception is a localized `alt`: a non-English client (observed on
 * ja-JP) names a posted emoji image in its own language (`:天秤:`) beside
 * the stable `data-stringify-emoji` shortcode. Such an `alt` is not an
 * identity field, so it is skipped, only when the element also carries
 * `data-stringify-type="emoji"` and a `data-stringify-emoji` shortcode in
 * SLACK_EMOJI (which the other fields must still agree with), and the `alt`
 * is one colon-wrapped name of letters, digits, and shortcode punctuation
 * with at least one non-ASCII character, so it can never be a competing
 * Slack shortcode. An ASCII `alt` stays an identity field.
 * The result is the SLACK_EMOJI spelling, so a caller text with a different
 * spelling (for example `⚖` without U+FE0F) does not match.
 *
 * @param {import("./profile.mjs").DomElementFacts} element
 * @returns {string|null|undefined}
 */
export function slackEmojiText({ nodeName, attributes }) {
  const isEmojiElement =
    nodeName === "IMG" || attributes["data-stringify-type"] === "emoji" || attributes["data-stringify-emoji"] !== undefined;
  if (!isEmojiElement) return undefined;
  /** @type {string[]} */
  const proofs = [];
  const skipAlt = hasLocalizedAlt(attributes);
  for (const name of EMOJI_IDENTITY_ATTRIBUTES) {
    const value = attributes[name];
    if (value === undefined || value === "" || (name === "alt" && skipAlt)) continue;
    const shortcode = SLACK_SHORTCODE.exec(value)?.[1];
    const unicode = shortcode === undefined ? undefined : SLACK_EMOJI.get(shortcode);
    if (unicode === undefined) return null;
    proofs.push(unicode);
  }
  const first = proofs[0];
  if (first === undefined || proofs.some((unicode) => unicode !== first)) return null;
  return first;
}

/** Roles whose element attributes the profile needs before it can recognize a node. */
const ATTRIBUTE_ROLES = Object.freeze(new Set(["treeitem", "textbox", "button"]));
const TEXT_SEQUENCE_CONTAINER_ROLES = Object.freeze(new Set(["listitem"]));

/**
 * Classify a Slack client URL relative to the page origin.
 *
 * @param {string} url
 * @param {string} origin
 * @returns {{team: string, conversation: string, kindLabel: "channel"}|null}
 */
export function classifySlackTarget(url, origin) {
  const parsed = parseUrl(url);
  if (!parsed || parsed.origin !== origin || parsed.search !== "" || parsed.hash !== "") return null;
  const match = SLACK_CLIENT_PATH.exec(parsed.pathname);
  if (!match || match[1] === undefined) return null;
  if (match[2] === undefined) return null;
  return { team: match[1], conversation: match[2], kindLabel: "channel" };
}

/**
 * Classify the one allowlisted self-DM URL relative to the page origin.
 *
 * @param {string} url
 * @param {string} origin
 * @returns {{team: string, conversation: string, kindLabel: "self direct message"}|null}
 */
export function classifySlackSelfDmTarget(url, origin) {
  const parsed = parseUrl(url);
  if (!parsed || parsed.origin !== origin || parsed.search !== "" || parsed.hash !== "") return null;
  const match = SLACK_SELF_DM_PATH.exec(parsed.pathname);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { team: match[1], conversation: match[2], kindLabel: "self direct message" };
}

/**
 * The client URL a sidebar tree row opens: the page's team plus the row's
 * channel id. Null unless the page is a Slack client page and the row is a
 * channel row.
 *
 * @param {ObservedNode|Candidate} row
 * @param {ObservedTarget} target
 * @returns {string|null}
 */
export function sidebarChannelUrl(row, target) {
  if (row.role !== "treeitem") return null;
  const key = row.attributes["data-item-key"];
  if (key === undefined || !SLACK_CHANNEL_ITEM_KEY.test(key)) return null;
  const page = parseUrl(target.url);
  const team = page ? SLACK_CLIENT_TEAM_PATH.exec(page.pathname)?.[1] : undefined;
  if (!page || team === undefined) return null;
  const url = `${page.origin}/client/${team}/${key}`;
  return classifySlackTarget(url, target.origin) ? url : null;
}

/**
 * The URL for the exact self-DM row, derived from its observed D id.
 * Nothing else with a D id is eligible: both the row name and identity key
 * must match the allowlist before the URL can be constructed.
 *
 * @param {ObservedNode|Candidate} row
 * @param {ObservedTarget} target
 * @returns {string|null}
 */
function sidebarSelfDmUrl(row, target) {
  if (row.role !== "treeitem") return null;
  const key = row.attributes["data-item-key"];
  if (key === undefined || !SLACK_DM_ITEM_KEY.test(key)) return null;
  const rowName = row.name.length > 0 ? row.name : ("contentText" in row ? row.contentText : "");
  if (rowName !== SLACK_SELF_DM_NAME) return null;
  const page = parseUrl(target.url);
  const team = page && page.origin === target.origin ? SLACK_CLIENT_TEAM_PATH.exec(page.pathname)?.[1] : undefined;
  if (!page || team === undefined) return null;
  const url = `${page.origin}/client/${team}/${key}`;
  return classifySlackSelfDmTarget(url, target.origin) ? url : null;
}

/**
 * Names that the workflow's exact-destination guard could otherwise treat as
 * decoration on the allowlisted self-DM name must never be a channel target.
 * @param {string} name
 */
function namesSelfDm(name) {
  if (name === SLACK_SELF_DM_NAME) return true;
  return name.startsWith(SLACK_SELF_DM_NAME) && /^[\s,([{（［｛]/.test(name.slice(SLACK_SELF_DM_NAME.length));
}

/** @param {ObservedNode|Candidate} node */
function isComposer(node) {
  return node.role === "textbox" && (SLACK_COMPOSER_NAME.test(node.name) || node.attributes["data-qa"] === SLACK_COMPOSER_QA);
}

/** @param {ObservedNode|Candidate} node */
function isSendButton(node) {
  return node.role === "button" && (SLACK_SEND_NAME.test(node.name) || node.attributes["data-qa"] === SLACK_SEND_QA);
}

/**
 * @param {{name: string, description: string, allowedOrigin: (origin: string) => boolean}} spec
 * @returns {Profile}
 */
export function createSlackProfile({ name, description, allowedOrigin }) {
  return Object.freeze({
    name,
    description,
    trusted: true,
    attributeRoles: ATTRIBUTE_ROLES,
    textSequenceContainerRoles: TEXT_SEQUENCE_CONTAINER_ROLES,
    inlineText: slackEmojiText,
    checkTarget(target) {
      const parsed = parseUrl(target.url);
      if (!parsed || !allowedOrigin(parsed.origin)) {
        return { ok: false, reason: `page origin is not an allowed Slack client origin: ${target.url}` };
      }
      return { ok: true };
    },
    recognize(node, target) {
      if (node.role === "link" && node.url !== null) {
        if (node.name.length === 0 || namesSelfDm(node.name)) return null;
        const classified = classifySlackTarget(node.url, target.origin);
        if (!classified) return null;
        return { kind: "destination", label: `${node.name} [${classified.kindLabel}]` };
      }
      if (node.role === "treeitem") {
        const rowName = node.name.length > 0 ? node.name : node.contentText;
        const channelUrl = sidebarChannelUrl(node, target);
        if (channelUrl !== null && rowName.length > 0 && !namesSelfDm(rowName)) {
          return { kind: "destination", label: `${rowName} [channel]`, name: rowName, url: channelUrl };
        }
        const selfDmUrl = sidebarSelfDmUrl(node, target);
        if (selfDmUrl !== null) {
          return { kind: "destination", label: `${rowName} [self direct message]`, name: rowName, url: selfDmUrl };
        }
      }
      if (node.name.length === 0) return null;
      if (isComposer(node)) return { kind: "composer", label: node.name };
      if (isSendButton(node)) return { kind: "send", label: node.name };
      return null;
    },
    allowAction(candidate, action, target) {
      switch (candidate.kind) {
        case "destination": {
          if (action !== "click") return { ok: false, reason: `destinations only accept click, not ${action}` };
          const url = candidate.role === "treeitem" ? sidebarChannelUrl(candidate, target) : candidate.url;
          const isChannel =
            (candidate.role === "link" || candidate.role === "treeitem") &&
            !namesSelfDm(candidate.name) &&
            url !== null &&
            url === candidate.url &&
            classifySlackTarget(url, target.origin) !== null;
          const isSelfDm =
            candidate.role === "treeitem" &&
            candidate.name === SLACK_SELF_DM_NAME &&
            sidebarSelfDmUrl(candidate, target) === candidate.url;
          if (!isChannel && !isSelfDm) {
            return { ok: false, reason: "destination is not an allowed same-origin channel or the exact self-DM row" };
          }
          return { ok: true };
        }
        case "composer":
          if (!isComposer(candidate)) {
            return { ok: false, reason: "composer is not a message textbox" };
          }
          if (action !== "click" && action !== "insertText") {
            return { ok: false, reason: `composers accept click and insertText, not ${action}` };
          }
          return { ok: true };
        case "send":
          if (action !== "click") return { ok: false, reason: `send controls only accept click, not ${action}` };
          if (!isSendButton(candidate)) {
            return { ok: false, reason: "send control is not the composer's send button" };
          }
          if (candidate.disabled) return { ok: false, reason: "send button is disabled" };
          return { ok: true };
        default:
          return { ok: false, reason: `kind ${candidate.kind} is never actionable under ${name}` };
      }
    },
  });
}

/** Real Slack web client. */
export const SLACK_PROFILE = createSlackProfile({
  name: "slack",
  description: "Slack web client at https://app.slack.com",
  allowedOrigin: (origin) => origin === "https://app.slack.com",
});

/**
 * The same rules against a local synthetic page (scripts/serve-synthetic-slack.mjs)
 * so the live CDP transport can be exercised with no Slack credential.
 */
export const SLACK_LOCAL_SYNTHETIC_PROFILE = createSlackProfile({
  name: "slack-local-synthetic",
  description: "Slack rules against a local synthetic page on 127.0.0.1 or localhost",
  allowedOrigin: (origin) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin),
});
