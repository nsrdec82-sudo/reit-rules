# REIT rule data and private site

- `rules.json`: the live REIT rule data. The daily rule review (7:43 AM Central) replaces it each morning; the websites read it from
  `https://raw.githubusercontent.com/snimmagadda-cpa/reit-navigator/main/rules.json`.
- `firebase-site/`: the private REIT Rule Navigator website. Every change pushed to `main` under `firebase-site/` is published to
  Firebase Hosting (and the Firestore access rules) by `.github/workflows/deploy-firebase.yml`.
- `client-portal/`: the Client Portal (client ↔ service-provider conversations, attachments and action items), on its own
  Firebase Hosting site in the same project. Changes pushed to `main` under `client-portal/` publish automatically through
  `.github/workflows/deploy-client-portal.yml`; see `client-portal/README.md`.

## One-time setup for automatic publishing

Add two repository secrets: **Settings > Secrets and variables > Actions > New repository secret**.

1. `FIREBASE_CONFIG_JS`: open the `public/config.js` your site uses now, copy everything in it, and paste it as the value.
   It holds your Firebase web settings and firm name; the workflow writes it into the site on each publish, so the copy in this
   repository can stay as the blank template.
2. `FIREBASE_SERVICE_ACCOUNT`: in the Google Cloud console for your Firebase project, open **IAM & Admin > Service accounts**,
   create a service account named `github-deploy`, give it the roles **Firebase Hosting Admin** and **Firebase Rules Admin**
   and **Service Usage Consumer**, then open it, choose **Keys > Add key > Create new key > JSON**, and paste the whole
   downloaded file as the value. Delete the downloaded file afterwards.

Then open **Actions > Deploy private site to Firebase > Run workflow** once to check it. After that, publishing is automatic.

The email functions (`firebase-site/functions`) are not published automatically, because their settings live in your Firebase
project. If they ever change, run `npx firebase deploy --only functions` from the `firebase-site` folder.
