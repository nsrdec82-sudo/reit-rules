/**
 * Client Portal — server code (Firebase Cloud Functions, codebase "portal").
 * Shares the Firebase project with the REIT Rule Navigator but touches only its own data:
 * portal_users/{uid} and portal_clients/{cid}/... in Firestore, portal/... in Storage.
 *
 *  portalBootstrapAdmin   anyone in the REIT "admins" list becomes a portal administrator on first sign-in
 *  portalCreateUser       admin adds a person: account (or existing account) + invitation email
 *  portalResendInvite     admin issues a new temporary password and re-sends the email
 *  portalDeleteUser       admin removes a person from the portal
 *  portalSyncClaims       keeps sign-in claims (used by the Storage rules) in step with portal_users
 *  portalNotifyOnMessage  emails everyone in the chosen team (with access to that client) about a new message
 *  portalDailyReminders   every morning, emails providers about action items open more than a week
 *  portalAiSummarize      Claude summary of an attachment
 *  portalAiSuggestActions Claude suggests action items from a client's conversation
 *
 * Reuses the project's existing secrets: SMTP_URL (mail server) and ANTHROPIC_API_KEY.
 * Settings (functions/.env.<project>, written by the GitHub deploy): PORTAL_URL, PORTAL_NAME.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

const PORTAL_URL = defineString("PORTAL_URL", { description: "Web address of the portal, e.g. https://your-project-portal.web.app" });
const PORTAL_NAME = defineString("PORTAL_NAME", { default: "Client Portal", description: "Name shown in emails" });
const PORTAL_MAIL_FROM = defineString("PORTAL_MAIL_FROM", { default: "", description: "Optional From line; blank = the mail server's own address" });
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", { default: "claude-sonnet-5-5", description: "Anthropic model used for AI summaries" });
const SMTP_URL = defineSecret("SMTP_URL");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const USERS = "portal_users", CLIENTS = "portal_clients";
const ROLE = { client: "Client", provider: "Service Provider" };
const TEAM = { client: "Client team", provider: "Service Provider team" };
const DAY = 86400000;

// ---------- helpers ----------
const norm = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const portalUrl = () => PORTAL_URL.value().replace(/\/+$/, "") + "/";
function tempPassword() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = require("crypto").randomBytes(12);
  return [...bytes].map((b) => A[b % A.length]).join("").replace(/(.{4})(?=.)/g, "$1-");
}
async function profile(uid) {
  if (!uid) return null;
  const s = await db.doc(`${USERS}/${uid}`).get();
  return s.exists ? { id: s.id, ...s.data() } : null;
}
async function requireAdmin(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const me = await profile(req.auth.uid);
  if (!me || !me.isAdmin) throw new HttpsError("permission-denied", "Only the portal administrator can do this.");
  return me;
}
const canClient = (u, cid) => !!u && (u.isAdmin || u.allClients || (u.clientIds || []).includes(cid));
async function requireClient(req, cid) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const me = await profile(req.auth.uid);
  if (!canClient(me, cid)) throw new HttpsError("permission-denied", "You don't have access to this client.");
  return me;
}
function fromLine() {
  if (PORTAL_MAIL_FROM.value()) return PORTAL_MAIL_FROM.value();
  try { const u = new URL(SMTP_URL.value()); const addr = decodeURIComponent(u.username || ""); if (addr.includes("@")) return `"${PORTAL_NAME.value()}" <${addr}>`; } catch (e) { /* fall through */ }
  return undefined;
}
async function send(to, subject, text) {
  const transport = nodemailer.createTransport(SMTP_URL.value());
  await transport.sendMail({ from: fromLine(), to, subject, text });
}
function inviteText(u, temp, kind) {
  const name = PORTAL_NAME.value();
  const intro = kind === "reset" ? `Your password for the ${name} has been reset.`
    : `You've been given access to our ${name} as ${u.role === "client" ? "a Client" : "a Service Provider"}. You can use it to message us, share files, and track action items.`;
  const how = kind === "existing"
    ? `How to sign in:
1. Open the portal: ${portalUrl()}
2. Sign in with ${u.email} and the password you already use with us.
   Forgot it? Use "Forgot password?" on the sign-in page to get a reset link.`
    : `How to sign in:
1. Open the portal: ${portalUrl()}
2. Enter:
   Login ID: ${u.email}
   Temporary password: ${temp}
3. You'll be asked to choose your own password straight away (at least 10 characters, with letters and a number).`;
  return {
    subject: kind === "reset" ? `Your ${name} password has been reset` : `You're invited to the ${name}`,
    text: `Hi ${u.firstName || "there"},\n\n${intro}\n\n${how}\n\nIf you have any trouble signing in, just reply to this email.\n\nThank you`,
  };
}
function cleanAccess(data) {
  const role = data.role === "provider" ? "provider" : "client";
  const allClients = !!data.allClients;
  const clientIds = allClients ? [] : (Array.isArray(data.clientIds) ? data.clientIds.filter((x) => typeof x === "string").slice(0, 30) : []);
  return { role, allClients, clientIds };
}

