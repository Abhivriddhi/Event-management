# Event Management System

A modular event-management platform for managing participants, event configuration, ticket generation, personalized Google Slides templates, QR-based tickets, email delivery, attendance/scanning, certificates, and participant/ticket tracking.

The system is built as a **Next.js 15 App Router application** with MongoDB as the operational database and Google services for document/template processing.

---

# 1. Features

## Event Management

- Create and manage multiple events
- Event-specific participant sources
- MongoDB participant source
- Excel participant import
- Google Sheets participant source
- Dynamic participant field mapping
- Custom participant fields
- Event-specific ticket configuration
- Event-specific certificate configuration
- Event-specific email configuration
- Event-specific scanner provisioning

## Participant & Ticket Tracking

The Events dashboard provides visibility into:

- Total participants
- Tickets generated
- Tickets sent
- Red tickets
- Blue tickets
- Scanned tickets
- Unscanned tickets
- Failed ticket operations
- Individual participant information
- Ticket ID
- Ticket color
- Ticket delivery status
- Scan/check-in status

The participant table supports:

- Search
- Filtering
- Pagination
- Participant details
- Ticket resend
- Participant deletion
- CSV export

## Ticket Generation

Tickets use the existing ticket architecture:

```text
Ticket ID = <12 hex characters><color bit>
```

The 12-character ticket core is generated from an HMAC-SHA256 operation using the configured ticket secret and the participant PRN.

The final bit represents the ticket color:

```text
0 = RED
1 = BLUE
```

The color is assigned using event-wide generation order rather than being derived from the hash.

The QR code contains only the final ticket ID.

## Google Slides Personalization

Tickets use Google Slides templates.

Supported placeholders include participant information and ticket data.

The ticket pipeline is:

```text
Participant
    ↓
Ticket ID Generation
    ↓
Ticket Color Assignment
    ↓
Google Slides Template
    ↓
Placeholder Replacement
    ↓
QR Code Insertion
    ↓
PDF Generation
    ↓
Email Attachment
    ↓
Participant
```

Certificate generation uses the same general personalization architecture but does not use the ticket QR/ticket ID.

## Email

The application supports:

- Personalized email
- Ticket email
- Certificate email
- Persistent email jobs
- Job progress
- Retry handling
- Failure tracking
- Rate limiting
- Daily usage tracking
- Email cleanup/recovery

Gmail SMTP can be used through a Gmail App Password.

Other SMTP providers can also be configured if supported by the existing Nodemailer configuration.

## Offline Scanner

The scanner is available at:

```text
/scanner
```

The scanner is designed to be offline-first.

Each scanner is provisioned as either:

```text
RED
```

or

```text
BLUE
```

The scanner downloads its own color's valid ticket list into IndexedDB.

Normal same-color scans do not require a network connection.

Cross-color tickets use the server verification path when network access is available.

If a cross-color ticket is encountered without network access, the scanner should send the participant to the help desk rather than silently accepting or rejecting the ticket.

---

# 2. Technology Stack

| Component | Technology |
|---|---|
| Frontend | Next.js 15 |
| Framework | React / Next.js App Router |
| Language | JavaScript |
| Database | MongoDB / Mongoose |
| Authentication | JWT + HTTP-only refresh cookies |
| Email | Nodemailer / SMTP |
| Templates | Google Slides |
| PDF generation | Google Apps Script |
| QR | QR generation + scanner |
| Scanner storage | IndexedDB |
| Styling | Tailwind / existing UI components |
| Deployment | Node.js-compatible hosting |
| Source control | Git / GitHub |

Next.js can be deployed using a Node.js server, Docker, or a compatible deployment platform.

---

# 3. Project Structure

The actual application is inside the `admin` directory.

```text
Abhivruddhi/
│
├── admin/
│   │
│   ├── app/
│   │   ├── api/
│   │   │   ├── events/
│   │   │   ├── jobs/
│   │   │   ├── scanner/
│   │   │   └── send-tickets/
│   │   │
│   │   ├── events/
│   │   ├── scanner/
│   │   └── ...
│   │
│   ├── components/
│   │
│   ├── lib/
│   │   ├── models/
│   │   └── services/
│   │
│   ├── public/
│   ├── package.json
│   ├── next.config.mjs
│   ├── .env.example
│   └── README.md
│
└── ...
```

