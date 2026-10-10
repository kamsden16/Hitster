# 🎵 Hitster v2 — Music Timeline Party Game

A multiplayer web game where players compete to build a chronological timeline of songs. Reach 10 cards and lead outright when everyone has had their turn to win!

---

## Prerequisites

- [Node.js](https://nodejs.org) v18 or higher
- A [Spotify Developer Account](https://developer.spotify.com/dashboard) (free)
- Spotify Premium (required for in-browser playback via Web Playback SDK)
- Your Spotify account email added as a tester in your Spotify app's User Management

---

## 1. Set Up Your Spotify App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App** and fill in:
   - **App name**: Hitster Game (or anything)
   - **Redirect URI**: `http://127.0.0.1:3000/auth/callback`
   - Check **Web API** and **Web Playback SDK**
3. Save, then copy your **Client ID** and **Client Secret**
4. Go to **Settings → User Management** and add your Spotify email address (and any friends who will play)

> Spotify Developer apps are limited to 25 users in Development Mode. Every player must be added here.

---

## 2. Configure Environment

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

**Mac/Linux:**
```bash
cp .env.example .env
```

Edit `.env`:
```env
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
BASE_URL=http://127.0.0.1:3000
PORT=3000
WIN_SCORE=10
```

---

## 3. Install & Run

```bash
npm install
npm start
```

Open **http://127.0.0.1:3000** in your browser.

> Use `127.0.0.1` not `localhost` — Spotify no longer accepts `localhost` as a redirect URI as of late 2025.

---

## 4. Remote Play (HTTPS Setup)

The Spotify Web Playback SDK requires HTTPS for in-browser audio. For remote friends to each hear music in their own browser, set up HTTPS with a self-signed certificate.

### Generate a certificate (run once from your Hitster folder)

**Windows (PowerShell)** — requires OpenSSL ([download here](https://slproweb.com/products/Win32OpenSSL.html)):
```powershell
mkdir certs
openssl req -x509 -newkey rsa:2048 -keyout certs\key.pem -out certs\cert.pem -days 365 -nodes -subj "/CN=hitster-game"
```

**Mac/Linux:**
```bash
mkdir certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj "/CN=hitster-game"
```

### Find your local IP
- **Windows:** Run `ipconfig` → look for `IPv4 Address` (e.g. `192.168.1.50`)
- **Mac/Linux:** Run `ifconfig` → look for `inet`

### Update Spotify Dashboard
Add this redirect URI in your Spotify app settings:
```
https://192.168.1.50:3443/auth/callback
```

### Update your .env
```env
BASE_URL=https://192.168.1.50:3443
HTTPS_PORT=3443
```

### Share with friends
Send friends `https://192.168.1.50:3443` — they'll see a browser security warning about the self-signed certificate. They click **Advanced → Proceed anyway** (Chrome) or **Accept the Risk** (Firefox). This only needs to be done once.

> Friends must be on the same WiFi network. For internet play across different locations, use [ngrok](https://ngrok.com) (paid plan recommended to avoid interstitial pages).

---

## 5. How to Play

1. **Host** connects Spotify, creates a room, shares the 5-letter code
2. **Players** join with the code and connect their own Spotify accounts
3. **Host** loads one of their Spotify playlists and clicks Start Game
4. Each round, a song plays — players use the slider to guess the **release year**
5. You score a point if your guess puts the song in the **correct position** in your timeline (you don't need the exact year — just the right spot relative to songs you already have)
6. Once someone reaches **10 cards**, the round finishes so everyone gets an equal number of turns. The outright leader at that point wins; if the top is tied, play another full round until someone leads.

### Rejoining after a disconnect
Phone locked or page refreshed? Just reopen the game — your browser remembers the room and rejoins automatically, keeping your timeline and tokens. If it doesn't (different browser, cleared storage), join again with the **same name and room code** and you get your seat back. Seats are held for 5 minutes. If the active player drops mid-turn, the song plays out and then the host is asked whether to skip their turn or keep waiting. If the host stays offline for 30 seconds, another connected player becomes host.

### Scoring example
If your timeline has songs from 1975 and 1995, and the new song is from 1983:
- Guessing **1980** ✅ — lands between 1975 and 1995, same as where 1983 would go
- Guessing **1970** ❌ — would go before 1975, which is wrong

---

## 6. Playlist Tips

- Use a playlist **owned by your Spotify account** (copied playlists count as yours)
- The playlist must have at least 15 tracks with known release years
- Loading large playlists (500+ songs) takes time due to Spotify API rate limits — expect 1–2 minutes for very large ones

---

## Tech Stack

- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JS
- **Music**: Spotify Web API + Web Playback SDK
- **Real-time**: WebSockets via Socket.io

---

## Deploying to Railway (Internet Play)

Railway hosts the app publicly so anyone can join without being on your network.

### 1. Push to GitHub

**Install Git if you don't have it:** [git-scm.com/download/win](https://git-scm.com/download/win) — use all default options during install, then restart PowerShell.

Create a new **empty** repo on [github.com](https://github.com) (no README, no .gitignore — leave them unchecked).

Then in PowerShell, navigate to your Hitster folder and run:
```powershell
cd "C:\Users\YourName\Desktop\Hitster Online\Hitster1.1"
git init
git add .
git commit -m "Hitster v2"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

If prompted for GitHub credentials, use your GitHub username and a **Personal Access Token** (not your password) — create one at GitHub → Settings → Developer Settings → Personal Access Tokens → Tokens (classic) → Generate new token, with `repo` scope checked.

### 2. Create Railway project
1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project → Deploy from GitHub repo**
3. Select your Hitster repo
4. Railway will detect Node.js and deploy automatically

### 3. Add Redis (for album cache persistence)
1. In your Railway project, click **+ New** → **Database** → **Add Redis**
2. Railway automatically sets `REDIS_URL` in your app's environment

### 4. Set environment variables
In Railway dashboard → your service → **Variables**, add:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
BASE_URL=https://your-app.up.railway.app
WIN_SCORE=10
```
Find your Railway URL under **Settings → Domains** (or generate one there).

### 5. Update Spotify Dashboard
Add your Railway URL as a redirect URI:
```
https://your-app.up.railway.app/auth/callback
```

### 6. Add players to Spotify User Management
Every player still needs to be added to your Spotify Developer app under **User Management** (up to 25 in Development Mode).

### Notes
- Railway's free tier sleeps after inactivity — upgrade to Hobby ($5/mo) for always-on
- The album cache is stored in Redis and persists across deploys
- HTTPS is automatic — Web Playback SDK works for everyone out of the box
