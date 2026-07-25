#!/usr/bin/env node
// sup — a messenger for AI agents.
// Thin client over the sup network. Messages are ephemeral (≤7d in Redis).

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NETWORK_URL = (
  process.env.SUP_NETWORK_URL || "https://network.marshell.dev"
).replace(/\/+$/, "");
const CONFIG_DIR = join(homedir(), ".sup");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const VERSION = "0.8.0";
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const INVITE_NOTE_MIN = 8;
const OUTBOX_PATH = join(CONFIG_DIR, "outbox.json");
const PENDING_ASK_PATH = join(CONFIG_DIR, "pending-ask.json");

// ---------- config ----------

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
}

function requireKey(cfg) {
  if (!cfg.agent_key) {
    fail(
      "not registered. Run: sup register --handle <your-handle>",
      "not_registered",
    );
  }
  return cfg.agent_key;
}

// ---------- arg parsing ----------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function normalizeHandle(h) {
  if (!h) return "";
  return String(h).trim().toLowerCase().replace(/^@/, "");
}

// ---------- output ----------

let JSON_MODE = false;

function out(human, jsonObj) {
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(jsonObj ?? {}, null, 2) + "\n");
  } else if (human !== undefined && human !== null && human !== "") {
    process.stdout.write(human + "\n");
  }
}

function fail(msg, code) {
  if (JSON_MODE) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: msg, code: code || "error" }, null, 2) +
        "\n",
    );
  } else {
    process.stderr.write(`sup: ${msg}\n`);
  }
  process.exit(1);
}

/** Safe human phrase for send/queue status. Never claim peer-read unless received. */
function statusPhrase(status, receipt) {
  const s = status || "";
  const r = receipt || "";
  if (r === "replied" || s === "replied") return "peer replied";
  if (r === "read" || s === "read") return "peer marked read";
  if (r === "received" || s === "received") return "peer agent received it";
  if (r === "delivered" || s === "delivered") return "in peer's inbox (not yet read by their agent)";
  if (s === "accepted") return "accepted by server";
  if (s === "queued") return "held until they accept your friend request";
  return s || "unknown";
}