Important services include:

```text
lib/services/
├── emailService
├── googleApi
├── jobService
├── participantSourceService
├── scannerService
├── slidesTemplateService
├── templateEngine
├── ticketService
└── appsScriptService
```

---

# 4. Requirements

Install:

- Node.js
- npm
- Git
- MongoDB Atlas account or MongoDB server
- Google account
- Google Cloud project
- Google Apps Script project
- Gmail/SMTP account

Recommended:

```text
Node.js 20+
npm
Git
```

---

# 5. Clone the Repository

```bash
git clone <YOUR_GITHUB_REPOSITORY>
cd Abhivruddhi/admin
```

Check the branch:

```bash
git branch
```

The current event-management implementation is on:

```text
feat/modular-event-system-sheets-integration-ticket-system
```

If required:

```bash
git switch feat/modular-event-system-sheets-integration-ticket-system
```

---

# 6. Install Dependencies

From the `admin` directory:

```bash
npm install
```

Run development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

---

# 7. Environment Configuration

DO NOT commit real environment variables.

Next.js automatically loads `.env*` files, and secrets should not be committed to Git.

Create:

```text
admin/.env.local
```

Use:

```env
# ==========================================
# DATABASE
# ==========================================

MONGODB_URI="mongodb+srv://<DB_USER>:<DB_PASSWORD>@<CLUSTER>/<DATABASE>?retryWrites=true&w=majority"


# ==========================================
# AUTHENTICATION
# ==========================================

JWT_SECRET="<LONG_RANDOM_SECRET>"
JWT_REFRESH_SECRET="<LONG_RANDOM_SECRET>"


# ==========================================
# TICKET GENERATION
# ==========================================

TICKET_SAUCE="<LONG_RANDOM_SECRET>"


# ==========================================
# EMAIL
# ==========================================

EMAIL="<EMAIL_ACCOUNT>"
EMAIL_PASSWORD="<EMAIL_APP_PASSWORD>"

# Optional explicit SMTP configuration
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="587"
SMTP_SECURE="false"

# Optional.
# If omitted, the application uses EMAIL.
# SMTP_USER="<EMAIL_ACCOUNT>"


# ==========================================
# GOOGLE SERVICE ACCOUNT
# ==========================================

GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'


# ==========================================
# GOOGLE APPS SCRIPT
# ==========================================

GOOGLE_APPS_SCRIPT_URL="<DEPLOYED_APPS_SCRIPT_URL>"
GOOGLE_APPS_SCRIPT_SECRET="<APPS_SCRIPT_SECRET>"
```

### Important

Never put the following into Git:

```text
.env
.env.local
service-account.json
private keys
Gmail App Passwords
MongoDB passwords
JWT secrets
TICKET_SAUCE
Apps Script API secrets
```

Google specifically recommends storing service-account keys securely because the private key can authenticate against resources accessible to that service account.

---

# 8. NEW ACCOUNT SETUP

This section is the most important part of this README.

If the project is transferred to another person, organization, Google account, Gmail account, or MongoDB account, follow the steps below in order.

---

# 9. Create a New MongoDB Database

MongoDB Atlas can be used for the production database.

## Step 1 — Create Atlas Account

Create/sign into the MongoDB Atlas account belonging to the new project owner.

## Step 2 — Create Cluster

Create a new cluster.

Example:

```text
Cluster:
abhivriddhi-production
```

## Step 3 — Create Database User

Create a dedicated database user.

Example:

```text
Username:
abhivriddhi_app

Password:
<GENERATED_STRONG_PASSWORD>
```

Do not use the personal MongoDB account password.

## Step 4 — Network Access

Allow the production application's network access.

For a cloud deployment, configure MongoDB Atlas IP/network access according to the deployment provider.

MongoDB Atlas provides the connection string and network/IP configuration through its connection setup flow.

## Step 5 — Get Connection String

Example:

```text
mongodb+srv://abhivriddhi_app:<PASSWORD>@cluster.mongodb.net/abhivriddhi
```

Put it into:

```env
MONGODB_URI="..."
```

