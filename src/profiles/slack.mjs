/**
 * SlackProfile: Slack Web semantics and safety policy for the generic
 * CdpAdapter. It recognizes exactly three candidate kinds and permits
 * exactly three typed actions:
 *
 * - destination: a channel in the Slack web client on the same origin as
 *   the page, either a channel link or a sidebar tree row (the current
 *   client renders the sidebar as `treeitem` rows that carry the channel id
 *   in `data-item-key`, have no link, and whose accessible name the browser
 *   leaves empty, so the name comes from the row's contents); action: click.
 * - composer: the conversation's message textbox, by its English accessible
 *   name or by Slack's locale-independent `data-qa="texty_input"` hook;
 *   actions: click (focus) and insertText (the caller's exact text).
 * - send: the composer's submit button, by its English accessible name or
 *   by `data-qa="texty_send_button"`; action: click, and only when the
 *   button is enabled.
 *
 * Reactions, uploads, downloads, deletion, external links, sign-in or
 * sign-out, workspace and account settings, search, threads, direct
 * messages, sidebar sections, and every other control are never recognized,
 * so the model is never offered them and no action can reach them.
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

/** Composer textboxes are named "Message #channel", "Message Alice", ... */
export const SLACK_COMPOSER_NAME = /^message\b/i;

/** Slack's locale-independent test hook on the composer textbox. */
export const SLACK_COMPOSER_QA = "texty_input";

/** The submit control of the composer. */
export const SLACK_SEND_NAME = /^send(\s+now)?$/i;

/** Slack's locale-independent test hook on the composer's send button. */
export const SLACK_SEND_QA = "texty_send_button";

/** Roles whose element attributes the profile needs before it can recognize a node. */
const ATTRIBUTE_ROLES = Object.freeze(new Set(["treeitem", "textbox", "button"]));

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
    checkTarget(target) {
      const parsed = parseUrl(target.url);
      if (!parsed || !allowedOrigin(parsed.origin)) {
        return { ok: false, reason: `page origin is not an allowed Slack client origin: ${target.url}` };
      }
      return { ok: true };
    },
    recognize(node, target) {
      if (node.role === "link" && node.url !== null) {
        if (node.name.length === 0) return null;
        const classified = classifySlackTarget(node.url, target.origin);
        if (!classified) return null;
        return { kind: "destination", label: `${node.name} [${classified.kindLabel}]` };
      }
      if (node.role === "treeitem") {
        const url = sidebarChannelUrl(node, target);
        const rowName = node.name.length > 0 ? node.name : node.contentText;
        if (url === null || rowName.length === 0) return null;
        return { kind: "destination", label: `${rowName} [channel]`, name: rowName, url };
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
            url !== null &&
            url === candidate.url &&
            classifySlackTarget(url, target.origin) !== null;
          if (!isChannel) {
            return { ok: false, reason: "destination is not a same-origin Slack client channel link or sidebar channel row" };
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
