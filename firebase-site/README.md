# REIT Rule Navigator: private website (Firebase)

A private, sign-in-only version of the REIT Rule Navigator.

- Users sign in with an email and password.
- Each user sees only the entities an administrator has given them.
- Each entity keeps its data by tax year and quarter, and saved reports (PDF plus a snapshot of the figures) are grouped by quarter.
- When someone signs in without access, administrators are told (in the Admin tab and by email), and the person gets an email with a sign-in link once access is given.

## What's in this folder

| File | What it does |
|---|---|
| `public/index.html` | The website |
| `public/config.js` | Your Firebase settings (you fill this in) |
| `public/rules.json` | Shared REIT rule data: federal thresholds, REIT-type rules, states, regimes, developments |
| `public/vendor/` | Firebase, PDF and Excel libraries, served from your own site |
| `firestore.rules` | The access rules the database enforces |
| `firebase.json` | Hosting and database settings |
| `functions/` | Sends the access-request and invite emails (optional; see "Email notifications") |
| `tests/rules.test.mjs` | Automated checks of the access rules |

## How access works

There are two kinds of user access, set per entity in the Admin tab: client and employee.

- **Administrators** (listed in the `admins` collection) create entities, give users access, and can see and change everything.
- **Clients** see only four tabs: Client dashboard, REIT structure evaluation, Trial balance and Questionnaire. They can update the dashboard, answer the structure questions, import their structure chart, import and map trial balances, and answer the questionnaire. They can't see the entity tax considerations, the proposed structure, the federal checker, prohibited transactions, filings, reports or rule pages, can't change the checker figures, can't start a new quarter and can't open saved reports. The database enforces this, not just the page.
- **Employees, full access** can change an entity's profile and figures, import trial balances, start new quarters, and save reports.
- **Employees, view only** can read everything for an entity and download its saved reports, but can't change anything.
- The database itself refuses anything the rules don't allow. A user who edits the page still can't read another entity.
- Every account must verify its email address before it can see any data. This stops someone from registering with a client's email before the client does.
- Anyone can create an account, but an account with no access sees nothing except a form to ask for access. A request can only be made in the person's own verified email. To stop sign-ups completely, see step 7.
- Saved reports can't be edited after they're saved. Only administrators can delete them.

## Setup (about 20 minutes)

You need a Google account and Node.js 18 or later on your computer.

1. **Create the project.** Go to the Firebase console (console.firebase.google.com), then Add project. Name it, for example `yourfirm-reit`. Analytics is optional. The free Spark plan is enough to start.
2. **Turn on sign-in.** In the console, open Build > Authentication > Get started > Sign-in method, and enable Email/Password.
3. **Create the database.** Open Build > Firestore Database > Create database. Choose a region near you and start in production mode.
4. **Register the website.** Open Project settings > General > Your apps, add a Web app, and copy its config values (apiKey, authDomain, projectId, appId) into `public/config.js`. Set `FIRM_NAME` to the name to show on the sign-in screen. These values identify your project; they aren't secret. The access rules protect the data.
5. **Deploy.** In this folder, run:
   ```
   npm install
   npx firebase login
   npx firebase use --add        (pick your project)
   npx firebase deploy --only hosting,firestore
   ```
   The deploy prints your site address, such as `https://yourfirm-reit.web.app`. You can connect your own domain later under Hosting > Add custom domain.
6. **Make yourself the first administrator.**
   - On the site, click **Create account** with your email, then verify it from the email you receive.
   - In the console, open Firestore Database, click Start collection, name it `admins`, and use your email address in lowercase as the document ID. Add any field, for example `addedBy` with the value `setup`.
   - Back on the site, sign in. You'll see the Admin tab.
7. **Optional: block self sign-up.** Open Authentication > Settings > User actions and turn off "Enable create (sign-up)". Then create each user yourself under Authentication > Users > Add user, and ask them to use **Forgot password** to set their own password.

## Email notifications

Two emails go out automatically once this is set up:

| When | Who gets it | What it says |
|---|---|---|
| Someone signs in (or sends a request) but has no access | Every administrator | Who is asking, the company or entity they need, their note, and a button to the Admin tab |
| An administrator gives someone access (or changes their role, or clicks **Resend invite**) | That person | The entity and role, and a button that opens the site with their email filled in: **Create your account** if they're new, **Sign in** if they already have an account |

Even without email set up, requests still appear at the top of the Admin tab, with a red count on the tab.

Sending email needs Cloud Functions, which needs the pay-as-you-go **Blaze** plan. Light use like this normally stays inside the free allowance, but Google asks for a billing account. You also need a mail account to send from.

1. **Upgrade the project.** In the Firebase console, click Upgrade and choose Blaze. Set a budget alert (for example $5) under Google Cloud Billing > Budgets.
2. **Choose a mail account to send from.**
   - **Google Workspace or Gmail:** turn on 2-Step Verification for the account, then create an app password at myaccount.google.com/apppasswords. Your mail server address is `smtps://reit%40yourfirm.com:APP_PASSWORD@smtp.gmail.com:465` (write `@` in the user name as `%40`).
   - **Microsoft 365:** `smtp://reit%40yourfirm.com:PASSWORD@smtp.office365.com:587`. SMTP sign-in must be allowed for that mailbox.
   - **SendGrid, Mailgun, Postmark and similar:** use the SMTP address and key they give you, for example `smtps://apikey:YOUR_KEY@smtp.sendgrid.net:465`.
3. **Store the mail server address as a secret.** In this folder, run:
   ```
   npx firebase functions:secrets:set SMTP_URL
   ```
   and paste the address from step 2. It's stored in Google Secret Manager, not in these files.