---

# 10. Database Migration

The application uses MongoDB collections/models for:

- Events
- Participants
- Tickets
- Operation jobs
- Scanner devices
- Email rate limits
- Email usage
- Users
- Attendance
- Authentication-related records

If this is a completely new production database, the collections will be created as the application uses the models.

## Existing Production Data

If an existing database already contains event/participant/ticket data:

DO NOT simply point the new deployment to a new empty database.

Choose one:

### Option A — Continue using existing database

Use the existing MongoDB connection string.

### Option B — Migrate database

Export the old database and restore it into the new MongoDB project.

Example:

```bash
mongodump --uri="<OLD_MONGODB_URI>" --out=backup
```

Restore:

```bash
mongorestore --uri="<NEW_MONGODB_URI>" backup/
```

Test the application thoroughly after migration.

---

# 11. Create a New Google Cloud Project

A new account should create its own Google Cloud project.

Example:

```text
Project name:
Abhivriddhi Event Management Production
```

Google APIs must be enabled inside the Google Cloud project before the application can use them. Google documents this flow for the Slides API.

---

# 12. Enable Google APIs

Open Google Cloud Console and select the new project.

Enable the APIs required by the application.

At minimum, configure:

```text
Google Slides API
```

If the implementation uses additional Google APIs in the deployed configuration, enable those as well.

---

# 13. Create Google Service Account

Create a dedicated service account.

Example:

```text
abhivriddhi-event-service
```

Google service accounts are created inside a selected Google Cloud project.

Example resulting address:

```text
abhivriddhi-event-service@PROJECT_ID.iam.gserviceaccount.com
```

---

# 14. Generate Service Account Credentials

Create a service-account key according to the Google Cloud configuration.

Download the JSON credentials.

Example:

```text
service-account.json
```

NEVER commit this file to GitHub.

Instead, use its contents as:

```env
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

For production hosting, store the value in the hosting provider's secret/environment-variable system rather than uploading the JSON file to the public repository.

---

# 15. Give the Service Account Access to Google Files

This step is extremely important.

Creating the service account is NOT enough.

The service account must have access to the Google resources that the application needs.

For every Google Slides ticket template:

```text
Google Slides
    ↓
Share
    ↓
Add service-account email
    ↓
Give required editing permission
```

Example:

```text
abhivriddhi-event-service@PROJECT_ID.iam.gserviceaccount.com
```

Give the service account the required access to the ticket templates.

Repeat for:

```text
RED ticket template
BLUE ticket template
Certificate template
```

when those templates are used.

---

# 16. Google Slides Templates

The application expects Google Slides templates rather than locally uploaded ticket images.

Typical configuration:

```text
RED Ticket Template
BLUE Ticket Template
Certificate Template
```

Templates contain placeholders used by the personalization system.

Examples:

```text
{{participant.name}}
{{participant.email}}
{{participant.prn}}
{{ticket.id}}
{{ticket.qr}}
```

The exact placeholders should match the mappings configured by the application.

---

# 17. QR Placeholder

The QR placeholder is not simply ordinary visible text.

The ticket template contains a designated placeholder object that the Apps Script generation pipeline identifies.

Keep exactly one QR placeholder in the ticket template.

Do not create multiple QR placeholders unless the application is explicitly changed to support them.

---

# 18. Google Apps Script

The project uses Google Apps Script as part of the PDF-generation pipeline.

The Apps Script:

1. Receives a generation request.
2. Validates the configured secret.
3. Copies the Google Slides template.
4. Replaces personalization placeholders.
5. Finds the QR placeholder.
6. Inserts the generated QR image.
7. Exports the personalized presentation as PDF.
8. Returns the generated PDF.
9. Removes the temporary copy.

---

# 19. Create Apps Script Under the NEW Google Account

Sign into Google using the new project's Google account.

Create a new Apps Script project.

Example:

```text
Abhivriddhi Ticket PDF Generator
```

Copy the project's existing Apps Script source into the new project.

DO NOT reuse the old account's deployment URL blindly.

---

# 20. Configure Apps Script Secret

Create a new secret.

Example:

```text
<NEW_RANDOM_APPS_SCRIPT_SECRET>
```

Configure the script to expect that secret.

Then configure the Next.js application:

```env
GOOGLE_APPS_SCRIPT_SECRET="<NEW_RANDOM_APPS_SCRIPT_SECRET>"
```

The two values must match.

---

# 21. Deploy Apps Script as Web App

In Apps Script:

```text
Deploy
    ↓
