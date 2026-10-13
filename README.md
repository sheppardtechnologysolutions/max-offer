# Max Offer

A real estate deal analyzer for rentals, BRRRRs and flips. It has Supabase accounts, cloud-saved deals, and RentCast property lookups with comps.

```
index.html                                 the app
config.js                                  your Supabase URL + anon key (you fill this in)
supabase/schema.sql                        database tables and security rules
supabase/functions/rentcast-lookup/index.ts   server function that calls RentCast
```

How it fits together: the browser app talks to Supabase for sign-in and saved deals. For a property lookup, it calls the `rentcast-lookup` Edge Function. That function holds your RentCast key, checks a 30-day cache, enforces a monthly request cap and then calls RentCast. **Your RentCast key never reaches the browser.**

---

## Setup (about 20 minutes, all free)

### 1. Create the database tables
1. Open your project at supabase.com → **SQL Editor** → **New query**.
2. Paste all of `supabase/schema.sql` and click **Run**. It should say "Success. No rows returned."

### 2. Add your RentCast key as a secret
1. **Edge Functions** → **Secrets** (sometimes under *Manage secrets*).
2. Add `RENTCAST_API_KEY` = your RentCast key.
3. Optional: `MAX_MONTHLY_REQUESTS` = `45`. Each new address uses 3 requests, so 45 allows 15 new addresses a month, inside RentCast's 50 free.

### 3. Deploy the lookup function
In the browser (easiest):
1. **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `rentcast-lookup`.
3. Replace the sample code with all of `supabase/functions/rentcast-lookup/index.ts` and click **Deploy**.
4. Leave **Verify JWT** turned on, so only signed-in users can call it.

Or with the Supabase CLI:
```
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set RENTCAST_API_KEY=your_key_here
supabase functions deploy rentcast-lookup
```

### 4. Connect the app to your project
1. **Project Settings** → **API** (or **Data API** / **API Keys**).
2. Copy the **Project URL** and the **anon public** key.
3. Paste both into `config.js`. These two values are safe to publish.

### 5. Put the app online with GitHub Pages
1. On github.com, create a new **public** repository named `max-offer`.
2. **Add file → Upload files**, then drag in `index.html`, `config.js`, `README.md` and the `supabase` folder. Commit.
3. Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → **Save**.
4. After a minute your app is live at `https://YOUR-GITHUB-NAME.github.io/max-offer/`.

### 6. Tell Supabase where the app lives
1. **Authentication → URL Configuration**.
2. **Site URL**: `https://YOUR-GITHUB-NAME.github.io/max-offer/`
3. **Redirect URLs**: add the same URL. Sign-in links won't return to your app without this.

Email sign-in links now work. Supabase's built-in email sender allows only a few emails per hour, which is fine for you and testers. Connect your own email provider later under Authentication → Emails → SMTP.

### 7. Optional: "Continue with GitHub" sign-in
1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
   - Homepage URL: your GitHub Pages URL
   - Authorization callback URL: `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
2. Create it, then generate a **client secret**.
3. Supabase → **Authentication → Sign In / Providers → GitHub** → turn it on and paste the Client ID and Client Secret.

### 8. Test it
1. Open your live URL and click **Sign in**.
2. Use the email link or GitHub.
3. Type a full address in **Import a property** (for example `5500 Grand Lake Dr, San Antonio, TX 78244`) and click **Look up**.
4. Click **Apply all to deal**, set your purchase price and click **Save deal**.
5. Open the site on your phone and sign in. The deal is there.

---

## How usage is protected
- **Cache.** Each address is cached for 30 days. Re-opening or re-looking-up an address costs nothing. **Refresh from RentCast** forces a new pull.
- **Monthly cap.** Fresh lookups stop at `MAX_MONTHLY_REQUESTS` RentCast requests each calendar month. The app then shows a clear message instead of running up overage fees.
- **Billing count.** Only successful RentCast responses count toward the cap, matching how RentCast bills.

## Troubleshooting
| What you see | Fix |
| --- | --- |
| "Property lookups turn on once Supabase is connected" | `config.js` is empty or wasn't uploaded |
| "Sign in to look up properties" after signing in | Re-deploy the function; check it's named `rentcast-lookup` |
| "The RentCast key isn't set" | Add the `RENTCAST_API_KEY` secret (step 2), then re-deploy |
| "RentCast rejected the API key" | Copy the key again from your RentCast dashboard |
| Sign-in link opens a blank or localhost page | Set Site URL and Redirect URLs (step 6) |
| "Couldn't load your deals" | Run `schema.sql` again (step 1) |
