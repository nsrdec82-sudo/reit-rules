// Checks the Firestore security rules: run with  npm run test:rules
// Needs Java and the Firebase CLI (installed by npm install).
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, setDoc, updateDoc, collection, getDocs, deleteDoc, serverTimestamp } from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "reit-rules-test",
  firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
});

// Seed data with rules turned off
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "admins/admin@firm.com"), { addedBy: "setup" });
  await setDoc(doc(db, "entities/A"), { name: "Alpha REIT" });
  await setDoc(doc(db, "entities/B"), { name: "Beta REIT" });
  await setDoc(doc(db, "entities/A/members/editor@client.com"), { role: "editor" });
  await setDoc(doc(db, "entities/A/members/viewer@client.com"), { role: "viewer" });
  await setDoc(doc(db, "entities/B/members/other@client.com"), { role: "editor" });
  await setDoc(doc(db, "entities/A/members/cfo@alpha.com"), { role: "client" });
  await setDoc(doc(db, "entities/A/years/2026"), { profile: { name: "Alpha REIT" } });
  await setDoc(doc(db, "entities/B/years/2026"), { profile: { name: "Beta REIT" } });
  await setDoc(doc(db, "entities/A/years/2026/reports/r1"), { title: "Q4", year: "2026", createdBy: "editor@client.com" });
});

const as = (email, verified = true) => env.authenticatedContext(email.replace(/\W/g, ""), { email, email_verified: verified }).firestore();
const admin = as("admin@firm.com"), editor = as("editor@client.com"), viewer = as("viewer@client.com"),
  other = as("other@client.com"), client = as("cfo@alpha.com"), stranger = as("stranger@gmail.com"), unverified = as("editor@client.com", false),
  anon = env.unauthenticatedContext().firestore();

let passed = 0, failed = 0;
async function check(label, p) { try { await p; passed++; console.log("  ok   " + label); } catch (e) { failed++; console.log("  FAIL " + label + ": " + e.message); } }

console.log("Entity isolation");
await check("editor reads own entity's year", assertSucceeds(getDoc(doc(editor, "entities/A/years/2026"))));
await check("editor cannot read another entity", assertFails(getDoc(doc(editor, "entities/B/years/2026"))));
await check("editor cannot list another entity's years", assertFails(getDocs(collection(editor, "entities/B/years"))));
await check("other user cannot read entity A", assertFails(getDoc(doc(other, "entities/A/years/2026"))));
await check("stranger with an account sees nothing", assertFails(getDoc(doc(stranger, "entities/A"))));
await check("signed-out visitor sees nothing", assertFails(getDoc(doc(anon, "entities/A"))));
await check("unverified email sees nothing", assertFails(getDoc(doc(unverified, "entities/A/years/2026"))));
await check("non-admin cannot list all entities", assertFails(getDocs(collection(editor, "entities"))));

console.log("Roles");
await check("editor saves the year", assertSucceeds(setDoc(doc(editor, "entities/A/years/2026"), { profile: { name: "Alpha REIT" } })));
await check("editor starts a new year", assertSucceeds(setDoc(doc(editor, "entities/A/years/2027"), { profile: {} })));
await check("year id must be four digits", assertFails(setDoc(doc(editor, "entities/A/years/abc"), { profile: {} })));
await check("editor starts a quarter", assertSucceeds(setDoc(doc(editor, "entities/A/years/2026-Q2"), { profile: { qtr: "2" } })));
await check("quarter must be Q1 to Q4", assertFails(setDoc(doc(editor, "entities/A/years/2026-Q5"), { profile: {} })));
await check("editor saves a report in a quarter", assertSucceeds(setDoc(doc(editor, "entities/A/years/2026-Q2/reports/q2r"), { title: "T", year: "2026-Q2", createdBy: "editor@client.com", createdAt: serverTimestamp() })));
await check("viewer reads the year", assertSucceeds(getDoc(doc(viewer, "entities/A/years/2026"))));
await check("viewer cannot change the year", assertFails(setDoc(doc(viewer, "entities/A/years/2026"), { profile: {} })));
await check("editor cannot delete a year", assertFails(deleteDoc(doc(editor, "entities/A/years/2026"))));

console.log("Saved reports");
await check("editor saves a report as themselves", assertSucceeds(setDoc(doc(editor, "entities/A/years/2026/reports/r2"), { title: "T", year: "2026", createdBy: "editor@client.com", createdAt: serverTimestamp() })));
await check("report must name its own author", assertFails(setDoc(doc(editor, "entities/A/years/2026/reports/r3"), { title: "T", year: "2026", createdBy: "admin@firm.com" })));
await check("report must match its year folder", assertFails(setDoc(doc(editor, "entities/A/years/2026/reports/r4"), { title: "T", year: "2025", createdBy: "editor@client.com" })));
await check("saved report cannot be edited", assertFails(setDoc(doc(editor, "entities/A/years/2026/reports/r1"), { title: "changed", year: "2026", createdBy: "editor@client.com" })));
await check("viewer cannot save a report", assertFails(setDoc(doc(viewer, "entities/A/years/2026/reports/r5"), { title: "T", year: "2026", createdBy: "viewer@client.com" })));
await check("viewer reads saved reports", assertSucceeds(getDocs(collection(viewer, "entities/A/years/2026/reports"))));
await check("editor writes PDF chunks", assertSucceeds(setDoc(doc(editor, "entities/A/years/2026/reports/r2/chunks/0000"), { i: 0, data: "JVBER" })));
await check("other user cannot read the PDF", assertFails(getDocs(collection(other, "entities/A/years/2026/reports/r2/chunks"))));
await check("editor cannot delete a report", assertFails(deleteDoc(doc(editor, "entities/A/years/2026/reports/r1"))));
await check("admin deletes a report", assertSucceeds(deleteDoc(doc(admin, "entities/A/years/2026/reports/r1"))));