New deployment
    ↓
Web app
```

Configure the deployment according to the application's intended access model.

The existing application expects a web-app endpoint that accepts POST requests.

Google's current Apps Script documentation confirms that web apps are deployed through:

```text
Deploy → New deployment → Web app
```

and that a web app can execute as the deploying user.

The resulting URL should look similar to:

```text
https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec
```

Put it into:

```env
GOOGLE_APPS_SCRIPT_URL="https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec"
```

---

# 22. Important Apps Script Account Rule

The Apps Script deployment is tied to the Google account/domain configuration.

If ownership/domain changes, the web app may need to be redeployed. Google explicitly notes that web apps can stop functioning after certain ownership/domain changes and may require redeployment.

Therefore, when transferring the project:

```text
OLD GOOGLE ACCOUNT
        ↓
Create/copy Apps Script
        ↓
NEW GOOGLE ACCOUNT
        ↓
Configure secret
        ↓
Authorize required services
        ↓
Deploy new Web App
        ↓
Update GOOGLE_APPS_SCRIPT_URL
```

Do not assume the old Apps Script deployment should remain the production endpoint.

---

# 23. Gmail / Email Setup

For Gmail, use a dedicated account for the event system.

Example:

```text
events@example.com
```

Do not use a personal Gmail account if the system will be operated by an organization.

---

# 24. Gmail App Password

The application should use a Gmail App Password rather than storing the normal Google account password.

The value goes into:

```env
EMAIL_PASSWORD="<GMAIL_APP_PASSWORD>"
```

And:

```env
EMAIL="events@example.com"
```

The application can use:

```env
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="587"
SMTP_SECURE="false"
```

If `SMTP_USER` is not required, leave it unset.

The application is configured to fall back to `EMAIL` as the SMTP username.

### Important

Do NOT write:

```env
EMAIL_PASSWORD="your_google_password"
```

Use the generated App Password.

---

# 25. SMTP Alternative

If Gmail is not used, configure another SMTP provider.

Example:

```env
EMAIL="sender@example.com"
EMAIL_PASSWORD="<SMTP_PASSWORD>"

SMTP_HOST="<SMTP_HOST>"
SMTP_PORT="<SMTP_PORT>"
SMTP_SECURE="false"
SMTP_USER="sender@example.com"
```

The exact values depend on the provider.

---

# 26. Authentication Secrets

Generate completely new secrets for a new production deployment.

Example:

```env
JWT_SECRET="<RANDOM_SECRET>"
JWT_REFRESH_SECRET="<RANDOM_SECRET>"
```

Do not reuse development secrets.

Generate long random values.

---

# 27. Ticket Secret

The ticket generation system depends on:

```env
TICKET_SAUCE="<RANDOM_SECRET>"
```

This is security-sensitive.

Changing the ticket secret after tickets have already been generated can make existing ticket IDs incompatible with the generation algorithm.

Therefore:

## Before first production event

Generate a strong permanent production secret.

## After tickets exist

DO NOT casually change:

```text
TICKET_SAUCE
```

If the secret must be rotated, treat it as a ticket-system migration and regenerate/reconcile tickets deliberately.

---

# 28. Complete Production Environment Example

Use placeholders only:

```env
# Database
MONGODB_URI="mongodb+srv://<USER>:<PASSWORD>@<CLUSTER>/<DATABASE>?retryWrites=true&w=majority"

# Authentication
JWT_SECRET="<LONG_RANDOM_SECRET>"
JWT_REFRESH_SECRET="<LONG_RANDOM_SECRET>"

# Tickets
TICKET_SAUCE="<LONG_RANDOM_SECRET>"

# Email
EMAIL="events@example.com"
EMAIL_PASSWORD="<GMAIL_APP_PASSWORD>"

# Gmail SMTP
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="587"
SMTP_SECURE="false"