4. **Install and deploy the functions.**
   ```
   cd functions
   npm install
   cd ..
   npx firebase deploy --only functions,firestore
   ```
   The first deploy asks for three settings and saves them in `functions/.env.<your-project-id>`:
   - `SITE_URL`: your site address, for example `https://yourfirm-reit.web.app`
   - `MAIL_FROM`: the From line, for example `Your Firm REIT Navigator <reit@yourfirm.com>`. With Gmail or Microsoft 365, this must be the account from step 2 or one of its aliases.
   - `FIRM_NAME`: shown in the emails
5. **Test it.** Sign in with an email that has no access. You should get the request email as an administrator within a minute. Give that email access, and it should get the invite.

If an invite can't be sent, the Admin tab shows "Invite email failed" with the reason next to the person, and **Resend invite** tries again. The full log is under Firebase console > Functions > Logs.

To keep the administrators' inboxes quiet, a person who changes their request more than once in 30 minutes triggers only one email. A request sent again after being declined always triggers one.

## Day-to-day use

- **Add a client entity:** open Admin, then Create entity.
- **Answer an access request:** requests appear at the top of Admin, with a red count on the tab. Pick the entity and role and click Give access, or click Decline. The person gets an invite email with a sign-in link; a declined person sees that on their next sign-in and can ask again.
- **Give someone access:** under the entity in Admin, enter their email, choose Client, Employee: view only or Employee: full access, and click Give access. They get an email with a sign-in link. Next to each person, Admin shows when the invite was emailed, and **Resend invite** sends it again. Without email set up, tell them to open the site and click Create account with that email (or send them their login if you blocked sign-up).
- **Remove access:** in Admin, click Remove access next to their email. It takes effect immediately.
- **Start a new quarter:** choose the tax year and quarter at the top of the page. A quarter that hasn't been started yet starts from the latest earlier quarter: the profile, structure, account mappings and trial balance come across, and every questionnaire answer is carried forward marked "To confirm". The carried answers apply to the new quarter straight away. The client (or you) confirms each one, or changes it, on the Questionnaire tab, where the previous quarter's response is shown next to each question. Clients can't start a quarter; they see a note until you open it.
- **Quarterly testing:** the asset tests are as of the quarter end shown in the menu. The income and distribution tests are annual, so enter year-to-date figures (or import the year-to-date trial balance) each quarter.
- **Earlier whole-year records:** a year saved before quarterly testing appears in the quarter menu as "Full year". The first quarter you start after it carries its answers forward.
- **Save a report:** on the Report tab, choose the schedules, give it a title, and click Save report to this year. Saved reports are listed by tax year and quarter, with Download PDF and View snapshot.

## Working with a client

1. An employee imports the year's trial balances on the Trial balance tab: one or several (for example one per property, entity or sector), each with its property sector and the REIT's share for properties held through a partnership. With more than one sector the REIT is tested as diversified, and each sector's line items and rules apply.
2. The Questionnaire tab builds questions from it, account by account (for example how parking is run, whether a property sale was dealer property, how loans are secured, whether hedges were identified in time), plus general questions from the profile. Each answer choice shows how it counts under the REIT rules and the authority.
3. Give the client Client access. They answer the questionnaire, update the dashboard and the REIT structure evaluation tab, import their trial balances, and can import their current structure chart (entity list) for the compliance review.
4. Their answers save to the entity's year. Fact-check answers flow into the federal checker, and "What is this account?" answers set the account's mapping on the Trial balance tab. Unanswered questions and answers that need action stay on the Open points list.
5. The report can include the questionnaire and the structure compliance review as schedules.

## Keeping the rule data current

The rule data is in `public/rules.json`. To update it, replace the file and run `npx firebase deploy --only hosting`. Claude can produce an updated `rules.json` from the daily rule review on request.

Automatic daily updates: the page can read a live copy of the rule data from a public address. Put that address in `window.RULES_URL` in `public/config.js`. The page uses whichever copy, live or local, was checked most recently, so the local `rules.json` stays as a backup.

To set up the live copy: create a public GitHub repository (for example `reit-rules`), connect GitHub to Claude, and ask Claude to publish the daily rule review there. The address to use is then `https://raw.githubusercontent.com/YOUR-USER/reit-rules/main/rules.json`.

## Checking the access rules

With Java installed, run `npm run test:rules`. It starts a local copy of the database and checks 57 access scenarios, including:
- users can't read other entities;
- viewers can't make changes;
- saved reports can't be edited;
- only admins can grant access;
- people can ask for access only in their own name, and can't approve themselves;
- clients can change only the year's profile and answers, never figures, trial balances or reports.

## Costs

The free Spark plan covers small teams: 50,000 document reads and 20,000 writes a day, and 1 GB of stored data. Saved PDFs are stored in the database in pieces, so you don't need Cloud Storage or a paid plan. Check current limits on the Firebase pricing page.

The tool is a screening aid, not legal or tax advice.

## REIT assistant (chat box)

The **Ask the REIT assistant** button opens a chat box on every page. On this site it answers with Claude, searching only official, secure (https) sources: the IRS, the U.S. Code and Treasury regulations (Cornell LII, eCFR, GovInfo), the Federal Register, the SEC, state revenue departments, and a few authoritative international and industry sites. It also uses the rule library's excerpts and the open client's results, and it lists the source links under each answer. Only signed-in members can use it, with a limit of 60 questions per person per day.

One-time setup:

1. Create an API key at https://console.anthropic.com (usage is billed to that account).
2. In this folder, run `npx firebase functions:secrets:set ANTHROPIC_API_KEY` and paste the key.
3. Run `npx firebase deploy --only functions`.

Until this is done, the chat box still works: it answers from the rule library and its official links, and says the online search isn't set up. The list of allowed sites is `OFFICIAL_DOMAINS` in `functions/assistant.js`.