console.log("Administration");
await check("editor cannot grant access", assertFails(setDoc(doc(editor, "entities/A/members/friend@x.com"), { role: "editor" })));
await check("editor cannot make themselves admin", assertFails(setDoc(doc(editor, "admins/editor@client.com"), {})));
await check("stranger cannot create an entity", assertFails(setDoc(doc(stranger, "entities/C"), { name: "Mine" })));
await check("admin grants access", assertSucceeds(setDoc(doc(admin, "entities/B/members/editor@client.com"), { role: "viewer" })));
await check("role must be viewer or editor", assertFails(setDoc(doc(admin, "entities/B/members/x@y.com"), { role: "owner" })));
await check("admin lists all entities", assertSucceeds(getDocs(collection(admin, "entities"))));
await check("user reads own access list", assertSucceeds(getDoc(doc(editor, "access/editor@client.com"))));
await check("user cannot read someone else's access list", assertFails(getDoc(doc(editor, "access/other@client.com"))));

console.log("Access requests");
const req = (email, extra = {}) => Object.assign({ email, uid: email.replace(/\W/g, ""), name: "Sam", company: "Alpha REIT", note: "Need to view", status: "pending", requestedAt: serverTimestamp(), auto: false }, extra);
await check("stranger asks for access", assertSucceeds(setDoc(doc(stranger, "accessRequests/stranger@gmail.com"), req("stranger@gmail.com"))));
await check("stranger reads own request", assertSucceeds(getDoc(doc(stranger, "accessRequests/stranger@gmail.com"))));
await check("stranger updates own note", assertSucceeds(setDoc(doc(stranger, "accessRequests/stranger@gmail.com"), req("stranger@gmail.com", { note: "More detail" }), { merge: true })));
await check("cannot ask in someone else's name", assertFails(setDoc(doc(stranger, "accessRequests/victim@client.com"), req("victim@client.com"))));
await check("cannot approve own request", assertFails(updateDoc(doc(stranger, "accessRequests/stranger@gmail.com"), { status: "approved" })));
await check("cannot fake the admin-notified time", assertFails(updateDoc(doc(stranger, "accessRequests/stranger@gmail.com"), { adminsNotifiedAt: serverTimestamp() })));
await check("cannot add other fields", assertFails(setDoc(doc(stranger, "accessRequests/stranger@gmail.com"), req("stranger@gmail.com", { role: "editor" }))));
await check("note limited to 1,000 characters", assertFails(setDoc(doc(stranger, "accessRequests/stranger@gmail.com"), req("stranger@gmail.com", { note: "x".repeat(1001) }))));
await check("unverified email cannot ask", assertFails(setDoc(doc(as("new@x.com", false), "accessRequests/new@x.com"), req("new@x.com"))));
await check("user cannot read others' requests", assertFails(getDocs(collection(editor, "accessRequests"))));
await check("admin lists requests", assertSucceeds(getDocs(collection(admin, "accessRequests"))));
await check("admin declines a request", assertSucceeds(updateDoc(doc(admin, "accessRequests/stranger@gmail.com"), { status: "declined", decidedBy: "admin@firm.com" })));
await check("declined user asks again", assertSucceeds(setDoc(doc(stranger, "accessRequests/stranger@gmail.com"), req("stranger@gmail.com"), { merge: true })));
await check("admin sets resend on an invite", assertSucceeds(updateDoc(doc(admin, "entities/A/members/viewer@client.com"), { resendAt: serverTimestamp() })));
await check("editor cannot resend invites", assertFails(updateDoc(doc(editor, "entities/A/members/viewer@client.com"), { resendAt: serverTimestamp() })));

console.log("Client access");
await check("client reads its entity's year", assertSucceeds(getDoc(doc(client, "entities/A/years/2026"))));
await check("client updates the profile", assertSucceeds(updateDoc(doc(client, "entities/A/years/2026"), { profile: { name: "Alpha REIT", qa: { "rentnp": { v: "no" } } }, updatedAt: serverTimestamp(), updatedBy: "cfo@alpha.com" })));
await check("client cannot change figures", assertFails(updateDoc(doc(client, "entities/A/years/2026"), { figures: { i_rent: "1" }, updatedBy: "cfo@alpha.com" })));
await check("client cannot replace the trial balance", assertFails(updateDoc(doc(client, "entities/A/years/2026"), { tb: [], updatedBy: "cfo@alpha.com" })));
await check("client cannot start a new year", assertFails(setDoc(doc(client, "entities/A/years/2028"), { profile: {}, updatedBy: "cfo@alpha.com" })));
await check("client must sign its own changes", assertFails(updateDoc(doc(client, "entities/A/years/2026"), { profile: {}, updatedBy: "editor@client.com" })));
await check("client cannot read saved reports", assertFails(getDocs(collection(client, "entities/A/years/2026/reports"))));
await check("client cannot save a report", assertFails(setDoc(doc(client, "entities/A/years/2026/reports/c1"), { title: "T", year: "2026", createdBy: "cfo@alpha.com" })));
await check("client cannot read another entity", assertFails(getDoc(doc(client, "entities/B/years/2026"))));
await check("admin grants client access", assertSucceeds(setDoc(doc(admin, "entities/B/members/cfo@beta.com"), { role: "client" })));

console.log(`\n${passed} passed, ${failed} failed`);
await env.cleanup();
process.exit(failed ? 1 : 0);
