/**
 * SlackProfile: Slack Web semantics and safety policy for the generic
 * CdpAdapter. It recognizes exactly three candidate kinds and permits
 * exactly three typed actions:
 *
 * - destination: a channel link in the Slack web client on the same origin
 *   as the page; action: click.
 * - composer: the conversation's message textbox; actions: click (focus)
 *   and insertText (the caller's exact text).
 * - send: the composer's submit button; action: click, and only when the
 *   button is enabled.
 *
 * Reactions, uploads, downloads, deletion, external links, sign-in or
 * sign-out, workspace and account settings, search, threads, and every other
 * control are never recognized, so the model is never offered them and no
 * action can reach them.
 */
import { parseUrl } from "./profile.mjs";

/** @typedef {import("./profile.mjs").Profile} Profile */
/** @typedef {import("./profile.mjs").ObservedTarget} ObservedTarget */

/** Slack web client channel path: /client/<team>/<channel>. */
export const SLACK_CLIENT_PATH = /^\/client\/(T[A-Z0-9]{2,})\/(C[A-Z0-9]{2,})\/?$/;

/** Composer textboxes are named "Message #channel", "Message Alice", ... */
export const SLACK_COMPOSER_NAME = /^message\b/i;

/** The submit control of the composer. */
export const SLACK_SEND_NAME = /^send(\s+now)?$/i;

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
 * @param {{name: string, description: string, allowedOrigin: (origin: string) => boolean}} spec
 * @returns {Profile}
 */
export function createSlackProfile({ name, description, allowedOrigin }) {
  return Object.freeze({
    name,
    description,
    trusted: true,
    checkTarget(target) {
      const parsed = parseUrl(target.url);
      if (!parsed || !allowedOrigin(parsed.origin)) {
        return { ok: false, reason: `page origin is not an allowed Slack client origin: ${target.url}` };
      }
      return { ok: true };
    },
    recognize(node, target) {
      if (node.name.length === 0) return null;
      if (node.role === "link" && node.url !== null) {
        const classified = classifySlackTarget(node.url, target.origin);
        if (!classified) return null;
        return { kind: "destination", label: `${node.name} [${classified.kindLabel}]` };
      }
      if (node.role === "textbox" && SLACK_COMPOSER_NAME.test(node.name)) {
        return { kind: "composer", label: node.name };
      }
      if (node.role === "button" && SLACK_SEND_NAME.test(node.name)) {
        return { kind: "send", label: node.name };
      }
      return null;
    },
    allowAction(candidate, action, target) {
      switch (candidate.kind) {
        case "destination":
          if (action !== "click") return { ok: false, reason: `destinations only accept click, not ${action}` };
          if (candidate.role !== "link" || candidate.url === null || !classifySlackTarget(candidate.url, target.origin)) {
            return { ok: false, reason: "destination is not a same-origin Slack client link" };
          }
          return { ok: true };
        case "composer":
          if (candidate.role !== "textbox" || !SLACK_COMPOSER_NAME.test(candidate.name)) {
            return { ok: false, reason: "composer is not a message textbox" };
          }
          if (action !== "click" && action !== "insertText") {
            return { ok: false, reason: `composers accept click and insertText, not ${action}` };
          }
          return { ok: true };
        case "send":
          if (action !== "click") return { ok: false, reason: `send controls only accept click, not ${action}` };
          if (candidate.role !== "button" || !SLACK_SEND_NAME.test(candidate.name)) {
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
