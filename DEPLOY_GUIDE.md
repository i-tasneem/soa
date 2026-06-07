# 🚀 SOA Trader — Complete Railway Deployment Guide

---

## PART 1 — Update Your Project Files

You have 3 updated files to copy into your project folder.
Your project folder is: `D:\soa-trader-v2\soa-local-upgraded\soa-local\`

### Files to replace:

| File | Location in your project |
|------|--------------------------|
| `config.js` | `soa-local\config.js` (root) |
| `server.js` | `soa-local\server.js` (root) |
| `orchestrator.js` | `soa-local\strategy\orchestrator.js` |
| `.gitignore` | `soa-local\.gitignore` (root, new file) |

Copy each downloaded file to the correct location, overwriting the old ones.

---

## PART 2 — Install Git

Git is the tool that sends your code to GitHub.

1. Go to **https://git-scm.com/download/win**
2. Download and run the installer
3. Click **Next** on every screen — all defaults are fine
4. When done, open **Command Prompt** (press `Win + R`, type `cmd`, press Enter)
5. Type this to confirm it worked:
   ```
   git --version
   ```
   You should see something like: `git version 2.44.0`

---

## PART 3 — Create a GitHub Account & Repository

GitHub is where your code is stored online (like Google Drive, but for code).

1. Go to **https://github.com** → click **Sign up**
2. Create a free account (remember your username and password)
3. After logging in, click the **"+"** button (top right) → **"New repository"**
4. Fill in:
   - **Repository name:** `soa-trader`
   - **Visibility:** ✅ Select **Private** (keeps your credentials safer)
   - Leave everything else as-is
5. Click **"Create repository"**
6. GitHub will show you a page with setup instructions — **keep this tab open**

---

## PART 4 — Push Your Code to GitHub

Open **Command Prompt** and run these commands one by one.
(Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username.)

```
cd D:\soa-trader-v2\soa-local-upgraded\soa-local
```
```
git init
```
```
git add .
```
```
git commit -m "Initial deploy"
```
```
git branch -M main
```
```
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/soa-trader.git
```
```
git push -u origin main
```

When it asks for your GitHub **username and password**:
- Username: your GitHub username
- Password: use a **Personal Access Token** (not your GitHub password)
  - Go to GitHub → click your profile photo (top right) → **Settings**
  - Scroll down → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
  - Click **"Generate new token (classic)"**
  - Give it a name like `railway-deploy`, set expiry to **90 days**
  - Check the **`repo`** checkbox only
  - Click **Generate token** → **copy the token immediately** (you won't see it again)
  - Paste this token as your password when `git push` asks

After `git push` finishes, refresh your GitHub repo page — you should see all your files there. ✅

---

## PART 5 — Deploy on Railway

1. Go to **https://railway.app**
2. Click **"Start a New Project"** → **"Sign in with GitHub"** → authorize Railway
3. Click **"New Project"** → **"Deploy from GitHub repo"**
4. Select your `soa-trader` repository
5. Railway will automatically detect Node.js and start deploying

Wait about 1–2 minutes. You'll see a build log — it should end with your server startup message. ✅

---

## PART 6 — Set Your Secret Credentials on Railway

Your API keys must be set as environment variables — **never stored in code**.

1. In your Railway project, click on your service (the box that appeared after deploy)
2. Click the **"Variables"** tab
3. Click **"Add Variable"** for each of the following:

| Variable Name | Value |
|---------------|-------|
| `ANGEL_API_KEY` | `SeoI8qY4` |
| `ANGEL_CLIENT_ID` | `A51304651` |
| `ANGEL_PASSWORD` | `1808` |
| `ANGEL_TOTP_SECRET` | `LDMGV7KZHMD366QPUTHI6KO2GY` |

4. After adding all 4, Railway will automatically restart your app with the new values ✅

---

## PART 7 — Get Your Public URL

1. In your Railway project, click on your service
2. Click the **"Settings"** tab → scroll to **"Networking"**
3. Click **"Generate Domain"**
4. Railway gives you a URL like:
   ```
   https://soa-trader-production.up.railway.app
   ```
5. Open this URL from **any browser, anywhere** — your trading app is live! 🎉

---

## PART 8 — Updating Your App in the Future

Whenever you make changes to your code locally, just run these 3 commands:

```
cd D:\soa-trader-v2\soa-local-upgraded\soa-local
git add .
git commit -m "describe what you changed"
git push
```

Railway automatically detects the push and redeploys within 1–2 minutes. No manual steps needed.

---

## ⚠️ Important Notes

**Angel One IP Whitelist**
Angel One's SmartAPI may reject connections from Railway's server IP.
If your app says "Auth failed" after deploy but works locally:
- Log in to https://smartapi.angelbroking.com
- Go to your API settings → IP Whitelist
- Add Railway's IP (shown in Railway → Settings → Networking → Outbound IPs)
- Or set whitelist to `0.0.0.0/0` to allow all IPs (less secure but easiest)

**Free Tier Limits**
Railway's free tier gives $5 credit/month. Your app uses roughly $0.50–$2/month
depending on traffic. You'll get an email warning well before any charges.

**Your app stays on 24/7**
Unlike your local setup, Railway keeps the server running even when your
PC is off. Angel One auth refreshes automatically every 12 hours.

---

## 🆘 Troubleshooting

| Problem | Fix |
|---------|-----|
| `git push` asks for password | Use Personal Access Token, not GitHub password |
| Build fails on Railway | Check the build logs — usually a missing file |
| App deploys but shows "Auth failed" | Set environment variables in Railway → Variables tab |
| Live data not coming | Angel One IP whitelist issue — see note above |
| Can't find your Railway URL | Service → Settings → Networking → Generate Domain |
