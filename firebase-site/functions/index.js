// Email notifications for the REIT Rule Navigator private site.
//  1. notifyAdminsOfRequest: someone signed in without access (or sent a request) -> email every administrator.
//  2. emailNewMember: an administrator gave someone access -> email that person a link to sign in.
// Settings (asked for on first deploy, stored in functions/.env.<project>):
//   SITE_URL   your site's address, e.g. https://yourfirm-reit.web.app
//   MAIL_FROM  the From line, e.g. "Your Firm REIT Navigator <reit@yourfirm.com>"
//   FIRM_NAME  shown in the emails
// Secret (set with: npx firebase functions:secrets:set SMTP_URL):
//   SMTP_URL   your mail server, e.g. smtps://you%40yourfirm.com:APP_PASSWORD@smtp.gmail.com:465
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import nodemailer from "nodemailer";

initializeApp();
const SMTP_URL = defineSecret("SMTP_URL");
const SITE_URL = defineString("SITE_URL", { description: "Your site's address, e.g. https://yourfirm-reit.web.app" });
const MAIL_FROM = defineString("MAIL_FROM", { description: 'From line, e.g. "Your Firm <reit@yourfirm.com>"' });
const FIRM_NAME = defineString("FIRM_NAME", { default: "REIT Rule Navigator", description: "Firm name shown in the emails" });

// Don't email the administrators about the same person more than once in this many minutes.
const ADMIN_EMAIL_GAP_MIN = 30;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const site = () => SITE_URL.value().replace(/\/+$/, "") + "/";
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);

async function send(to, subject, text, html) {
  const transport = nodemailer.createTransport(SMTP_URL.value());
  await transport.sendMail({ from: MAIL_FROM.value(), to, subject, text, html });
}
function layout(title, bodyHtml, button, link) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1A1D2B">
<h2 style="font-size:20px;margin:0 0 12px">${esc(title)}</h2>${bodyHtml}
<p style="margin:22px 0"><a href="${esc(link)}" style="background:#4338CA;color:#fff;text-decoration:none;padding:11px 18px;border-radius:6px;font-weight:bold;display:inline-block">${esc(button)}</a></p>
<p style="font-size:12px;color:#5A6075">Or paste this link into your browser: ${esc(link)}</p>
<p style="font-size:12px;color:#5A6075">${esc(FIRM_NAME.value())} · REIT Rule Navigator</p></div>`;
}

// 1. Tell the administrators about an access request
export const notifyAdminsOfRequest = onDocumentWritten(
  { document: "accessRequests/{email}", secrets: [SMTP_URL] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after || after.status !== "pending") return;
    const isNew = !before || before.status !== "pending" || ms(before.requestedAt) !== ms(after.requestedAt);
    if (!isNew) return; // e.g. our own adminsNotifiedAt update
    if (after.adminsNotifiedAt && Date.now() - ms(after.adminsNotifiedAt) < ADMIN_EMAIL_GAP_MIN * 60000 && !(before && before.status !== "pending")) {
      logger.info("Skipped admin email (sent recently)", { email: event.params.email });
      return;
    }
    const db = getFirestore();
    const admins = (await db.collection("admins").get()).docs.map((d) => d.id).filter((e) => e.includes("@"));
    if (!admins.length) return;
    const who = after.name ? `${after.name} (${after.email})` : after.email;
    const link = site() + "#admin";
    const lines = [`${who} signed in to the REIT Rule Navigator and is asking for access.`];
    if (after.company) lines.push(`Needs: ${after.company}`);
    if (after.note) lines.push(`Note: ${after.note}`);
    lines.push("", `Open the Admin tab to give access or decline: ${link}`);
    const html = layout("New access request",
      `<p><b>${esc(who)}</b> signed in and is asking for access.</p>` +
      (after.company ? `<p><b>Needs:</b> ${esc(after.company)}</p>` : "") +
      (after.note ? `<p style="background:#F6F7FB;padding:10px 12px;border-radius:6px">${esc(after.note)}</p>` : "") +
      `<p>Open the Admin tab to give access or decline. The person gets an email with the sign-in link once you give access.</p>`,
      "Review the request", link);
    await send(admins.join(", "), `Access request: ${who}`, lines.join("\n"), html);
    await event.data.after.ref.update({ adminsNotifiedAt: FieldValue.serverTimestamp() });
    logger.info("Emailed administrators about access request", { email: event.params.email, admins: admins.length });
  }
);

// 2. Email a user who was just given access
export const emailNewMember = onDocumentWritten(
  { document: "entities/{eid}/members/{email}", secrets: [SMTP_URL] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return; // access removed
    const created = !before;
    const resend = before && ms(after.resendAt) !== ms(before.resendAt);
    const roleChanged = before && before.role !== after.role;
    if (!created && !resend && !roleChanged) return; // e.g. our own invitedAt update
    const email = event.params.email;
    const db = getFirestore();
    try {
      const ent = await db.doc(`entities/${event.params.eid}`).get();
      const entity = (ent.exists && ent.data().name) || "an entity";
      let hasAccount = true;
      try { await getAuth().getUserByEmail(email); } catch (e) { if (e.code === "auth/user-not-found") hasAccount = false; else throw e; }
      const link = site() + "?email=" + encodeURIComponent(email) + "&invite=" + (hasAccount ? "existing" : "new");
      const roleText = { editor: "work on and save reports for", viewer: "view", client: "update the client dashboard, REIT structure evaluation, trial balance and questionnaire for" }[after.role] || "view";
      const roleName = { editor: "employee (full access)", viewer: "employee (view only)", client: "client" }[after.role] || after.role;
      const steps = hasAccount
        ? ["Click the button below.", "Sign in with this email address and your password."]
        : ["Click the button below.", "Choose a password and click Create account.", "Open the verification email we send you, then come back and sign in."];
      const text = [`You've been given access to ${entity} in the ${FIRM_NAME.value()} REIT Rule Navigator. You can ${roleText} it.`, "",
        ...steps.map((s, i) => `${i + 1}. ${s}`), "", `Sign in: ${link}`].join("\n");
      const html = layout(`You have access to ${entity}`,
        `<p>${esc(FIRM_NAME.value())} gave you <b>${esc(roleName)}</b> access to <b>${esc(entity)}</b> in the REIT Rule Navigator. You can ${esc(roleText)} it.</p>` +
        `<ol>${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`,
        hasAccount ? "Sign in" : "Create your account", link);
      await send(email, `You have access to ${entity}`, text, html);
      await event.data.after.ref.update({ invitedAt: FieldValue.serverTimestamp(), inviteError: FieldValue.delete() });
      logger.info("Emailed new member", { email, entity, hasAccount });
    } catch (e) {
      logger.error("Invite email failed", { email, error: String(e) });
      await event.data.after.ref.update({ inviteError: String(e.message || e).slice(0, 300) });
    }
  }
);

// 3. assistantChat: the REIT assistant (see assistant.js).
export { assistantChat } from "./assistant.js";
