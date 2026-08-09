-- ============================================================================
-- 0003 — remove spend-capable secrets from the database
--
-- Eight credentials moved to Cloudflare environment variables only: the ones
-- that can spend money or send mail as your domain.
--
--   RESEND_API_KEY, BREVO_API_KEY, LOOPS_API_KEY   send email AS your domain.
--     A leak here is not a bill, it is phishing your own customers from an
--     address that passes SPF and DKIM, and burning the sending reputation
--     that makes your order confirmations land in inboxes. Rotating the key
--     does not un-send anything.
--   SHIPPO_API_KEY, VEEQO_API_KEY                  buy shipping labels on your
--     account.
--   TWILIO_ACCOUNT_SID / AUTH_TOKEN / FROM_NUMBER  send SMS at your cost, and
--     read replies to your number.
--
-- The code change alone is not enough. resolveSetting() now ignores stored
-- values for these keys, so they are no longer USED — but any copy already
-- written by the old admin editor would still be sitting in site_settings, a
-- live credential readable by anything holding the service-role key, doing
-- nothing. Dead secrets are worse than live ones: nobody rotates what nobody
-- remembers is there.
--
-- ⚠ BEFORE APPLYING: make sure each key you actually use is set in Cloudflare
-- (Pages → your project → Settings → Environment variables) and that you have
-- redeployed. If a key was only ever set through the admin, deleting the row
-- without adding the env var will stop that service working — email will fail
-- to send, or rates will stop quoting.
--
-- Safe to run more than once.
-- ============================================================================

delete from public.site_settings
where key in (
  'RESEND_API_KEY',
  'BREVO_API_KEY',
  'LOOPS_API_KEY',
  'SHIPPO_API_KEY',
  'VEEQO_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER'
);