// ---------- administrator ----------
exports.portalBootstrapAdmin = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const email = norm(req.auth.token.email);
  if (!email || req.auth.token.email_verified !== true) throw new HttpsError("permission-denied", "This account isn't on the portal's user list.");
  const isReitAdmin = (await db.doc(`admins/${email}`).get()).exists;
  if (!isReitAdmin) throw new HttpsError("permission-denied", "This account isn't on the portal's user list.");
  const ref = db.doc(`${USERS}/${req.auth.uid}`);
  const snap = await ref.get();
  if (snap.exists && snap.data().isAdmin) return { ok: true };
  const nm = String(req.auth.token.name || "").trim().split(/\s+/).filter(Boolean);
  await ref.set({
    firstName: nm[0] || email.split("@")[0], lastName: nm.slice(1).join(" "), email, role: "provider",
    isAdmin: true, allClients: true, clientIds: [], mustChangePassword: false, passwordSetAt: Date.now(), createdAt: Date.now(),
  }, { merge: true });
  return { ok: true };
});

exports.portalCreateUser = onCall({ secrets: [SMTP_URL] }, async (req) => {
  const me = await requireAdmin(req);
  const d = req.data || {};
  const email = norm(d.email);
  const firstName = String(d.firstName || "").trim().slice(0, 60);
  const lastName = String(d.lastName || "").trim().slice(0, 60);
  if (!firstName || !lastName) throw new HttpsError("invalid-argument", "First and last name are required.");
  if (!validEmail(email)) throw new HttpsError("invalid-argument", "Enter a valid email address.");
  let user = null, kind = "new", temp = null;
  try { user = await admin.auth().getUserByEmail(email); kind = "existing"; } catch (e) { if (e.code !== "auth/user-not-found") throw e; }
  if (user && (await db.doc(`${USERS}/${user.uid}`).get()).exists) throw new HttpsError("already-exists", "That person is already a portal user.");
  if (!user) {
    temp = tempPassword();
    user = await admin.auth().createUser({ email, password: temp, displayName: `${firstName} ${lastName}`, emailVerified: true });
  }
  const u = { firstName, lastName, email, ...cleanAccess(d), isAdmin: false, mustChangePassword: kind === "new", createdAt: Date.now(), createdBy: me.id, resetAt: Date.now() };
  if (kind === "existing") u.passwordSetAt = Date.now();
  await db.doc(`${USERS}/${user.uid}`).set(u);
  const m = inviteText(u, temp, kind);
  try { await send(email, m.subject, m.text); }
  catch (e) { logger.error("Invite email failed", e); throw new HttpsError("internal", "The user was added, but the invitation email couldn't be sent. Check the SMTP_URL secret, then use Resend invite."); }
  return { ok: true, uid: user.uid, existingAccount: kind === "existing" };
});

exports.portalResendInvite = onCall({ secrets: [SMTP_URL] }, async (req) => {
  await requireAdmin(req);
  const uid = String((req.data || {}).uid || "");
  const u = await profile(uid);
  if (!u) throw new HttpsError("not-found", "User not found.");
  const temp = tempPassword();
  await admin.auth().updateUser(uid, { password: temp });
  await admin.auth().revokeRefreshTokens(uid);
  const wasActive = !u.mustChangePassword;
  await db.doc(`${USERS}/${uid}`).update({ mustChangePassword: true, resetAt: Date.now() });
  const m = inviteText(u, temp, wasActive ? "reset" : "new");
  await send(u.email, m.subject, m.text);
  return { ok: true };
});

exports.portalDeleteUser = onCall(async (req) => {
  const me = await requireAdmin(req);
  const uid = String((req.data || {}).uid || "");
  if (uid === me.id) throw new HttpsError("failed-precondition", "You can't remove yourself.");
  const u = await profile(uid);
  await db.doc(`${USERS}/${uid}`).delete();
  // Delete the sign-in account only if the portal created it and it isn't used by the REIT site.
  if (u && u.email && !(await db.doc(`admins/${u.email}`).get()).exists) {
    const reit = await db.collection("access").doc(u.email).get();
    if (!reit.exists) { try { await admin.auth().deleteUser(uid); } catch (e) { if (e.code !== "auth/user-not-found") throw e; } }
  }
  return { ok: true };
});

