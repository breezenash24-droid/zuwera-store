-- 0004_orders_tax_engine.sql
--
-- Record which engine worked out the tax on each order.
--
-- The Tax page counts what was actually collected, so it keeps working whatever
-- calculates it. What it could not do is say WHERE a figure came from — and the
-- moment a store switches from the built-in table to TaxJar, or an external
-- service has a bad afternoon and orders fall back to the table, a year's
-- numbers stop being one thing. At filing time "we collected $4,210 in Ohio" is
-- a different statement from "we collected $4,210 in Ohio, $3,900 of it
-- calculated by TaxJar and the rest by our own table during an outage".
--
-- Nullable and free of a default on purpose: every order already in the table
-- predates the setting, and stamping them 'builtin' would be inventing a record
-- of a decision nobody made. NULL reads as "before this was tracked", which is
-- the truth.
--
-- Values written by stripe-webhook, from the PaymentIntent metadata:
--   builtin | stripe_tax | taxjar | ziptax | external | none
--   taxjar→builtin  (and friends) when the provider failed and the table covered

alter table if exists public.orders
  add column if not exists tax_engine text;

comment on column public.orders.tax_engine is
  'Which tax engine produced this order''s tax. An arrow (e.g. taxjar→builtin) means the provider failed and the built-in table was used instead. NULL for orders placed before this was recorded.';
