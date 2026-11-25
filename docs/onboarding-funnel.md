# Onboarding funnel

fabdesk records first-of-step onboarding events locally and optionally captures them to PostHog
so a landing-page visitor, an account, and an install become one person. There is no PostHog SDK
in the desktop, renderer, or core: `fabdesk-core` POSTs to `{POSTHOG_HOST}/capture/`. Capture is a
complete no-op when `POSTHOG_KEY` is unset.

This is not crash reporting ([sentry.md](sentry.md)) and not the first-party product events gated
by usage-archive consent ([telemetry.md](telemetry.md)). Users can turn the funnel off in
Settings → Privacy (`productAnalytics`, default on). That flag is local to the device and is not
part of Cloud Settings.

Events never include prompts, board files, tokens, emails, project names or paths.

## Website contract (fabplane.com)

The public site owns posthog-js on `/try`. Pass the anonymous distinct_id plus first-touch fields
into login and download:

| Query key | Meaning |
| --- | --- |
| `ph_id` | Landing-page PostHog distinct_id |
| `utm_source` `utm_medium` `utm_campaign` `utm_content` `utm_term` | First-touch campaign |
| `gclid` | Ads click id |
| `referrer` (aliases `fp_referrer`, `ref`) | `document.referrer`; credentials and query are stripped |

Put those on:

1. OAuth `return_to` so `/login?return_to=/device?ph_id=…&utm_source=…` survives signup.
2. `/download?ph_id=…` (and `fabplane://open?ph_id=…` Open-app links) so the first desktop launch
   can adopt the same person before sign-in.

Recommended website events (same PostHog project as `POSTHOG_KEY`):

- `landing_view` on `/try`
- `onboarding_account_created` plus `posthog.identify(subject)` on signup, using the same
  principal **subject** the desktop uses after device-flow sign-in. Do not identify by email.

fabdesk then:

1. Reads `ph_id` / UTMs / `gclid` / referrer from argv, `fabplane://` / https download URLs,
   `FABDESK_PH_ID` / `FABDESK_UTM_*` / `FABDESK_GCLID` / `FABDESK_REFERRER`, or
   `POST /funnel/handoff`.
2. Adopts `ph_id` as this install’s anonymous distinct_id (`$create_alias` if we already minted
   `anon_…`).
3. On sign-in, `$identify` with `distinct_id = principal.subject`, `$anon_distinct_id = ph_id`
   (else the install anon id), and `$set_once` of the UTMs, `gclid` and referrer as **person
   properties**.
4. Appends `ph_id` + UTMs onto the device-login URL so `/device` can copy them into `return_to`
   if the site did not already.

## Funnel steps

1. `landing_view` (website `/try`; app fallback `onboarding_landing`)
2. `onboarding_account_created` (website)
3. `onboarding_app_launched`
4. `onboarding_signed_in`
5. `onboarding_first_project` (create, promote a draft, remix, GitHub import, adopt a KiCad board,
   or `project_import_kicad`)
6. `onboarding_first_ai_run`
7. `onboarding_first_review_viewed`

Extra activation: `onboarding_sign_in_started`, `onboarding_first_kicad_import`,
`onboarding_first_board_built`, `onboarding_first_route`, `onboarding_first_board_viewed`. Each
`(distinct_id, event)` pair is stored once.

## Env vars

| Variable | Role |
| --- | --- |
| `POSTHOG_KEY` | Project API key. Capture is off when unset or blank |
| `POSTHOG_HOST` | Ingest host. Default `https://us.i.posthog.com` |
| `POSTHOG_PROJECT_API_KEY` / `FABDESK_POSTHOG_KEY` / `FABDESK_POSTHOG_HOST` | Aliases; the `FABDESK_*` names are also compile-time defines |
| `FABDESK_PH_ID` | Website `ph_id` when launched from a download / open-app link |
| `FABDESK_UTM_*` / `FABDESK_GCLID` / `FABDESK_REFERRER` | First-touch attribution |

Runtime values override a key compiled into the binary. An explicitly empty `POSTHOG_KEY=`
disables a compiled-in key. Release builds read GitHub secrets `POSTHOG_KEY` and optional
`POSTHOG_HOST`. Development and CI send nothing unless those variables are set.

## How to view

This machine: `fabdesk-core funnel` or `GET /funnel` (JSON / `?format=html`).

Ad batch: PostHog funnel insight, unique-user window of 7 days, broken down by person properties
`utm_source`, `utm_campaign` and `gclid`.

```sql
SELECT
  properties.$anon_distinct_id AS anon_id,
  distinct_id,
  event,
  person.properties.utm_source AS utm_source,
  person.properties.utm_campaign AS utm_campaign,
  person.properties.gclid AS gclid
FROM events
WHERE event IN (
  'landing_view',
  'onboarding_account_created',
  'onboarding_app_launched',
  'onboarding_signed_in',
  'onboarding_first_project',
  'onboarding_first_ai_run',
  'onboarding_first_review_viewed'
)
AND timestamp > now() - INTERVAL 7 DAY
```
