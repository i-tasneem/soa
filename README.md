# SOA Trader v2.0 — Sensex Option Assistant
## Local PWA with Live Angel One SmartAPI Data

---

## QUICK START

### Step 1 — Edit config.js (ONE TIME ONLY)
Open `config.js` and fill in your credentials:

```js
angel: {
  apiKey:     'YOUR_API_KEY',       // From smartapi.angelbroking.com
  clientId:   'YOUR_CLIENT_ID',     // Angel One login ID (e.g. A123456)
  password:   'YOUR_MPIN',          // 4-digit MPIN
  totpSecret: 'YOUR_TOTP_SECRET',   // From smartapi.angelbroking.com/enable-totp
}
```

### Step 2 — Install Node.js (ONE TIME ONLY)
Download from: https://nodejs.org (LTS version)

### Step 3 — Run the app
- **Windows:** Double-click `START.bat`
- **Mac/Linux:** Run `bash start.sh` in terminal

### Step 4 — Open in Chrome
Go to: `http://localhost:3000`

### Step 5 — Install as PWA on your PC
Click the install icon (⊕) in Chrome address bar

### Step 6 — Install on Android Phone
1. Make sure phone and PC are on same WiFi
2. Find your PC's IP: `ipconfig` (Windows) or `ifconfig` (Mac)
3. On phone Chrome: go to `http://192.168.x.x:3000`
4. Tap Chrome menu (⋮) → "Add to Home Screen"

---

## HOW TO GET ANGEL ONE API CREDENTIALS

1. Go to https://smartapi.angelbroking.com
2. Sign up with your Angel One Client ID
3. Click "Create an App"
4. Select API Type: **Trading API**
5. Give any App Name (no spaces)
6. Redirect URL: `http://localhost:3000`
7. Copy the **API Key**

For TOTP Secret:
1. Go to https://smartapi.angelbroking.com/enable-totp
2. Complete SMS verification
3. Scan QR code with **Google Authenticator**
4. Copy the **secret key** (shown below QR code)

---

## CONFIG FILE EXPLAINED

| Parameter | Description |
|---|---|
| `apiKey` | Your SmartAPI API Key |
| `clientId` | Angel One login ID |
| `password` | Your 4-digit trading PIN (MPIN) |
| `totpSecret` | TOTP secret from SmartAPI portal |
| `defaultLots` | Default lot size for calculator |
| `defaultTarget` | Target premium move in ₹ |
| `defaultStopLoss` | Stop loss premium in ₹ |
| `defaultMonthlyGoal` | Monthly income target in ₹ |
| `port` | Local server port (keep 3000) |

---

## APP FEATURES

| Tab | Features |
|---|---|
| HOME | Real-time IST session guidance, time-based checklists, trading window alerts |
| MARKET | Live Sensex price, ATM/ITM/OTM option chain with target & SL pre-calculated |
| CALC | Capital calculator — input your edge, get exact lots & capital required |
| RULES | Full strategy guide — MTF framework, time windows, golden rules |

---

## SECURITY NOTES

- API credentials are ONLY in `config.js` on your local machine
- The server runs on localhost — not accessible from internet
- Never share `config.js` or push it to GitHub
- Add `config.js` to `.gitignore` if using version control

---

## TROUBLESHOOTING

**"Server offline" in app:**
→ Run `node server.js` or double-click `START.bat`

**"Auth error" in console:**
→ Check credentials in `config.js`
→ Make sure TOTP is enabled in Angel One SmartAPI portal

**Phone can't connect:**
→ PC and phone must be on same WiFi
→ Use PC's local IP (not localhost) on phone
→ Windows: allow Node.js through firewall

**Option chain not loading:**
→ Market must be open (9:15 AM – 3:30 PM)
→ Check Angel One API rate limits

---

*SOA Trader is for personal use only. Not SEBI registered financial advice.*
