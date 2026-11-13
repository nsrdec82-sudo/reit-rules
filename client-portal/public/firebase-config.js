// Firebase settings for the Client Portal.
// On Firebase Hosting they load automatically from /__/firebase/init.json.
// The GitHub deploy also writes them to config.json as a fallback, so nothing needs to be pasted here.
let config = null;
for (const url of ["/__/firebase/init.json", "./config.json"]) {
  try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) { const c = await r.json(); if (c && c.apiKey) { config = c; break; } } } catch (e) { /* try the next one */ }
}
export const firebaseConfig = config || { apiKey: "PASTE" };

// The name shown on the sign-in page, the header and the browser tab.
export const PORTAL_NAME = "Client Portal";