# Google Service Account
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'

# Google Apps Script
GOOGLE_APPS_SCRIPT_URL="https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec"
GOOGLE_APPS_SCRIPT_SECRET="<LONG_RANDOM_SECRET>"
```

---

# 29. Deployment

The application can be deployed to a Node.js-compatible platform.

A common deployment option for Next.js is Vercel.

Next.js automatically detects Next.js applications on compatible deployment platforms, and Vercel supports GitHub-based deployment workflows.

---

# 30. Vercel Deployment

## Step 1

Create/sign into the hosting account belonging to the new project owner.

## Step 2

Connect GitHub.

## Step 3

Import the repository.

Repository:

```text
23divyajain12-afk/Event-management
```

or the new owner's fork/organization repository.

## Step 4 — Root Directory

IMPORTANT.

The actual Next.js project is:

```text
admin/
```

Set:

```text
Root Directory = admin
```

Do not deploy the parent `Abhivruddhi` directory as the Next.js root.

## Step 5

Vercel should detect:

```text
Framework:
Next.js
```

Build command:

```bash
npm run build
```

## Step 6

Add all production environment variables.

Do not upload `.env.local`.

Use the hosting provider's environment-variable settings.

Next.js environment variables are available to server-side code without `NEXT_PUBLIC_`; variables prefixed with `NEXT_PUBLIC_` are exposed to browser-side code, so secrets must NOT use that prefix.

## Step 7

Deploy.

---

# 31. Production Environment Variable Checklist

Before clicking Deploy:

```text
[ ] MONGODB_URI
[ ] JWT_SECRET
[ ] JWT_REFRESH_SECRET
[ ] TICKET_SAUCE
[ ] EMAIL
[ ] EMAIL_PASSWORD
[ ] SMTP_HOST
[ ] SMTP_PORT
[ ] SMTP_SECURE
[ ] GOOGLE_SERVICE_ACCOUNT_JSON
[ ] GOOGLE_APPS_SCRIPT_URL
[ ] GOOGLE_APPS_SCRIPT_SECRET
```

If the current codebase introduces additional environment variables later, add them here as well.

---

# 32. Role-Based Administrator Access

The admin portal supports three account roles:

| Role | Access |
|---|---|
| `super_admin` | Existing school administration, account management, role assignment, access-request review, and scanner administration |
| `admin` | Existing school administration and scanner administration; no account or role management |
| `qr_admin` | `/scanner` only; school-administration APIs reject this role |

Protected APIs check the current account role and active status in MongoDB on each request. Changing an account role or disabling it revokes its refresh tokens and prevents existing access tokens from authorizing protected APIs. Paired scanner devices continue to use their separate device tokens.

## Existing Database Migration

Back up the database before an operational migration. The migration does not create accounts or change passwords. It promotes the specified existing admin to `super_admin`, assigns unset/invalid roles on other existing admins to `admin`, sets unset active flags to active, and revokes refresh tokens for accounts whose access settings changed.

If and only if there is exactly one existing admin:

```powershell
cd admin
node scripts/migrate-admin-roles.mjs --sole-existing-admin
```

If there is more than one admin, specify the existing seeded admin's email (the script does not print it):

```powershell
node scripts/migrate-admin-roles.mjs <seeded-admin-email>
```

The migration aborts if the selected account does not exist or is inactive. Do not rerun the seed API for an existing account.

## Account Requests and Management

Applicants use `/request-access`; a submitted password is bcrypt-hashed while pending. Pending requests do not create accounts and cannot log in. A Super Admin reviews requests under **Account management**, chooses the role, and approves or rejects. Rejected requests can be submitted again; their prior password hash is discarded. A Super Admin can also create accounts directly, change roles, or disable accounts. At least one active Super Admin must remain.

Use a unique, strong password for each account and communicate credentials through a trusted channel. `JWT_SECRET` must be at least 32 bytes. No new persistent environment variable is required for role-based access.

### Role authorization integration test

With the application running locally against a non-production database, set `ROLE_AUTH_TEST_BASE_URL` to its loopback URL and `ROLE_AUTH_TEST_CONFIRM_DATABASE` to the exact database name, then run `npm run test:roles:integration` from `admin`. The test refuses non-local URLs and refuses to write unless the connected database name exactly matches the confirmation value. It creates uniquely named temporary accounts/requests and removes them after the run. Do not point this test at production.

---

# 33. Production Testing

After deployment, test in this order.

## 1. Application

```text
[ ] Website opens
[ ] Login works
[ ] Events page loads
```

## 2. Database

```text
[ ] Existing events appear
[ ] Participants appear
[ ] Event creation works
```

## 3. Google Slides

```text
[ ] Red template accessible
[ ] Blue template accessible
[ ] Placeholders replace correctly
```

## 4. PDF

```text
[ ] Ticket PDF generated
[ ] QR inserted
[ ] Correct ticket ID
[ ] Correct ticket color
```

## 5. Email

Send exactly one test ticket first.

```text
[ ] SMTP authentication works
[ ] Email received
[ ] PDF attached
[ ] Correct participant name
[ ] Correct ticket ID
[ ] QR works
```

Only after the single-recipient test succeeds should a large email job be started.

## 6. Scanner

```text
[ ] Scanner opens
[ ] RED pairing works
[ ] BLUE pairing works
[ ] Ticket list downloads
[ ] Same-color scan works
[ ] Duplicate scan is rejected
[ ] Cross-color behavior works
```

---

# 33. Scanner Production Setup

For every physical scanner:

```text
Events
  ↓