// Storage rules can't read Firestore cheaply, so each person's client access is mirrored into sign-in claims.
exports.portalSyncClaims = onDocumentWritten("portal_users/{uid}", async (event) => {
  const uid = event.params.uid;
  const after = event.data.after.exists ? event.data.after.data() : null;
  let current = {};
  try { current = (await admin.auth().getUser(uid)).customClaims || {}; } catch (e) { if (e.code === "auth/user-not-found") return; throw e; }
  const next = { ...current };
  delete next.pa; delete next.pc; delete next.pr;
  if (after) {
    next.pr = after.role === "provider" ? "provider" : "client";
    next.pa = !!(after.isAdmin || after.allClients);
    next.pc = next.pa ? [] : (after.clientIds || []).slice(0, 30);
  }
  await admin.auth().setCustomUserClaims(uid, next);
});

// ---------- notifications ----------
async function teamFor(cid, role) {
  const snap = await db.collection(USERS).where("role", "==", role).get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((u) => canClient(u, cid));
  if (role === "provider") {
    const admins = await db.collection(USERS).where("isAdmin", "==", true).get();
    admins.docs.forEach((d) => { if (!list.some((x) => x.id === d.id)) list.push({ id: d.id, ...d.data() }); });
  }
  return list.filter((u) => u.email);
}

exports.portalNotifyOnMessage = onDocumentCreated({ document: "portal_clients/{cid}/messages/{mid}", secrets: [SMTP_URL] }, async (event) => {
  const msg = event.data && event.data.data();
  if (!msg || msg.notify === false) return;
  const cid = event.params.cid;
  const to = msg.to === "client" ? "client" : "provider";
  const client = (await db.doc(`${CLIENTS}/${cid}`).get()).data() || {};
  const people = (await teamFor(cid, to)).filter((u) => u.id !== msg.authorId);
  if (!people.length) return;
  const files = [];
  for (const id of msg.attachmentIds || []) {
    const a = await db.doc(`${CLIENTS}/${cid}/attachments/${id}`).get();
    if (a.exists) files.push(a.data().name);
  }
  const excerpt = (msg.text || "").length > 1500 ? msg.text.slice(0, 1497) + "…" : (msg.text || "(no text)");
  const subject = `[${PORTAL_NAME.value()}] ${client.name || "Client"}: ${msg.subject || "New message"}`;
  for (const u of people) {
    const text =
`Hi ${u.firstName || "there"},

${msg.authorName || ROLE[msg.role] || "Someone"} (${ROLE[msg.role] || ""}) sent a new message to the ${TEAM[to]} for ${client.name || "a client"}.

Subject: ${msg.subject || ""}

${excerpt}
${files.length ? `\nAttachments: ${files.join(", ")}\n` : ""}
Sign in to read the full conversation and reply:
${portalUrl()}`;
    try { await send(u.email, subject, text); } catch (e) { logger.error("Notification failed", u.email, e); }
  }
  logger.info(`Sent ${people.length} notification(s) for message ${event.params.mid}`);
});

exports.portalDailyReminders = onSchedule({ schedule: "every day 08:00", timeZone: "America/Chicago", secrets: [SMTP_URL] }, async () => {
  const clients = await db.collection(CLIENTS).get();
  const byProvider = {};
  const now = Date.now();
  for (const c of clients.docs) {
    const acts = await c.ref.collection("actions").get();
    const late = acts.docs.map((d) => d.data()).filter((a) => a.status !== "completed" && a.status !== "done" && now - (a.createdAt || now) > 7 * DAY);
    if (!late.length) continue;
    for (const u of await teamFor(c.id, "provider")) {
      (byProvider[u.email] = byProvider[u.email] || { u, lines: [] }).lines.push(
        `${c.data().name}:\n` + late.map((a) => `  • ${a.title} — open ${Math.floor((now - a.createdAt) / DAY)} days (${a.status || "open"}, ${ROLE[a.owner] || ""})`).join("\n"));
    }
  }
  for (const { u, lines } of Object.values(byProvider)) {
    try {
      await send(u.email, `[${PORTAL_NAME.value()}] Reminder: action items open for more than a week`,
`Hi ${u.firstName || "there"},

These action items have been open for more than a week:

${lines.join("\n\n")}

Review and update them in the portal: ${portalUrl()}`);
    } catch (e) { logger.error("Reminder failed", u.email, e); }
  }
  logger.info(`Sent reminders to ${Object.keys(byProvider).length} provider(s)`);
});

// ---------- AI (Claude) ----------
async function claude(content, maxTokens = 1500) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY.value(), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CLAUDE_MODEL.value(), max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) {
    logger.error("Anthropic API error", res.status, await res.text());
    throw new HttpsError("unavailable", res.status === 401 ? "The AI key isn't valid — check the ANTHROPIC_API_KEY secret." : "The AI service couldn't finish that right now.");
  }
  const j = await res.json();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
function parseJSON(text) {
  const m = String(text).match(/[\[{][\s\S]*[\]}]/);
  try { return JSON.parse(m ? m[0] : "null"); } catch { return null; }
}