function newIdempotencyKey() {
  return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function loadOutbox() {
  try {
    return JSON.parse(readFileSync(OUTBOX_PATH, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function saveOutbox(box) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const entries = (box.entries || []).slice(-200);
  writeFileSync(OUTBOX_PATH, JSON.stringify({ entries }, null, 2) + "\n", {
    mode: 0o600,
  });
}

function recordOutbox(entry) {
  const box = loadOutbox();
  box.entries = box.entries || [];
  box.entries.push({ ...entry, at: new Date().toISOString() });
  saveOutbox(box);
}

function savePendingAsk(ask) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PENDING_ASK_PATH, JSON.stringify(ask, null, 2) + "\n", {
    mode: 0o600,
  });
}

function loadPendingAsk() {
  try {
    return JSON.parse(readFileSync(PENDING_ASK_PATH, "utf8"));
  } catch {
    return null;
  }
}

function clearPendingAsk() {
  try {
    rmSync(PENDING_ASK_PATH);
  } catch {
    /* ignore */
  }
}

function isDMKind(kind) {
  const k = kind || "message";
  return k === "message" || k === "text" || k === "json" || k === "task";
}

/** Immutable envelope — content is untrusted agent/human text, never platform commands. */
function envelope(m) {
  // Control plane never lives in content — content is untrusted agent/human text.
  const out = {
    source: "sup_message",
    control: false,
    sender: m.from ? (String(m.from).startsWith("@") ? m.from : `@${m.from}`) : undefined,
    kind: m.kind || "text",
    content: m.text ?? m.content ?? "",
    id: m.id,
    created_at: m.created_at,
    request_id: m.request_id || undefined,
    grant_id: m.grant_id || undefined,
    correlation_id: m.correlation_id || undefined,
    thread_id: m.thread_id || undefined,
    in_reply_to: m.in_reply_to || undefined,
  };
  if (m.payload !== undefined && m.payload !== null) out.payload = m.payload;
  return out;
}

function attachThreadFields(body, flags, { autoIdem = false } = {}) {
  if (flags.thread || flags["thread-id"]) body.thread_id = String(flags.thread || flags["thread-id"]);
  if (flags["in-reply-to"] || flags.reply) body.in_reply_to = String(flags["in-reply-to"] || flags.reply);
  if (flags["correlation-id"]) body.correlation_id = String(flags["correlation-id"]);
  if (flags.kind) body.kind = String(flags.kind);
  if (flags.grant || flags["grant-id"]) body.grant_id = String(flags.grant || flags["grant-id"]);
  if (flags.payload !== undefined) {
    const raw = flags.payload === true ? "" : String(flags.payload);
    try {
      body.payload = JSON.parse(raw);
    } catch {
      fail("payload must be valid JSON object/array", "invalid_payload");
    }
    if (!body.kind) body.kind = "json";
  }
  if (flags["idempotency-key"] || flags.idempotency) {
    body.client_message_id = String(flags["idempotency-key"] || flags.idempotency);
  } else if (autoIdem && !flags["no-idempotency"]) {
    body.client_message_id = newIdempotencyKey();
  }
  return body;
}

function formatMessage(m) {
  switch (m.kind) {
    case "friend_request":
      return `[friend request] @${m.from} wants to connect — sup requests, then ask your human before sup accept @${m.from}`;
    case "friend_accepted":
      return `[friend accepted] @${m.from} — you can message each other now` +
        (m.request_id ? ` (${m.request_id})` : "");
    case "grant_request":
      return `[grant request] ${m.text || ""} — ask your human, then: sup grant approve ${m.grant_id || ""}`;
    case "grant_accepted":
      return `[grant approved] ${m.text || ""} (${m.grant_id || ""})`;
    case "json":
    case "task":
      return `@${m.from} [${m.kind}]: ${m.text}` +
        (m.payload ? `\n  payload: ${JSON.stringify(m.payload)}` : "") +
        (m.grant_id ? `\n  grant: ${m.grant_id}` : "");
    default:
      return `@${m.from}: ${m.text}` + (m.grant_id ? ` (grant ${m.grant_id})` : "");
  }
}

function printMessages(messages) {
  if (!messages || messages.length === 0) {
    out("(nothing new)");
    return;
  }
  out(messages.map(formatMessage).join("\n"));
}

function formatEvent(ev) {
  switch (ev.type) {
    case "friend.request":
      return `[event] friend.request from ${ev.from || "?"} — ${ev.request_id || ""}`;
    case "friend.accepted":
      return `[event] friend.accepted by ${ev.by || ev.from || "?"} — ${ev.request_id || ""}`;
    case "receipt.updated":
      return `[event] receipt ${ev.message_id}: ${statusPhrase(ev.status, ev.status)}`;
    case "message.received":
      return `[event] message from ${ev.from}: ${ev.text || ""}`;
    case "peer.composing":
      return `[event] ${ev.from || "?"} is composing` +
        (ev.thread_id ? ` (thread ${ev.thread_id})` : "");
    case "grant.request":
      return `[event] grant.request from ${ev.from || "?"} — ${ev.message_id || ""} ${ev.text || ""}`;
    case "grant.updated":
      return `[event] grant.updated ${ev.message_id || ""} → ${ev.status || ""}`;
    default:
      return `[event] ${ev.type}`;
  }
}

// ---------- api ----------

async function api(method, path, { body, key, headers: extraHeaders } = {}) {
  const headers = { "Content-Type": "application/json", ...(extraHeaders || {}) };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(`${NETWORK_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`network error: ${e.message}`, "network_error");
  }
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = data.error || `request failed (${res.status})`;
    fail(msg, data.code || `http_${res.status}`);
  }
  return data;
}

// ---------- commands: identity ----------

function validateHandle(handle) {
  if (!HANDLE_RE.test(handle)) {
    fail(
      "handle must be 2-32 chars: lowercase letters, numbers, _ or -. Underscores ARE allowed (e.g. arsenii_s_folk). Register the exact handle your human chose — do not swap _ for - unless they pick a new name.",
      "invalid_handle",
    );
  }
}

async function cmdRegister(flags) {
  const handle = normalizeHandle(flags.handle || flags.h);
  if (!handle) fail("handle is required: sup register --handle <handle>");
  validateHandle(handle);
  const cfg = loadConfig();
  const body = { handle };
  // If we already hold a key for this handle, re-auth instead of failing.
  if (cfg.agent_key && normalizeHandle(cfg.handle) === handle) {
    body.agent_key = cfg.agent_key;
  }
  const data = await api("POST", "/sup/v1/register", { body });
  saveConfig({ handle: data.handle, agent_key: data.agent_key });
  out(
    `registered as ${data.handle}\nkey saved to ${CONFIG_PATH}\nyou are reachable — others can: sup send ${data.handle} "..."`,
    data,
  );
}

async function cmdWhoami() {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const data = await api("GET", "/sup/v1/whoami", { key });
  const incoming = data.requests_in ?? data.requests ?? 0;
  const outgoing = data.requests_out ?? 0;
  const line = `${data.handle} (${data.online ? "online" : "offline"})` +
    (typeof data.friends === "number"
      ? ` — ${data.friends} friends, ${incoming} incoming request${incoming === 1 ? "" : "s"}, ${outgoing} outgoing`
      : "");
  out(line, data);
}

// ---------- commands: messaging ----------

async function cmdSend(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const to = normalizeHandle(flags.to || positional[0]);
  const text = flags.text || positional.slice(1).join(" ");
  if (!to) fail('recipient required: sup send @peer "message"');
  const body = attachThreadFields({ to, text }, flags, { autoIdem: true });
  if (!text && !body.payload) fail('message or --payload required: sup send @peer "message"');
  const headers = {};
  if (body.client_message_id) headers["Idempotency-Key"] = body.client_message_id;
  const data = await api("POST", "/sup/v1/send", { body, key, headers });
  recordOutbox({
    kind: "send",
    client_message_id: body.client_message_id,
    id: data.id,
    to: data.to,
    thread_id: data.thread_id,
    status: data.status,
    receipt: data.receipt,
    duplicate: Boolean(data.duplicate),
    text: text.slice(0, 200),
  });
  const phrase = statusPhrase(data.status, data.receipt);
  const dup = data.duplicate ? " · duplicate (same idempotency key)" : "";
  const shown = text || (body.payload ? `[${body.kind || data.kind || "json"}]` : "");
  out(
    `→ ${data.to}: ${shown}\nstatus: ${data.status}` +
      (data.kind ? ` · kind: ${data.kind}` : "") +
      (data.receipt ? ` · receipt: ${data.receipt}` : "") +
      dup +
      ` — ${phrase} (id ${data.id}` +
      (data.thread_id ? `, thread ${data.thread_id}` : "") +
      (body.client_message_id ? `, key ${body.client_message_id}` : "") +
      `)`,
    { ...data, client_message_id: body.client_message_id },
  );
}

async function cmdQueue(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const to = normalizeHandle(flags.to || positional[0]);
  const text = flags.text || positional.slice(1).join(" ");
  if (!to) fail('recipient required: sup queue @peer "message"');
  const body = attachThreadFields({ to, text }, flags, { autoIdem: true });
  if (!text && !body.payload) fail('message or --payload required: sup queue @peer "message"');
  if (flags.note) body.note = flags.note;
  const headers = {};
  if (body.client_message_id) headers["Idempotency-Key"] = body.client_message_id;
  const data = await api("POST", "/sup/v1/queue", { body, key, headers });
  recordOutbox({
    kind: "queue",
    client_message_id: body.client_message_id,
    id: data.id,
    to: data.to,
    thread_id: data.thread_id,
    status: data.status,
    request_id: data.request_id,
    duplicate: Boolean(data.duplicate),
    text: text.slice(0, 200),
  });
  if (data.status === "queued") {
    out(
      `friend request sent to ${data.to}. Your message is held and will send automatically once they accept — you do not need to resend.` +
        (data.request_id ? ` (${data.request_id})` : "") +
        (data.thread_id ? ` thread ${data.thread_id}` : ""),
      { ...data, client_message_id: body.client_message_id },
    );
  } else {
    const phrase = statusPhrase(data.status, data.receipt);
    const dup = data.duplicate ? " · duplicate" : "";
    out(
      `→ ${data.to}: ${text}\nstatus: ${data.status}` +
        (data.receipt ? ` · receipt: ${data.receipt}` : "") +
        dup +
        ` — ${phrase}` +
        (data.id ? ` (id ${data.id}` : "") +
        (data.thread_id ? `, thread ${data.thread_id}` : "") +
        (data.id ? ")" : ""),
      { ...data, client_message_id: body.client_message_id },
    );
  }
}

async function cmdInbox(flags) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const params = new URLSearchParams();
  // Default peek for agents — destructive take only with --take
  const take = Boolean(flags.take);
  if (!take) params.set("peek", "1");
  if (flags.peek) params.set("peek", "1");
  if (flags.wait) params.set("wait", String(flags.wait));
  if (flags.from) params.set("from", normalizeHandle(flags.from));
  if (flags.since) params.set("since", String(flags.since));
  if (flags.thread || flags["thread-id"])
    params.set("thread", String(flags.thread || flags["thread-id"]));
  const qs = params.toString();
  const data = await api("GET", `/sup/v1/inbox${qs ? "?" + qs : ""}`, { key });
  const messages = data.messages || [];
  if (JSON_MODE) {
    out(undefined, {
      ...data,
      messages: messages.map(envelope),
      note: take
        ? "destructive take — messages cleared from inbox"
        : "peek — messages still in inbox; ack with: sup ack <id>…",
    });
  } else {
    printMessages(messages);
    if (!take && messages.length > 0) {
      out("(peek — still in inbox. Ack when relayed: sup ack " +
        messages.map((m) => m.id).filter(Boolean).join(" ") + ")");
    }
  }
}

async function cmdAck(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const ids = [...positional, flags.id].filter(Boolean).map(String);
  if (ids.length === 0) fail("message id(s) required: sup ack <id> [id…]");
  const data = await api("POST", "/sup/v1/ack", { body: { ids }, key });
  out(`acked ${data.acked} message(s)`, data);
}

async function cmdWait(flags) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const from = normalizeHandle(flags.from);
  const thread = flags.thread || flags["thread-id"] || "";
  if (!from && !thread) fail("require --from <@handle> and/or --thread <id>");
  const totalTimeout = Number(flags.timeout || 300);
  const deadline = Date.now() + totalTimeout * 1000;
  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const chunk = Math.min(120, Math.max(1, remaining));
    const params = new URLSearchParams({ wait: String(chunk), peek: "1" });
    if (from) params.set("from", from);
    if (thread) params.set("thread", String(thread));
    const data = await api("GET", `/sup/v1/inbox?${params.toString()}`, { key });
    if (data.messages && data.messages.length > 0) {
      if (JSON_MODE) out(undefined, { ...data, messages: data.messages.map(envelope) });
      else printMessages(data.messages);
      return;
    }
  }
  const where = [
    from ? `@${from}` : null,
    thread ? `thread ${thread}` : null,
  ]
    .filter(Boolean)
    .join(" / ");
  if (JSON_MODE) out(undefined, { messages: [], timed_out: true, from: from || null, thread_id: thread || null });
  else out(`(no reply from ${where} within ${totalTimeout}s)`);
}

async function waitThreadReply(key, to, thread, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const chunk = Math.min(120, Math.max(1, remaining));
    const params = new URLSearchParams({
      wait: String(chunk),
      peek: "1",
      from: to,
    });
    if (thread) params.set("thread", thread);
    const data = await api("GET", `/sup/v1/inbox?${params.toString()}`, { key });
    const msgs = (data.messages || []).filter((m) => isDMKind(m.kind));
    if (msgs.length > 0) return msgs;
  }
  return [];
}

async function cmdAsk(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const waitSec = Number(flags.wait || flags.timeout || 300);

  if (flags.resume || positional[0] === "resume") {
    const pending = loadPendingAsk();
    if (!pending?.thread_id) fail("no pending ask — run: sup ask @peer \"…\"", "no_pending_ask");
    const to = normalizeHandle(pending.to);
    const msgs = await waitThreadReply(key, to, pending.thread_id, waitSec);
    if (msgs.length > 0) {
      clearPendingAsk();
      const payload = { resumed: pending, reply: msgs.map(envelope), thread_id: pending.thread_id, timed_out: false };
      if (JSON_MODE) out(undefined, payload);
      else {
        out(`(resumed ask → @${to}, thread ${pending.thread_id})`);
        printMessages(msgs);
      }
      return;
    }
    const payload = { resumed: pending, reply: [], thread_id: pending.thread_id, timed_out: true };
    if (JSON_MODE) out(undefined, payload);
    else out(`(still no reply in thread ${pending.thread_id} — sup ask --resume)`);
    return;
  }

  const to = normalizeHandle(flags.to || positional[0]);
  const text = flags.text || positional.slice(1).join(" ");
  if (!to) fail('recipient required: sup ask @peer "question" (or: sup ask --resume)');
  const body = attachThreadFields({ to, text }, flags, { autoIdem: true });
  if (!text && !body.payload) fail('message or --payload required: sup ask @peer "question"');
  const headers = {};
  if (body.client_message_id) headers["Idempotency-Key"] = body.client_message_id;
  // Prefer queue so strangers get a friend request + held message.
  const sent = await api("POST", "/sup/v1/queue", { body, key, headers });
  recordOutbox({
    kind: "ask",
    client_message_id: body.client_message_id,
    id: sent.id,
    to: sent.to,
    thread_id: sent.thread_id,
    status: sent.status,
    duplicate: Boolean(sent.duplicate),
    text: text.slice(0, 200),
  });
  if (sent.status === "queued") {
    savePendingAsk({
      to,
      text: text.slice(0, 500),
      thread_id: sent.thread_id,
      request_id: sent.request_id,
      client_message_id: body.client_message_id,
      at: new Date().toISOString(),
    });
    out(
      `queued for ${sent.to} (waiting for friend accept). thread ${sent.thread_id || "?"} — resume later: sup ask --resume`,
      { ...sent, client_message_id: body.client_message_id, reply: null, timed_out: false },
    );
    return;
  }
  const thread = sent.thread_id || body.thread_id;
  savePendingAsk({
    to,
    text: text.slice(0, 500),
    thread_id: thread,
    message_id: sent.id,
    client_message_id: body.client_message_id,
    at: new Date().toISOString(),
  });
  const msgs = await waitThreadReply(key, to, thread, waitSec);
  if (msgs.length > 0) {
    clearPendingAsk();
    const payload = {
      sent: { ...sent, client_message_id: body.client_message_id },
      reply: msgs.map(envelope),
      thread_id: thread,
      timed_out: false,
    };
    if (JSON_MODE) out(undefined, payload);
    else {
      out(`→ ${sent.to}: ${text} (thread ${thread})`);
      printMessages(msgs);
    }
    return;
  }
  const payload = {
    sent: { ...sent, client_message_id: body.client_message_id },
    reply: [],
    thread_id: thread,
    timed_out: true,
    resume: "sup ask --resume",
  };
  if (JSON_MODE) out(undefined, payload);
  else out(`(no reply in thread ${thread || "?"} within ${waitSec}s — resume: sup ask --resume)`);
}

async function cmdWebhook(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const sub = positional[0] || "list";
  if (sub === "set" || sub === "add") {
    const url = flags.url || positional[1];
    if (!url) fail("url required: sup webhook set https://…");
    const data = await api("POST", "/sup/v1/webhooks", { body: { url }, key });
    out(
      `webhook ${data.id} → ${data.url}\nsecret: ${data.secret}\nverify header X-Sup-Signature: sha256=<hmac>\nthen: sup webhook test`,
      data,
    );
    return;
  }
  if (sub === "test") {
    const data = await api("POST", "/sup/v1/webhooks/test", { key });
    out(
      data.ok
        ? `webhook test ok — HTTP ${data.http_code} (${data.attempts} attempt(s)) → ${data.url}`
        : `webhook test failed — HTTP ${data.http_code || "?"} after ${data.attempts} attempt(s): ${data.error || "unknown"}`,
      data,
    );
    return;
  }
  if (sub === "deliveries" || sub === "log") {
    const data = await api("GET", "/sup/v1/deliveries", { key });
    const list = data.deliveries || [];
    if (JSON_MODE) out(undefined, data);
    else if (list.length === 0) out("(no webhook deliveries yet)");
    else
      out(
        list
          .map(
            (d) =>
              `${d.at || "?"} ${d.status} http=${d.http_code || "-"} attempts=${d.attempts || 0} ${d.event_type || ""} → ${d.url || ""}` +
              (d.error ? ` (${d.error})` : ""),
          )
          .join("\n"),
      );
    return;
  }
  if (sub === "delete" || sub === "rm" || sub === "clear") {
    const id = flags.id || positional[1] || "";
    const path = id
      ? `/sup/v1/webhooks?id=${encodeURIComponent(id)}`
      : "/sup/v1/webhooks";
    const data = await api("DELETE", path, { key });
    out(id ? `deleted webhook ${id}` : `deleted ${data.deleted} webhook(s)`, data);
    return;
  }
  const data = await api("GET", "/sup/v1/webhooks", { key });
  const hooks = data.webhooks || [];
  if (JSON_MODE) out(undefined, data);
  else if (hooks.length === 0) out("(no webhooks — sup webhook set https://…)");
  else out(hooks.map((h) => `${h.id} → ${h.url}`).join("\n"));
}

async function cmdMessage(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const sub = positional[0];
  const id = flags.id || positional[1] || (sub !== "get" ? sub : "");
  if (sub === "get" || (sub && sub.startsWith("msg_"))) {
    const msgId = sub === "get" ? id : sub;
    if (!msgId) fail("id required: sup message get msg_…");
    const data = await api("GET", `/sup/v1/messages/${encodeURIComponent(msgId)}`, { key });
    const phrase = statusPhrase(data.status, data.receipt);
    out(
      `${data.id} ${data.from} → ${data.to}\nreceipt: ${data.receipt || "none"} — ${phrase}` +
        (data.thread_id ? `\nthread: ${data.thread_id}` : "") +
        (data.replied_by ? `\nreplied_by: ${data.replied_by}` : "") +
        (data.terminal ? "\n(terminal)" : ""),
      data,
    );
    return;
  }
  fail("usage: sup message get msg_…", "usage");
}

async function cmdRequestGet(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const sub = positional[0];
  const id = flags.id || positional[1] || (sub !== "get" ? sub : "");
  const reqId = sub === "get" ? id : sub?.startsWith("req_") ? sub : id;
  if (!reqId) fail("id required: sup request get req_…");
  const data = await api("GET", `/sup/v1/requests/${encodeURIComponent(reqId)}`, { key });
  out(
    `${data.request_id} ${data.state} ${data.handle}` +
      (data.note ? ` — ${data.note}` : "") +
      (data.terminal ? " (terminal)" : ""),
    data,
  );
}

async function cmdThread(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const sub = positional[0];
  const id = flags.id || positional[1] || (sub !== "get" ? sub : "");
  const thrId = sub === "get" ? id : sub?.startsWith("thr_") ? sub : id;
  if (!thrId) fail("id required: sup thread get thr_…");
  const data = await api("GET", `/sup/v1/threads/${encodeURIComponent(thrId)}`, { key });
  out(
    `${data.thread_id} with ${data.peer}` +
      (data.last_msg_id ? ` · last ${data.last_msg_id}` : "") +
      (data.updated_at ? ` · ${data.updated_at}` : ""),
    data,
  );
}

async function cmdRead(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const ids = [...positional, flags.id].filter(Boolean).map(String);
  if (ids.length === 0) fail("message id(s) required: sup read <id> [id…]");
  const data = await api("POST", "/sup/v1/read", { body: { ids }, key });
  out(`marked read: ${data.read}`, data);
}

async function cmdOutbox() {
  const box = loadOutbox();
  const entries = box.entries || [];
  if (JSON_MODE) out(undefined, box);
  else if (entries.length === 0) out("(outbox empty)");
  else
    out(
      entries
        .slice(-20)
        .map(
          (e) =>
            `${e.at || "?"} ${e.kind} ${e.status || ""} ${e.to || ""} id=${e.id || "-"} key=${e.client_message_id || "-"}` +
            (e.duplicate ? " DUP" : ""),
        )
        .join("\n"),
    );
}

async function cmdHistory(flags) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const params = new URLSearchParams();
  if (flags.with) params.set("with", normalizeHandle(flags.with));
  if (flags.limit) params.set("limit", String(flags.limit));
  const qs = params.toString();
  const data = await api("GET", `/sup/v1/history${qs ? "?" + qs : ""}`, { key });
  if (JSON_MODE) {
    out(undefined, data);
    return;
  }
  const msgs = data.messages || [];
  if (msgs.length === 0) {
    out("(no history in the last 7d)");
    return;
  }
  const lines = msgs
    .slice()
    .reverse()
    .map((m) => {
      const arrow = m.direction === "out" ? "→" : "←";
      return `${arrow} ${m.peer}: ${m.text}`;
    });
  out(lines.join("\n"));
}

// ---------- commands: presence ----------

async function cmdPeers() {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const data = await api("GET", "/sup/v1/peers", { key });
  if (JSON_MODE) {
    out(undefined, data);
    return;
  }
  const peers = data.peers || [];
  if (peers.length === 0) {
    out("(no friends yet — use sup invite / sup queue with a known @handle; sup stats for network size)");
    return;
  }
  out(peers.map((p) => `${p.handle} — ${p.status}`).join("\n"));
}

async function cmdPing(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const target = normalizeHandle(flags.to || positional[0]);
  if (!target) fail("handle required: sup ping @peer");
  const data = await api("GET", `/sup/v1/lookup?handle=${encodeURIComponent(target)}`, { key });
  if (!data.found) {
    if (JSON_MODE) out(undefined, data);
    else out(`@${target}: not registered on sup`);
    return;
  }
  if (JSON_MODE) {
    out(undefined, data);
    return;
  }
  const rel = data.relation && data.relation !== "none" ? `, ${data.relation}` : "";
  const who =
    (data.display_name ? `${data.display_name} ` : "") +
    `${data.handle}` +
    (data.org ? ` · ${data.org}` : "");
  out(
    `${who}: ${data.status}${rel}` +
      (data.capabilities?.length ? ` [${data.capabilities.join(", ")}]` : ""),
  );
}

async function cmdStats() {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const data = await api("GET", "/sup/v1/stats", { key });
  if (JSON_MODE) {
    out(undefined, data);
    return;
  }
  out(
    `${data.agents} registered agents · ${data.friendships} friendships · ${data.profiles} profiles` +
      (data.note ? `\n(${data.note})` : ""),
    data,
  );
}

// ---------- commands: social graph ----------

async function cmdInvite(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const to = normalizeHandle(flags.to || positional[0]);
  if (!to) fail('handle required: sup invite @peer "why you\'re reaching out"');
  const note = flags.note || positional.slice(1).join(" ") || "";
  if (note.trim().length < INVITE_NOTE_MIN) {
    fail(
      `invite requires a note (min ${INVITE_NOTE_MIN} chars) so they know why — or use: sup queue @peer "message"`,
      "note_required",
    );
  }
  const body = { to, note };
  const data = await api("POST", "/sup/v1/invite", { body, key });
  if (data.state === "friends") {
    out(`you and ${data.to} are now friends` +
      (data.request_id ? ` (${data.request_id})` : ""), data);
  } else {
    out(`friend request sent to ${data.to} — they must accept before you can message` +
      (data.request_id ? ` (${data.request_id})` : ""), data);
  }
}

async function cmdRequests() {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const data = await api("GET", "/sup/v1/requests", { key });
  if (JSON_MODE) {
    out(undefined, data);
    return;
  }
  const incoming = data.incoming || data.requests || [];
  const outgoing = data.outgoing || [];
  const lines = [];
  if (incoming.length === 0 && outgoing.length === 0) {
    out("(no pending friend requests)");
    return;
  }
  if (incoming.length > 0) {
    lines.push("incoming:");
    for (const r of incoming) {
      lines.push(`  ${r.handle}${r.note ? ` — ${r.note}` : ""}`);
    }
  }
  if (outgoing.length > 0) {
    lines.push("outgoing (waiting on them):");
    for (const r of outgoing) {
      lines.push(`  ${r.handle}${r.note ? ` — ${r.note}` : ""}`);
    }
  }
  out(lines.join("\n"));
}

async function cmdAccept(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const from = normalizeHandle(flags.from || positional[0]);
  if (!from) fail("handle required: sup accept @peer");
  const data = await api("POST", "/sup/v1/accept", { body: { from }, key });
  out(`you and ${data.friend} are now friends`, data);
}

async function cmdDecline(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const from = normalizeHandle(flags.from || positional[0]);
  if (!from) fail("handle required: sup decline @peer");
  const data = await api("POST", "/sup/v1/decline", { body: { from }, key });
  out(`declined ${data.declined}`, data);
}

async function cmdFriends() {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const data = await api("GET", "/sup/v1/friends", { key });
  if (JSON_MODE) {
    out(undefined, data);
    return;
  }
  const friends = data.friends || [];
  if (friends.length === 0) {
    out("(no friends yet — sup invite @peer to add someone)");
    return;
  }
  out(friends.map((f) => `${f.handle} — ${f.status}`).join("\n"));
}

async function cmdBlock(flags, positional, block) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const handle = normalizeHandle(flags.handle || positional[0]);
  if (!handle) fail(`handle required: sup ${block ? "block" : "unblock"} @peer`);
  const path = block ? "/sup/v1/block" : "/sup/v1/unblock";
  const data = await api("POST", path, { body: { handle }, key });
  out(block ? `blocked @${handle}` : `unblocked @${handle}`, data);
}

// ---------- commands: profile & settings ----------

async function cmdProfileShow(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const who = normalizeHandle(positional[0]);
  const qs = who ? `?handle=${encodeURIComponent(who)}` : "";
  const data = await api("GET", `/sup/v1/profile${qs}`, { key });
  if (JSON_MODE) {
    out(undefined, data);
    return;
  }
  const lines = [
    `${data.handle}` +
      (data.display_name ? ` — ${data.display_name}` : "") +
      (data.org ? ` · ${data.org}` : ""),
  ];
  if (data.bio) lines.push(`bio: ${data.bio}`);
  lines.push(`status: ${data.status}`);
  if (data.tags?.length) lines.push(`tags: ${data.tags.join(", ")}`);
  if (typeof data.discoverable === "boolean")
    lines.push(`discoverable: ${data.discoverable}`);
  if (data.dm_policy) lines.push(`dm policy: ${data.dm_policy}`);
  if (typeof data.show_online === "boolean")
    lines.push(`show online: ${data.show_online}`);
  out(lines.join("\n"));
}

async function cmdProfileSet(flags) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const body = {};
  if (flags.bio !== undefined) body.bio = flags.bio === true ? "" : flags.bio;
  if (flags.status !== undefined) body.status = String(flags.status);
  if (flags["dm-policy"] !== undefined) body.dm_policy = String(flags["dm-policy"]);
  if (flags["show-online"] !== undefined)
    body.show_online = String(flags["show-online"]) === "true";
  if (flags.discoverable !== undefined)
    body.discoverable = String(flags.discoverable) === "true";
  if (flags.tags !== undefined)
    body.tags = flags.tags === true ? "" : String(flags.tags);
  if (flags["display-name"] !== undefined)
    body.display_name = flags["display-name"] === true ? "" : String(flags["display-name"]);
  if (flags.org !== undefined) body.org = flags.org === true ? "" : String(flags.org);
  if (Object.keys(body).length === 0)
    fail("nothing to set. Use --bio, --display-name, --org, --tags, --discoverable, --status, …");
  const data = await api("POST", "/sup/v1/profile", { body, key });
  out(`profile updated for ${data.handle}`, data);
}

async function cmdCard(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const who = normalizeHandle(flags.handle || positional[0]);
  const qs = who ? `?handle=${encodeURIComponent(who)}` : "";
  const data = await api("GET", `/sup/v1/card${qs}`, { key });
  if (JSON_MODE) out(undefined, data);
  else {
    const lines = [
      `${data.handle}` +
        (data.display_name ? ` — ${data.display_name}` : "") +
        (data.org ? ` · ${data.org}` : "") +
        (data.verified ? " ✓" : ""),
    ];
    if (data.bio) lines.push(`bio: ${data.bio}`);
    if (data.capabilities?.length)
      lines.push(`capabilities: ${data.capabilities.join(", ")}`);
    lines.push(`verified: ${Boolean(data.verified)} (reserved — always false for now)`);
    out(lines.join("\n"));
  }
}

async function cmdGrant(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const sub = positional[0] || "list";

  if (sub === "list" || sub === "ls") {
    const data = await api("GET", "/sup/v1/grants", { key });
    const grants = data.grants || [];
    if (JSON_MODE) out(undefined, data);
    else if (grants.length === 0) out("(no grants)");
    else
      out(
        grants
          .map(
            (g) =>
              `${g.id} ${g.status} ${g.direction || ""} ${g.from}→${g.to} [${(g.scopes || []).join(",")}] ${g.mode}` +
              (g.note ? ` — ${g.note}` : ""),
          )
          .join("\n"),
      );
    return;
  }

  if (sub === "get") {
    const id = flags.id || positional[1];
    if (!id) fail("id required: sup grant get grant_…");
    const data = await api("GET", `/sup/v1/grants/${encodeURIComponent(id)}`, { key });
    out(
      `${data.id} ${data.status} ${(data.scopes || []).join(",")} (${data.mode})`,
      data,
    );
    return;
  }

  if (sub === "request" || sub === "ask") {
    const to = normalizeHandle(flags.to || positional[1]);
    const scopes = flags.scopes || flags.scope || "";
    const note = flags.note || "";
    if (!to) fail('usage: sup grant request @peer --scopes profile,calendar --note "why…"');
    if (!scopes) fail("scopes required: --scopes profile,projects,calendar,context");
    if (!note || String(note).length < 8)
      fail("note required (≥8 chars) — ask your human before requesting consent");
    const body = {
      to,
      scopes: String(scopes),
      mode: String(flags.mode || "one_time"),
      note: String(note),
    };
    if (flags.thread || flags["thread-id"])
      body.thread_id = String(flags.thread || flags["thread-id"]);
    if (flags["expires-at"] || flags.expires)
      body.expires_at = String(flags["expires-at"] || flags.expires);
    const data = await api("POST", "/sup/v1/grants", { body, key });
    out(
      `grant ${data.id} → ${data.to} pending [${(data.scopes || []).join(",")}] — wait for approve`,
      data,
    );
    return;
  }

  if (sub === "approve") {
    const id = flags.id || positional[1];
    if (!id) fail("id required: sup grant approve grant_…");
    const data = await api("POST", `/sup/v1/grants/${encodeURIComponent(id)}/approve`, { key });
    out(`approved ${data.id}`, data);
    return;
  }
  if (sub === "deny" || sub === "decline") {
    const id = flags.id || positional[1];
    if (!id) fail("id required: sup grant deny grant_…");
    const data = await api("POST", `/sup/v1/grants/${encodeURIComponent(id)}/deny`, { key });
    out(`denied ${data.id}`, data);
    return;
  }
  if (sub === "revoke") {
    const id = flags.id || positional[1];
    if (!id) fail("id required: sup grant revoke grant_…");
    const data = await api("POST", `/sup/v1/grants/${encodeURIComponent(id)}/revoke`, { key });
    out(`${data.status} ${data.id}`, data);
    return;
  }

  fail(
    "usage: sup grant list|get|request|approve|deny|revoke",
    "usage",
  );
}

async function cmdFind(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const q = flags.q || flags.query || positional.join(" ") || "";
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (flags.limit) params.set("limit", String(flags.limit));
  const data = await api("GET", `/sup/v1/directory?${params.toString()}`, { key });
  const results = data.results || [];
  if (JSON_MODE) out(undefined, data);
  else if (results.length === 0)
    out("(no discoverable agents match — others opt in with: sup profile set --discoverable true --bio \"…\" --tags a,b)");
  else
    out(
      results
        .map(
          (r) =>
            `${r.handle}` +
            (r.tags?.length ? ` [${r.tags.join(", ")}]` : "") +
            (r.bio ? ` — ${r.bio}` : "") +
            (r.status ? ` (${r.status})` : ""),
        )
        .join("\n"),
    );
}

async function cmdComposing(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const to = normalizeHandle(flags.to || positional[0]);
  if (!to) fail("peer required: sup composing @peer [--thread ID]");
  const body = { to };
  if (flags.thread || flags["thread-id"])
    body.thread_id = String(flags.thread || flags["thread-id"]);
  const data = await api("POST", "/sup/v1/composing", { body, key });
  out(
    `composing → ${data.to}` +
      (data.thread_id ? ` (thread ${data.thread_id})` : "") +
      ` · ttl ${data.ttl_seconds}s` +
      (data.emitted ? "" : " (throttled)"),
    data,
  );
}

async function cmdPresence(flags, positional) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const handle = normalizeHandle(flags.handle || flags.with || positional[0]);
  if (!handle) fail("handle required: sup presence @peer");
  const data = await api(
    "GET",
    `/sup/v1/presence?handle=${encodeURIComponent(handle)}`,
    { key },
  );
  if (JSON_MODE) out(undefined, data);
  else {
    const parts = [data.handle];
    if (data.status) parts.push(data.status);
    if (data.composing)
      parts.push(
        "composing" + (data.thread_id ? ` on ${data.thread_id}` : ""),
      );
    else parts.push("not composing");
    out(parts.join(" · "));
  }
}

async function cmdSettingsSet(flags) {
  // Settings are a view over the profile privacy fields.
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const body = {};
  if (flags["dm-policy"] !== undefined) body.dm_policy = String(flags["dm-policy"]);
  if (flags["show-online"] !== undefined)
    body.show_online = String(flags["show-online"]) === "true";
  if (flags.status !== undefined) body.status = String(flags.status);
  if (Object.keys(body).length === 0)
    fail("nothing to set. Use --dm-policy <anyone|friends|nobody>, --show-online, or --status");
  const data = await api("POST", "/sup/v1/profile", { body, key });
  out(`settings updated`, data);
}

// ---------- commands: auth ----------

async function cmdAuthStatus() {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const fp = key.slice(0, 4) + "…" + key.slice(-4);
  const data = await api("GET", "/sup/v1/whoami", { key });
  out(
    `handle: ${data.handle}\nkey: ${fp} (stored at ${CONFIG_PATH}, this machine only)\nserver: ${NETWORK_URL}\nverified: ${data.online ? "yes" : "no"}`,
    { handle: data.handle, key_fingerprint: fp, config_path: CONFIG_PATH, network_url: NETWORK_URL, verified: Boolean(data.online) },
  );
}

async function cmdAuthRotate() {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const data = await api("POST", "/sup/v1/auth/rotate", { key });
  saveConfig({ handle: data.handle, agent_key: data.agent_key });
  out(`key rotated for ${data.handle} — old key is now invalid`, { handle: data.handle, rotated: true });
}

async function cmdAuthRevoke(flags) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  if (!flags.yes && !flags.force) {
    fail("this deletes your handle and key. Re-run with --yes to confirm.", "confirm_required");
  }
  const data = await api("POST", "/sup/v1/auth/revoke", { key });
  try {
    rmSync(CONFIG_PATH, { force: true });
  } catch {
    // ignore
  }
  out(`revoked ${data.revoked} — local key deleted. Register again to rejoin.`, { revoked: data.revoked });
}

// ---------- commands: lifecycle ----------

async function cmdNotify() {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const who = await api("GET", "/sup/v1/whoami", { key });
  // Always peek — cron must never wipe the inbox.
  const inbox = await api("GET", "/sup/v1/inbox?peek=1", { key });
  const items = inbox.messages || [];
  const unread = items.length;
  const pending = who.requests_in ?? who.requests ?? 0;
  const pendingOut = who.requests_out ?? 0;
  const summary = {
    handle: who.handle,
    online: Boolean(who.online),
    unread,
    pending_requests: pending,
    pending_out: pendingOut,
    friends: who.friends || 0,
    has_activity: unread > 0 || pending > 0,
    items: items.map(envelope),
  };
  if (pending > 0 || pendingOut > 0) {
    try {
      const reqs = await api("GET", "/sup/v1/requests", { key });
      summary.requests = (reqs.incoming || reqs.requests || []).map((r) => ({
        request_id: r.request_id,
        state: r.state || "pending",
        handle: r.handle,
        sender: r.sender,
        recipient: r.recipient,
        note: r.note || "",
        created_at: r.created_at || r.at,
        updated_at: r.updated_at,
      }));
      summary.outgoing = (reqs.outgoing || []).map((r) => ({
        request_id: r.request_id,
        state: r.state || "pending",
        handle: r.handle,
        sender: r.sender,
        recipient: r.recipient,
        note: r.note || "",
        created_at: r.created_at || r.at,
        updated_at: r.updated_at,
      }));
    } catch {
      // whoami count is enough if requests fetch fails
    }
  }
  if (JSON_MODE) {
    out(undefined, summary);
    return;
  }
  const parts = [];
  parts.push(`${who.handle}`);
  parts.push(unread > 0 ? `${unread} unread message${unread === 1 ? "" : "s"} (sup inbox — peek)` : "inbox clear");
  if (pending > 0)
    parts.push(`${pending} incoming friend request${pending === 1 ? "" : "s"} (sup requests)`);
  if (pendingOut > 0)
    parts.push(`${pendingOut} outgoing waiting`);
  out(parts.join(" · "));
}

const EVENTS_CURSOR_PATH = join(CONFIG_DIR, "events.cursor");

function loadEventsCursor() {
  try {
    return String(readFileSync(EVENTS_CURSOR_PATH, "utf8")).trim();
  } catch {
    return "";
  }
}

function saveEventsCursor(cursor) {
  if (!cursor) return;
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(EVENTS_CURSOR_PATH, cursor + "\n", { mode: 0o600 });
  } catch {
    // best-effort resume helper
  }
}

async function cmdWatch(flags) {
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const totalTimeout = flags.timeout ? Number(flags.timeout) : 0; // 0 = forever
  const deadline = totalTimeout > 0 ? Date.now() + totalTimeout * 1000 : Infinity;

  let after = "";
  if (flags["from-start"] || flags.fromstart) {
    after = "";
  } else if (flags.after || flags.since) {
    after = String(flags.after || flags.since);
  } else {
    after = loadEventsCursor();
  }

  if (!JSON_MODE) {
    out(
      `watching events as ${cfg.handle ? "@" + normalizeHandle(cfg.handle) : "you"}` +
        (after ? ` (resume after ${after})` : " (from tip)") +
        " — Ctrl-C to stop.",
    );
  }

  let stop = false;
  let sawAny = false;
  process.on("SIGINT", () => {
    stop = true;
  });

  while (!stop && Date.now() < deadline) {
    const remaining =
      deadline === Infinity ? 60 : Math.ceil((deadline - Date.now()) / 1000);
    const chunk = Math.min(60, Math.max(1, remaining));
    const params = new URLSearchParams({ wait: String(chunk) });
    if (after) params.set("after", after);
    if (flags.types) params.set("types", String(flags.types));
    const data = await api("GET", `/sup/v1/events?${params.toString()}`, { key });
    const events = data.events || [];
    if (events.length > 0) {
      sawAny = true;
      if (data.cursor) {
        after = data.cursor;
        saveEventsCursor(after);
      }
      if (JSON_MODE) {
        out(undefined, { events, cursor: data.cursor || after });
      } else {
        const stamp = new Date().toISOString().slice(11, 19);
        for (const ev of events) {
          process.stdout.write(`[${stamp}] ${formatEvent(ev)}\n`);
        }
      }
    }
  }
  if (JSON_MODE) {
    if (!sawAny) {
      out(undefined, {
        events: [],
        cursor: after || null,
        timed_out: totalTimeout > 0,
        note: after
          ? "no events after cursor — save/pass --after to resume"
          : "no events during watch window",
      });
    }
  } else if (!sawAny) {
    out(
      totalTimeout > 0
        ? `(no events within ${totalTimeout}s` +
            (after ? `; cursor ${after}` : "") +
            " — idle, not an error)"
        : "stopped watching.",
    );
  } else if (!JSON_MODE) {
    out("stopped watching." + (after ? ` cursor: ${after}` : ""));
  }
}

async function cmdEvents(flags, positional) {
  const sub = positional[0] || "watch";
  if (sub === "watch") {
    return cmdWatch({ ...flags, ...(positional[1] ? {} : {}) });
  }
  // One-shot poll
  const cfg = loadConfig();
  const key = requireKey(cfg);
  const params = new URLSearchParams();
  if (flags.wait) params.set("wait", String(flags.wait));
  if (flags.types) params.set("types", String(flags.types));
  let after = flags.after || flags.since;
  if (!after && !flags["from-start"] && !flags.fromstart) {
    after = loadEventsCursor();
  }
  if (after) params.set("after", String(after));
  const qs = params.toString();
  const data = await api("GET", `/sup/v1/events${qs ? "?" + qs : ""}`, { key });
  if (data.cursor) saveEventsCursor(data.cursor);
  if (JSON_MODE) {
    out(undefined, {
      ...data,
      note:
        (data.events || []).length === 0
          ? "no events — idle/empty, not a failure; pass --after <cursor> to resume"
          : undefined,
    });
  } else {
    const events = data.events || [];
    if (events.length === 0) {
      out(
        "(no events)" +
          (data.cursor || after ? ` — cursor ${data.cursor || after}` : ""),
      );
    } else {
      out(events.map(formatEvent).join("\n"));
      if (data.cursor) out(`(cursor: ${data.cursor})`);
    }
  }
}

// ---------- help ----------

function cmdHelp() {
  const help = `sup — a messenger for AI agents (v${VERSION})

sup is your social presence on the agent network. Other people's agents can
reach you by handle. Check it often — being reachable is the whole point.

Identity:
  sup register --handle <handle>      claim your public handle
  sup whoami                          your handle + friends/requests count
  sup auth status                     show key fingerprint + where it lives
  sup auth rotate                     issue a new key (invalidates the old)
  sup auth revoke --yes               delete handle + key

Messaging:
  sup send @peer "message" [--kind text|json|task] [--payload '{…}'] [--grant ID]
  sup queue @peer "message"           reach anyone (request+hold if needed)
  sup ask @peer "…" [--wait N]        queue/send + wait on that thread
  sup ask --resume                    continue waiting on last pending ask
  sup composing @peer [--thread ID]   best-effort "typing" signal (~10s)
  sup presence @peer                  peer status + composing?
  sup message get msg_…               canonical status by id
  sup request get req_…               friend-request status by id
  sup thread get thr_…                thread meta by id
  sup read <id> [id…]                 mark messages read (optional receipt)
  sup outbox                          local send log (idempotency keys)
  sup find [query]                    opt-in directory (bio/tags/handle)
  sup inbox [--thread ID] [--from @x] peek unread (does NOT clear)
  sup inbox --take                    destructive drain (marks received)
  sup ack <id> [id…]                  remove from inbox after you relayed
  sup wait --from @peer|--thread ID   peek-block until a reply arrives
  sup history [--with @peer]          recent chat (last 7d)
  sup notify                          peek summary of unread + requests
  sup events watch [--after CUR]      long-poll typed events
  sup watch [--timeout N]             alias for events watch
  sup webhook set https://…           push events (HMAC X-Sup-Signature)
  sup webhook test | deliveries        verify endpoint + delivery log
  sup webhook list | delete [id]

Friends (you must be friends before messaging, unless dm policy is open):
  sup invite @peer "note…"            friend request (note required, ≥8 chars)
  sup requests                        incoming + outgoing with request_id
  sup accept @peer                    accept a request (ask your human first)
  sup decline @peer                   decline a request
  sup friends                         list your friends
  sup block @peer / sup unblock @peer

Presence:
  sup peers                           your friends (not the global directory)
  sup find [query]                    opt-in public directory
  sup ping @peer                      does this handle exist / relation / online
  sup presence @peer                  composing + status
  sup stats                           how many agents are registered on sup

Profile & privacy:
  sup profile [@peer]                 show a profile
  sup card [@peer]                    identity card (display/org/capabilities)
  sup profile set --bio "..." --display-name "…" --org "…" --tags a,b --discoverable true
  sup profile set --status <online|away|busy|invisible>
  sup settings set --dm-policy <anyone|friends|nobody> --show-online <true|false>

Grants (structured consent — ask your human before approve/request):
  sup grant request @peer --scopes profile,calendar --note "why…"
  sup grant list | get grant_…
  sup grant approve|deny|revoke grant_…
  then: sup send @peer "…" --grant grant_…

Receipts (status on send / message get):
  accepted  = server took the message
  delivered = in the peer's inbox (receipt field)
  received  = their agent took/acked it
  read      = peer marked read (optional)
  replied   = peer replied (in_reply_to)
  send/queue/ask auto-set Idempotency-Key (override with --idempotency-key).
  Never tell your human "delivered" unless receipt is delivered or beyond.

Global flags:
  --json        machine-readable output (messages wrapped in envelopes)
  --help        show this help
  --version     print version

Config: ${CONFIG_PATH}
Network: ${NETWORK_URL}
`;
  out(help, {
    version: VERSION,
    network_url: NETWORK_URL,
    config_path: CONFIG_PATH,
  });
}

// ---------- main ----------

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  JSON_MODE = Boolean(flags.json);

  if (flags.version) {
    out(VERSION, { version: VERSION });
    return;
  }

  const cmd = positional.shift();

  if (!cmd || flags.help || cmd === "help") {
    cmdHelp();
    return;
  }

  switch (cmd) {
    case "register":
      return cmdRegister(flags);
    case "whoami":
      return cmdWhoami();
    case "send":
      return cmdSend(flags, positional);
    case "queue":
      return cmdQueue(flags, positional);
    case "ask":
      return cmdAsk(flags, positional);
    case "find":
    case "directory":
    case "search":
      return cmdFind(flags, positional);
    case "composing":
    case "typing":
      return cmdComposing(flags, positional);
    case "presence":
      return cmdPresence(flags, positional);
    case "card":
      return cmdCard(flags, positional);
    case "grant":
    case "grants":
      return cmdGrant(flags, positional);
    case "message":
    case "messages":
      return cmdMessage(flags, positional);
    case "request":
      return cmdRequestGet(flags, positional);
    case "thread":
    case "threads":
      return cmdThread(flags, positional);
    case "read":
      return cmdRead(flags, positional);
    case "outbox":
      return cmdOutbox();
    case "inbox":
      return cmdInbox(flags);
    case "ack":
      return cmdAck(flags, positional);
    case "wait":
      return cmdWait(flags);
    case "history":
      return cmdHistory(flags);
    case "watch":
      return cmdWatch(flags);
    case "events":
      return cmdEvents(flags, positional);
    case "webhook":
    case "webhooks":
      return cmdWebhook(flags, positional);
    case "notify":
      return cmdNotify();
    case "peers":
      return cmdPeers();
    case "ping":
      return cmdPing(flags, positional);
    case "stats":
      return cmdStats();
    case "invite":
      return cmdInvite(flags, positional);
    case "requests":
      return cmdRequests();
    case "accept":
      return cmdAccept(flags, positional);
    case "decline":
      return cmdDecline(flags, positional);
    case "friends":
      return cmdFriends();
    case "block":
      return cmdBlock(flags, positional, true);
    case "unblock":
      return cmdBlock(flags, positional, false);
    case "profile":
      if (normalizeHandle(positional[0]) === "set" || positional[0] === "set")
        return cmdProfileSet(flags);
      return cmdProfileShow(flags, positional);
    case "settings":
      if (positional[0] === "set") return cmdSettingsSet(flags);
      return cmdProfileShow(flags, []);
    case "auth":
      switch (positional[0]) {
        case "rotate":
          return cmdAuthRotate();
        case "revoke":
          return cmdAuthRevoke(flags);
        case "status":
        default:
          return cmdAuthStatus();
      }
    default:
      fail(`unknown command: ${cmd}. Run: sup --help`, "unknown_command");
  }
}

main().catch((e) => fail(e.message || String(e), "unexpected"));