Select Event
  ↓
Scanner Provisioning
  ↓
Provision RED or BLUE
  ↓
Generate pairing code
  ↓
Open /scanner
  ↓
Enter pairing code
  ↓
Download ticket hashset
  ↓
Ready
```

Each device should be assigned deliberately.

Example:

```text
Phone 1 → RED
Phone 2 → RED
Phone 3 → BLUE
Phone 4 → BLUE
```

---

# 34. Important Scanner Rule

The scanner is intentionally offline-first.

Do not modify the scanner architecture to perform a network request for every ordinary scan unless the architecture is deliberately redesigned and tested.

Normal same-color scanning should continue to use:

```text
IndexedDB
    ↓
Downloaded valid-ticket set
    ↓
Local used-ticket set
```

The server remains the operational source of truth.

---

# 35. Event Setup

After production deployment:

```text
Events
    ↓
Create/select event
```

Configure:

```text
Event name
Event ID
Participant source
Field mappings
Ticket templates
Certificate template
Email settings
Scanner settings
```

---

# 36. Excel Participant Import

Excel imports should contain the fields required by the event mapping.

Example:

```text
PRN
Name
Email
```

Additional fields can be included.

Example:

```text
PRN
Name
Email
Phone
Department
Year
College
```

Map them in the event configuration.

---

# 37. Google Sheets Participant Source

If using Google Sheets:

1. Create the sheet using the new Google account.
2. Share it with the required service account if the current implementation requires service-account access.
3. Configure the sheet/source in the event.
4. Configure field mappings.
5. Test participant loading.

Participant deletion from a Google Sheets source should be treated carefully because the source sheet may remain the authoritative external source.

---

# 38. Event Deletion

Event deletion is destructive.

Before deleting:

```text
Check participants
Check tickets
Check email jobs
Check scanner devices
Check attendance
```

The application requires typed confirmation for event deletion.

Do not delete a production event just to "clean up" test data.

For test events, use a clearly identifiable name:

```text
TEST - Engineering Unplugged
```

---

# 39. Participant Deletion

Participant deletion should only be used when necessary.

Before deletion:

```text
Confirm participant
Confirm event
Check ticket
Check email history
Check attendance
```

If the participant originated from Google Sheets, remember that deleting the application's record does not necessarily remove the participant from the external Google Sheet.

---

# 40. Backups

Production data should be backed up.

At minimum:

```text
MongoDB backup
Google Slides templates
Apps Script source
Environment-variable record
Deployment configuration
```

Do NOT store secrets directly inside the GitHub repository.

A secure password manager or organization secret manager should hold:

```text
MongoDB credentials
Google service account credentials
Gmail App Password
JWT secrets
Ticket secret
Apps Script secret
```

---

# 41. Account Transfer Checklist

When transferring the project from Account A to Account B:

```text
DATABASE
[ ] Create new MongoDB account/project
[ ] Create database
[ ] Create application DB user
[ ] Configure network access
[ ] Migrate data if necessary
[ ] Obtain new MONGODB_URI

