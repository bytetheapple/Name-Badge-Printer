# The public pages

Three pages at `guestbadges.com`, added because Google's OAuth review asks for a
home page, a privacy policy, and terms of service before an app can be published
to Production — and because a domain should say something to anyone who types
it in.

| Path | What |
|---|---|
| `/` | Landing page |
| `/privacy` | Privacy Policy |
| `/terms` | Terms of Service |

Give Google those three URLs.

## `/` still serves the kiosk

The sign-in form owned `/` outright, because the original QR codes are
`/?printer=<uuid>` and some are hanging in lobbies now. That is unchanged: `/`
serves the form whenever a printer is named in the query string, and the landing
page otherwise. `/k/<token>` is untouched.

## Before you hand the URLs to Google

**Fill in the bracketed items in `Terms.tsx`.** Only you can answer them:

* `[LEGAL ENTITY NAME]` — who the agreement is with. A person's name is a valid
  answer if there is no company yet, but it is the name that would be on the
  hook.
* `[STATE / JURISDICTION]` — governing law.
* `[CONFIRM: billing terms…]` — the fees paragraph is a placeholder. If there is
  no paid tier yet, say that rather than leaving it vague.

**Make `support@guestbadges.com` work.** Both pages advertise it and Google may
use it. It is the address on the consent screen too.

**Have both pages reviewed by a lawyer.** They were written to describe what the
code actually does — every category of data named is one the application really
collects, and every destination one it really sends to — which is the part that
usually goes wrong in a template. That is not the same as being legally
sufficient for your jurisdiction, and I am not qualified to say that they are.

## Why the privacy policy is worded as it is

Google's reviewers compare this page against the scopes requested. Two passages
are there for that reason and should not be trimmed:

* The **`drive.file`** paragraph, which states that the application can see only
  files it created. That is a factual claim about the scope and it is true.
* The **Limited Use** paragraph, naming the Google API Services User Data Policy.
  Google looks for this.

If the scopes ever change — a broader Drive permission, Sheets, Calendar — this
page has to change with them, in the same commit. A privacy policy that
describes fewer permissions than the app requests is what gets an OAuth
application rejected or suspended.

## The data the policy describes

Kept here so a future change can be checked against it: first and last name,
additional people signing in together, pronouns, email, phone, visitor or member,
an optional photograph, and the timestamp. Administrators: email and password.
Destinations, all per-organization and all optional: a Google Form, a ShulCloud
welcome form, a Google Drive folder, and the badge printer on the premises.
