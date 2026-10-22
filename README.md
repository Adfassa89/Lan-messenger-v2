# LAN Messenger

A fast, modern and secure messenger for Windows PCs on the same office or site network.
It needs **no server and no internet**. Install it on each PC, and the PCs find each other automatically.

![Icon](build/icon.png)

## Features

| | |
|---|---|
| 🔎 **Finds people automatically** | Everyone running LAN Messenger on the network shows up within seconds, with their status (Available / Away / Busy). |
| 💬 **Private and group chats** | Chat one-to-one, create groups (e.g. "Planning team"), or post to **Everyone** for site-wide announcements. |
| ✅ **Reliable delivery** | Messages to someone who is offline wait on your PC and are delivered automatically when they come back. Ticks show *waiting → delivered → read*. |
| 📎 **Fast file transfer** | Drag & drop any file (any size), see progress and speed. Interrupted downloads resume where they stopped. Images show a preview. |
| 📋 **Paste screenshots** | Press `Ctrl + V` in a chat to send a screenshot. |
| 🔒 **Encrypted** | All messages and files are encrypted (AES-256) between PCs. |
| 🔍 **Search** | Find any old message with `Ctrl + F`; jump to people with `Ctrl + K`. |
| 🔔 **Notifications** | Windows pop-ups, sound, unread counter on the taskbar icon and tray. *Busy* mutes them. |
| 🌙 **Light & dark theme** | Follows Windows automatically, or choose one. |
| 🕒 **Saved history** | All chats are saved on your PC. |
| ⚙️ **Convenient** | Starts with Windows (optional), runs in the system tray, sets you *Away* when idle. |

## How to get the app (no programming needed)

1. Open this repository on GitHub and click the **Actions** tab.
2. Click the latest green ✅ **Build Windows app** run.
3. At the bottom, under **Artifacts**, download **LAN-Messenger-Windows** (a .zip file).
4. Unzip it. Inside are two files:
   - `LAN-Messenger-Setup-2.0.0.exe` is the normal installer (recommended).
   - `LAN-Messenger-Portable-2.0.0.exe` runs without installing, e.g. from a USB stick.

> **Releases:** when a version tag such as `v2.0.0` is pushed, the same files are also attached to a GitHub **Release**, which is an easier link to share with IT.

### Installing on each PC

1. Run `LAN-Messenger-Setup-2.0.0.exe`.
2. If Windows shows **"Windows protected your PC"**, click **More info → Run anyway**. This appears because the app is not signed with a paid certificate.
3. Choose **"Install for all users"** if you can. The installer then also adds the Windows Firewall rule automatically.
   If you install "just for me", Windows will ask about the firewall the first time the app starts. Tick **both Private and Domain networks** and click **Allow**.

### If people don't appear

- Make sure LAN Messenger is running on both PCs.
- Make sure the firewall allows **LAN Messenger** (see above). IT can open **UDP port 50100** and **TCP port 50101**.
- If the PCs are on different network segments (different subnets/VLANs), open **Settings → Network → Add a computer by IP address** and type the other PC's IP. The other PC's IP is shown in its own Settings → Network.

## Where data is stored

- Chats & settings: `%APPDATA%\LAN Messenger`
- Received files: `Downloads\LAN Messenger` (can be changed in Settings)

---

## For developers

Requires [Node.js](https://nodejs.org) 22+.

```bash
npm install      # install dependencies
npm start        # run the app
npm test         # run automated tests
npm run dist     # build Windows installer into dist/ (on Windows)
```

Project layout:

```
src/core/       networking, encryption, storage (no UI; fully tested)
  protocol.js   encrypted framed TCP connections (X25519 + AES-256-GCM)
  discovery.js  UDP broadcast discovery (port 50100)
  messenger.js  peers, reliable message queue, groups, receipts
  files.js      resumable pull-based file transfer
  store.js      crash-safe JSON storage
src/main/       Electron main process (window, tray, notifications)
src/renderer/   user interface (HTML/CSS/JS, no build step)
test/           automated tests (node --test)
```

To run two copies on one PC for testing, start the second with a separate profile folder:
`set LANMSG_PROFILE=C:\temp\lm2 && npm start`.

Encryption note: connections use fresh keys every time, so recorded traffic cannot be read later.
There is no central authority that verifies identities, so the app trusts that people on your LAN are who they say they are.