GOOGLE CLOUD
[ ] Create new Google Cloud project
[ ] Enable required APIs
[ ] Create service account
[ ] Create service-account credentials
[ ] Save credentials securely

GOOGLE DRIVE / SLIDES
[ ] Transfer/copy ticket templates
[ ] Transfer/copy certificate template
[ ] Share templates with new service account
[ ] Verify Editor/access permissions

APPS SCRIPT
[ ] Create/copy Apps Script
[ ] Configure new secret
[ ] Authorize Google services
[ ] Deploy new Web App
[ ] Obtain new /exec URL

EMAIL
[ ] Create/select production sender account
[ ] Enable required account security
[ ] Generate App Password
[ ] Configure EMAIL
[ ] Configure EMAIL_PASSWORD
[ ] Configure SMTP
[ ] Send one test email

APPLICATION
[ ] Clone repository
[ ] Set deployment root to admin/
[ ] Add environment variables
[ ] Deploy
[ ] Verify database
[ ] Verify Google PDF generation
[ ] Verify email
[ ] Verify scanner

PRODUCTION
[ ] Create production event
[ ] Import test participant
[ ] Generate one ticket
[ ] Send one test ticket
[ ] Scan test ticket
[ ] Verify duplicate handling
[ ] Remove test data
[ ] Begin real event setup
```

---

# 42. What Changes When the Account Changes?

The code normally does NOT need to change just because the owner changes.

Usually these change:

```text
MongoDB URI
        ↓
New database/account

Google service account
        ↓
New Google Cloud project

Google Slides permissions
        ↓
Share with new service account

Apps Script deployment
        ↓
New Web App URL

Apps Script secret
        ↓
New secret

Gmail account
        ↓
New EMAIL + App Password

Deployment account
        ↓
New Vercel/hosting account

Environment variables
        ↓
New production values
```

The application code can remain the same.

---

# 43. Development vs Production

Use separate credentials.

## Development

```text
Development MongoDB
Development Gmail
Development Google templates
Development Apps Script
Development secrets
```

## Production

```text
Production MongoDB
Production Gmail
Production Google templates
Production Apps Script
Production secrets
```

Do not accidentally connect a development environment to the production database.

---

# 44. Git Workflow

After the project is deployed:

```bash
git add .
git commit -m "your change"
git push
```

The deployment platform can then build the updated commit.

Before committing:

```bash
git status
```

Make sure you do NOT see:

```text
.env
.env.local
service-account.json
credentials.json
```

---

# 45. Security Rules

NEVER commit:

```text
Google service-account JSON
Private keys
Gmail App Password
MongoDB password
JWT secrets
TICKET_SAUCE
Apps Script secret
```

NEVER expose secrets using:

```text
NEXT_PUBLIC_*
```

NEVER paste production credentials into:

```text
GitHub issues
README
Discord
WhatsApp
public documentation
```

Use placeholders in documentation.

---

# 46. Troubleshooting

## MongoDB connection fails

Check:

```text
MONGODB_URI
```

Then check:

```text
MongoDB Atlas
→ Network Access
→ Database Access
```

Verify the application database user and password.

---

## Gmail authentication fails

Check:

```text
EMAIL
EMAIL_PASSWORD
SMTP_HOST
SMTP_PORT
SMTP_SECURE
```

For Gmail:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
```

Use an App Password rather than the normal Google account password.

Also check that a stale `SMTP_USER` value is not overriding the intended Gmail account.

---

## Google Slides permission error

Check that the service account email has access to the actual Google Slides template.

The service account must be able to access the template.

---

## Apps Script returns 401

Check:

```text
GOOGLE_APPS_SCRIPT_URL
GOOGLE_APPS_SCRIPT_SECRET
```

Make sure the URL is the deployed:

```text
/exec
```

web-app endpoint rather than an incorrect development/test endpoint.

---

## Ticket PDF fails

Check:

```text
Google Slides template
Apps Script deployment
Apps Script secret
Service account permissions
QR placeholder
Template placeholders
```

