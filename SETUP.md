# Connecting ZUUWA to Supabase — step by step

Do these steps once, in order. About 10 minutes.

## 1. Create the two users

1. Open https://supabase.com/dashboard and open your project (**kmaitbkmnzyniaxkajrb**).
2. Left menu → **Authentication** → **Users** → **Add user** → **Create new user**.
3. Email: `cik_anissa@yahoo.com`, type a strong password, tick **Auto Confirm User**, click **Create user**.
4. Repeat for `firdausjaafar44@gmail.com` with its own password.

Passwords are stored only by Supabase. They are never in the app.

## 2. Stop strangers from signing up

1. **Authentication** → **Sign In / Providers** (or **Providers** → **Email**).
2. Turn **off** "Allow new users to sign up". Keep **Email** enabled.
3. Save.

## 3. Create the database (one copy-paste)

1. Left menu → **SQL Editor** → **New query**.
2. Open the file `supabase/setup.sql` from this project, select everything, copy, and paste it into the editor.
3. Click **Run**.
4. At the bottom you should see two rows: **Anis — admin** and **Firdaus — user**. If a row is missing, check the email in step 1 and run the script again (it is safe to re-run).

This creates:
- Tables for customers, quotations, invoices, payments, receipts, warranty letters, settings and numbering, all linked to each other.
- Row Level Security on every table: only Anis and Firdaus, signed in, can read or write. Visitors who are not signed in get nothing.
- Database rules: only Anis can change document numbers or numbering settings; the "Created By" name is set by the database from the signed-in user and can't be changed; linked documents can't be deleted while other documents depend on them.
- A **private** file bucket `zuuwa-private` (no public links).

## 4. Put the app online

1. Download this project (the whole folder).
2. Go to https://app.netlify.com/drop and drag the folder onto the page. Netlify gives you a web address like `https://zuuwa-xxxx.netlify.app`.
3. Back in Supabase → **Authentication** → **URL Configuration** → set **Site URL** to that address → Save.
4. Open the address on your iPhone and laptop. On iPhone: Share → **Add to Home Screen**.

The Supabase address and the *publishable* key are in `app/config.js`. That key is meant to be public; your data is protected by the rules from step 3. Never put the `service_role` key or the database password in any app file.

## 5. First sign-in (Anis)

1. Sign in as Anis.
2. Go to **Settings** and set up company details, bank, job scopes, terms, logo, signature, company stamp and login photos. These are shared with Firdaus.
3. Add customers and start creating documents.

## Quick security check

Open this in a private/incognito browser window (not signed in):

`https://kmaitbkmnzyniaxkajrb.supabase.co/rest/v1/zw_quotations?select=*&apikey=sb_publishable_WclA22ZXLXzzodMqfBdf7Q_hQyguvjg`

You should see `[]` (empty) even after you have created quotations. That shows anonymous visitors cannot read your data.

## Resetting a password

Supabase → **Authentication** → **Users** → click the user → **Send password recovery**, or delete and re-create the user with the same email (then run `supabase/setup.sql` again).