exports.portalAiSummarize = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB" }, async (req) => {
  const { clientId, attachmentId } = req.data || {};
  await requireClient(req, clientId);
  const ref = db.doc(`${CLIENTS}/${clientId}/attachments/${attachmentId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Attachment not found.");
  const att = snap.data();
  const client = (await db.doc(`${CLIENTS}/${clientId}`).get()).data() || {};
  const msgs = await db.collection(`${CLIENTS}/${clientId}/messages`).orderBy("ts", "desc").limit(25).get();
  const convo = msgs.docs.reverse().map((d) => { const m = d.data(); return `${ROLE[m.role]} — ${m.subject || ""}: ${m.text || "(attachment)"}`; }).join("\n") || "(no messages)";
  const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(att.type || "");
  const content = [];
  if (isImage) {
    const [buf] = await admin.storage().bucket().file(att.storagePath).download();
    if (buf.length > 5 * 1024 * 1024) throw new HttpsError("failed-precondition", "This image is too large to analyse (over 5 MB).");
    content.push({ type: "image", source: { type: "base64", media_type: att.type === "image/jpg" ? "image/jpeg" : att.type, data: buf.toString("base64") } });
  } else if (!(att.text || "").trim()) {
    throw new HttpsError("failed-precondition", "No readable text in this file (it may be a scanned PDF or an older .doc/.xls file).");
  }
  content.push({ type: "text", text:
`You analyse a file shared between a client and a service provider about "${client.name || "a client"}".
File: ${att.name} (${att.type}), sent by the ${ROLE[att.role] || "a participant"}.
${isImage ? "The file is the attached image." : `File contents (may be truncated):\n"""\n${att.text}\n"""`}

Recent emails for context:
${convo}

Return ONLY JSON, no prose:
{"summary": "2-4 sentence plain-language summary of what the file is and what matters in it",
 "keyPoints": ["up to 6 short key facts: figures, totals, dates, deadlines, decisions, risks"],
 "actionItems": [{"title": "short imperative task, max 90 chars", "owner": "provider" | "client"}]}
Include only action items the file actually implies. Use [] if none.` });
  const out = parseJSON(await claude(content));
  if (!out || typeof out.summary !== "string") throw new HttpsError("internal", "The AI returned an unexpected answer. Please try again.");
  const result = {
    summary: out.summary.slice(0, 1500),
    keyPoints: (Array.isArray(out.keyPoints) ? out.keyPoints : []).slice(0, 8).map((s) => String(s).slice(0, 300)),
    suggested: (Array.isArray(out.actionItems) ? out.actionItems : []).filter((x) => x && x.title).slice(0, 8)
      .map((x) => ({ title: String(x.title).slice(0, 140), owner: x.owner === "client" ? "client" : "provider" })),
    summarizedAt: Date.now(),
  };
  await ref.update(result);
  return result;
});

exports.portalAiSuggestActions = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120 }, async (req) => {
  const ids = Array.isArray((req.data || {}).clientIds) ? req.data.clientIds.slice(0, 20) : [];
  if (!ids.length) throw new HttpsError("invalid-argument", "No client selected.");
  for (const cid of ids) await requireClient(req, cid);
  const lines = [], existing = [];
  for (const cid of ids) {
    const c = (await db.doc(`${CLIENTS}/${cid}`).get()).data() || {};
    const ms = await db.collection(`${CLIENTS}/${cid}/messages`).orderBy("ts", "desc").limit(60).get();
    ms.docs.reverse().forEach((d) => { const m = d.data(); lines.push(`[${d.id}] (client ${cid}: ${c.name}) ${ROLE[m.role]} — Subject: ${m.subject || ""}: ${m.text || ""}`); });
    const as = await db.collection(`${CLIENTS}/${cid}/actions`).get();
    as.docs.forEach((d) => existing.push(`- (${c.name}) ${d.data().title}`));
  }
  if (!lines.length) return { suggestions: [] };
  const out = parseJSON(await claude(
`You extract action items from emails between a client and a service provider. Each line names its client.
Return ONLY a JSON array (no prose) of objects: {"title": short imperative task (max 90 chars), "owner": "provider" | "client", "entityId": the client id from the line, "sourceMsgId": the id in brackets}.
Include only concrete commitments, requests or follow-ups not already covered by an existing item. Return [] if none.

Existing action items:
${existing.join("\n") || "(none)"}

Emails:
${lines.join("\n")}`));
  const list = (Array.isArray(out) ? out : []).filter((x) => x && x.title).map((x) => ({
    title: String(x.title).slice(0, 140), owner: x.owner === "client" ? "client" : "provider",
    entityId: ids.includes(x.entityId) ? x.entityId : ids[0], sourceMsgId: x.sourceMsgId ? String(x.sourceMsgId) : null,
  }));
  return { suggestions: list };
});