---

## Scanner cannot pair

Check:

```text
Event selected
Scanner device provisioned
Pairing code valid
Correct deployment URL
Network available during initial pairing
```

After successful setup, normal same-color scanning should be able to work offline.

---

# 47. Production Architecture

```text
                         ┌──────────────────────┐
                         │      Admin User      │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │     Next.js App      │
                         │      /admin          │
                         └───────┬───────┬──────┘
                                 │       │
                ┌────────────────┘       └─────────────────┐
                ▼                                          ▼
       ┌────────────────┐                         ┌──────────────────┐
       │    MongoDB     │                         │ Google Services  │
       │                │                         │                  │
       │ Events         │                         │ Slides           │
       │ Participants   │                         │ Drive            │
       │ Tickets        │                         │ Apps Script      │
       │ Jobs           │                         └────────┬─────────┘
       │ Scanner state  │                                  │
       └────────────────┘                                  ▼
                                                 ┌──────────────────┐
                                                 │ Personalized PDF │
                                                 └────────┬─────────┘
                                                          │
                                                          ▼
                                                 ┌──────────────────┐
                                                 │   SMTP / Gmail   │
                                                 └────────┬─────────┘
                                                          │
                                                          ▼
                                                     Participant


                         EVENT DAY
                             │
                             ▼
                    ┌──────────────────┐
                    │ Scanner Devices  │
                    └────────┬─────────┘
                             │
                       IndexedDB
                             │
                             ▼
                    Offline Ticket Check
                             │
                    ┌────────┴────────┐
                    │                 │
                 Same Color       Cross Color
                    │                 │
                Local check       Server verify
```

---

# 48. Recommended Ownership Model

For an organization or college deployment, use dedicated accounts.

Example:

```text
GitHub
    → Organization account

Hosting
    → Organization account

MongoDB
    → Organization account

Google Cloud
    → Organization account

Google Drive
    → Organization account

Apps Script
    → Organization account

Email
    → Official event-management account
```

Avoid making one student's personal account the permanent owner of every production service.

---

# 49. Final Production Checklist

Before the real event:

```text
DATABASE
[ ] Production MongoDB connected
[ ] Backup available
[ ] Correct database selected

GOOGLE
[ ] Correct Google Cloud project
[ ] APIs enabled
[ ] Service account working
[ ] Slides accessible
[ ] Templates tested

APPS SCRIPT
[ ] New deployment created
[ ] /exec URL configured
[ ] Secret configured
[ ] PDF generation tested

EMAIL
[ ] Correct sender account
[ ] App Password configured
[ ] SMTP authentication tested
[ ] One ticket received successfully

TICKETS
[ ] Ticket IDs generated
[ ] Red/Blue assignment correct
[ ] QR codes valid
[ ] Ticket PDF correct

SCANNER
[ ] RED device provisioned
[ ] BLUE device provisioned
[ ] Hashsets downloaded
[ ] Offline scan tested
[ ] Duplicate scan tested
[ ] Cross-color behavior tested

EVENT
[ ] Participants imported
[ ] Field mappings checked
[ ] Ticket templates checked
[ ] Email settings checked
[ ] Tracking dashboard verified

DEPLOYMENT
[ ] Production URL works
[ ] Environment variables configured
[ ] No secrets in Git
[ ] Build successful
[ ] Production smoke test completed
```

---

# 50. Important Principle

The **codebase is portable**.

The account-specific configuration is not.

Think of the project as:

```text
                CODE
                 │
                 ▼
        ┌─────────────────┐
        │ Portable GitHub │
        │    Repository   │
        └────────┬────────┘
                 │
       ┌─────────┼──────────┐
       ▼         ▼          ▼
    MongoDB    Google      Email
       │       Services      │
       │         │           │
       └─────────┼───────────┘
                 ▼
          Environment
          Variables
```

When changing owners/accounts, normally the goal is:

```text
KEEP THE CODE
RECREATE THE SERVICES
UPDATE THE SECRETS
RECONNECT THE RESOURCES
TEST EVERYTHING
```

Do not rewrite the application simply because the Google, MongoDB, email, or deployment account changed.