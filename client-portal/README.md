# Client Portal

Client ↔ service-provider portal that runs on the same Firebase project as the REIT Rule Navigator, on its own address:
**https://snimmagadda-portal.web.app** (set by the deploy; override with the `PORTAL_SITE_ID` repository variable)

- Outlook-style conversations per client, with Word, Excel, PDF, image and text attachments
- Action items with status (Open, In progress, Follow up, Completed), who's working on it, and the action taken to close
- Client dashboard, per-client access, email + password sign-in with a forced password change on first sign-in
- Emails: invitations, new-message notifications to the chosen team, and a daily 8:00 (Central) reminder for items open more than a week
- Claude summaries of attachments and suggested action items

## How it fits with the REIT site

| | REIT Rule Navigator | Client Portal |
|---|---|---|
| Address | reit-navigator---snimmagadda.web.app | snimmagadda-portal.web.app |
| Data | admins, access, entities, accessRequests | portal_users, portal_clients only |
| Database rules | `firebase-site/firestore.rules` (one file for both; the portal's part is the block marked "Client Portal") | same file |
| Server functions | codebase `default` | codebase `portal` (functions named `portal…`) |
| Sign-in accounts | shared: one email + password works for both | |
| Email + AI keys | `SMTP_URL`, `ANTHROPIC_API_KEY` secrets | reuses the same secrets |

Anyone in the REIT `admins` list is a portal administrator. People you add to the portal can't see any REIT data
(and vice versa) unless you also give them access there.

## Publishing

Every change pushed to `main` under `client-portal/` is published by `.github/workflows/deploy-client-portal.yml`:
website, file-storage rules and server functions. Database rule changes (in `firebase-site/firestore.rules`) publish
with the REIT site's workflow.

## One-time setup

The workflow reuses the repository's `FIREBASE_SERVICE_ACCOUNT` and `FIREBASE_CONFIG_JS` secrets. Two extra steps:

1. **Turn on file storage** (for attachments): Firebase console → **Build → Storage → Get started** → production mode → **Done**.
   Skip if Storage is already on.
2. **Let the deploy account publish server functions.** Google Cloud console → **IAM & Admin → IAM** → find
   `github-deploy@…` → **Edit (pencil)** → **Add another role** for each of:
   - Cloud Functions Admin
   - Service Account User
   - Cloud Scheduler Admin
   - Secret Manager Viewer
   - Artifact Registry Administrator
   - Firebase Admin

   → **Save**.
3. **Run it:** GitHub → **Actions → Deploy Client Portal → Run workflow**. The summary shows the portal's address.

Then open the portal and sign in with your REIT administrator email and password.

Optional: set the name shown in the portal and its emails under **Settings → Secrets and variables → Actions → Variables →
New repository variable** `PORTAL_NAME` (default "Client Portal"), then run the workflow again.
