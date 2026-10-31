# LAN Messenger 2

A fast, modern and secure messenger for Windows PCs on the same office or site network.
It needs **no server and no internet**. Install it on each PC, and the PCs find each other automatically.
Available in **English** and **Монгол**.

![Icon](build/icon.png)

## Features

### Big features
| | |
|---|---|
| 🚨 **Urgent alerts** | A red pop-up with an alarm sound appears on top of everything on the other PCs (even when they are set to *Busy*) and stays until each person clicks **Acknowledge**. You see who confirmed and who hasn't. Made for blasting notices, safety warnings and breakdowns. |
| 📞 **Voice and video calls** | Call a colleague or a whole group (up to about 6 people) from the chat header. Calls go directly PC-to-PC over the network, with no internet or server. Incoming calls pop up with a ringtone; you can mute, switch the camera on or off, and choose microphone, camera and speaker. Missed calls appear in the chat with a **Call back** button. |
| ♟️ **Games in chats** | Play **Chess** (with a chess.com-style board), **Checkers**, **Tic-tac-toe**, **Connect Four** or **Tetris Battle** with a colleague in a private chat (＋ → Play a game). Turn-based moves are delivered like messages, so a game can run across shifts; each PC checks every move against the rules. |
| ♟️ **Chess like chess.com** | Choose your side (White, Black or random) and a time control (bullet, blitz, rapid or no limit; checkers has clocks too). Premoves, right-click marks and arrows, and you can look at your pieces' moves while waiting. Every game has sound effects and the same win / lose screen. |
| 🧱 **Tetris Battle** | A live head-to-head match in the style of TETR.IO: both players get the same pieces, and clearing lines sends garbage rows to the opponent. Controls can be changed like in old Facebook Tetris Battle: rebind every key, pick the *Classic* or *Modern* preset, and adjust the sliding delay, sliding speed and soft-drop speed. |
| 🖥️ **Screen sharing** | Show your screen (or one window) live to a colleague or a whole group. It goes directly PC-to-PC over the network. Viewers can only watch; they can't control your PC. |
| ✏️ **Screenshot with drawing** | `Ctrl + Shift + S` (or **＋ → Screenshot with drawing**) takes a screenshot. Crop it, add arrows, boxes, highlights and text, then send. Pasted pictures can be drawn on too. |
| 🇲🇳 **Mongolian / English** | Switch language in **Settings → Language**. Every screen is translated. |
| 🔄 **Automatic updates** | When one PC gets a newer version, the others download it from that PC and offer a **Restart**. PCs with internet access also get new versions from GitHub. **Settings → Check for updates** shows what is happening and updates on demand. Updates are digitally signed, so nobody can push fake software. If an update ever fails to start, the PC goes back to the previous version automatically. |

### Everyday features
| | |
|---|---|
| 💬 **Private, group and "Everyone" chats** | Chat one-to-one, in groups, or post to the whole site. |
| ✅ **Reliable delivery** | Messages to someone who is offline wait and are delivered when they're back. Ticks show *waiting → delivered → read*. |
| ↩️ **Reply** | Hover a message and click reply to quote it. |
| 👍 **Reactions** | 👍 ❤️ 😂 😮 😢 ✅ and any other emoji. |
| ✏️ **Edit / delete for everyone** | Fix a typo (or press `↑` in an empty message box to edit your last message) or take back a message sent by mistake. |
| 📌 **Pinned messages** | Keep shift handover notes or key info at the top of a chat. |
| 📊 **Polls** | One-click voting, with single or multiple answers. |
| ⏰ **Scheduled messages** | Write now, send automatically later (e.g. at 07:00 shift start). |
| 🎤 **Voice messages** | Click the microphone, speak, click Send. |
| 📁 **Files and whole folders** | Drag & drop files or folders of any size. Progress and speed are shown, interrupted downloads resume, and either side can stop a transfer while it runs. |
| 🖼️ **Profile photos** | Settings → Change photo. |
| 📄 **Export chat** | Save a conversation as PDF or text for records. |
| 🔒 **Encrypted** | All messages, files and screen sharing are encrypted between PCs. |
| 🎨 **6 design styles** | Indigo (default), Office, Ocean, Minimal, Mine Site and Emerald, each in light and dark. Choose in **Settings → Appearance**. |
| 📥 **Stays in the taskbar corner** | Closing the window (✕) keeps the app running next to the clock, like the old LAN Messenger, so no message is missed. To close it completely, right-click the tray icon and choose **Exit**. (If you don't see the icon, click the small **^** arrow next to the clock.) |
| 🚀 **Starts with Windows** | On by default: the app opens quietly in the tray when the PC starts. Can be turned off in Settings. |
| 🖱️ **Drag & drop** | Drag files or folders into an open chat, or straight onto a person or group in the left list to send them without opening the chat. |
| 🔔 **Notifications and sounds** | Desktop pop-ups and a sound for new messages, a ringtone for calls, and an alarm for urgent alerts. Each can be turned off in Settings; *Busy* silences message pop-ups and sounds, but urgent alerts still come through. |
| 🔍 **Search**, 🌙 **dark mode**, auto-away | |

## How to get the app (no programming needed)

1. Open this repository on GitHub and click the **Actions** tab.
2. Click the latest green ✅ **Build Windows app** run.
3. At the bottom, under **Artifacts**, download **LAN-Messenger-Windows** (a .zip file).
4. Unzip it. Inside are two files:
   - `LAN-Messenger-2-Setup-<version>.exe` is the normal installer (recommended).
   - `LAN-Messenger-2-Portable-<version>.exe` runs without installing, e.g. from a USB stick.

> **Releases (public download page):** the newest version is also on the [Releases page](https://github.com/Adfassa89/Lan-messenger-v2/releases). To publish a new version there: **Actions → Build Windows app → Run workflow**, tick **Publish a release**, click **Run workflow**. The release is named after the version in `package.json`.

### Installing on each PC

1. Run `LAN-Messenger-2-Setup-<version>.exe`.
2. If Windows shows **"Windows protected your PC"**, click **More info → Run anyway**. This appears because the app is not signed with a paid certificate.
3. Choose **"Install for all users"** if you can. The installer then also adds the Windows Firewall rule automatically.
   If you install "just for me", Windows will ask about the firewall the first time the app starts. Tick **both Private and Domain networks** and click **Allow**.

After this first install, newer versions spread by themselves over the network (see below).

### One-time setup: turn on network updates

Network updates only work for builds signed with your private **update signing key**. You do this once:

1. Open the file `UPDATE_SIGNING_KEY.txt` that was given to you. Copy **everything** in it, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.
2. On GitHub, open this repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
3. Name: `UPDATE_SIGNING_KEY`. Secret: paste the text. Click **Add secret**.
4. Keep the file somewhere safe (e.g. a password manager) and **never share it**. Anyone with this key could make updates that your PCs would accept.

Without the secret, everything else works normally; builds just won't pass themselves on as updates.

### If people don't appear

- Make sure LAN Messenger 2 is running on both PCs.
- Make sure the firewall allows **LAN Messenger 2** (see above). IT can open **UDP port 50100** and **TCP port 50101**.
  If only one of two PCs blocks the app, chat, games and file transfers still work (the open PC is used for both directions), but people appear more slowly. If **both** PCs block it, they cannot reach each other at all.
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
src/core/        networking, encryption, storage (no UI; fully tested)
  protocol.js    encrypted framed TCP connections (X25519 + AES-256-GCM)
  discovery.js   UDP broadcast discovery (port 50100)
  messenger.js   peers, reliable queue, groups, receipts, reactions, edits,
                 pins, polls, urgent alerts, scheduling, avatars
  files.js       resumable pull-based file/folder transfer, update sharing
  update.js      Ed25519 update signing and verification
  store.js       crash-safe JSON storage
src/main/        Electron main process
  boot.js        starts the newest verified version (installed or LAN update)
  updater.js     finds, downloads and verifies updates from other PCs
  main.js        windows, tray, notifications, alerts, screen capture
src/renderer/    user interface (HTML/CSS/JS, no build step)
  app.js         chat UI · editor.js screenshot drawing · voice.js · share.js
  call.html      voice/video call window · ring.html incoming call pop-up
  game.js        game cards and boards (rules in src/shared/games.js)
  tetris.html    Tetris Battle window (engine in src/shared/tetris.js,
                 key settings in tetris-controls.js)
  alert.html     urgent alert window · viewer.html screen-share viewer
src/shared/      i18n.js translations (English text is the key)
build/           icons, installer firewall rule, after-pack update signing
test/            automated tests (node --test)
```

Adding UI text: wrap it in `t('...')`; `npm test` fails until a Mongolian translation is added to `src/shared/i18n.js`.

To run two copies on one PC for testing, start the second with a separate profile folder:
`set LANMSG_PROFILE=C:\temp\lm2 && npm start`.

Encryption note: connections use fresh keys every time, so recorded traffic cannot be read later.
There is no central authority that verifies identities, so the app trusts that people on your LAN are who they say they are.

## Code signing policy

Windows builds are made automatically by GitHub Actions from the code in this repository, using the
[build workflow](.github/workflows/build.yml). Nothing is built or signed by hand.

Free code signing is provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

### Team roles

- Committers and reviewers: [Adfassa89](https://github.com/Adfassa89)
- Approvers (approve every signed release): [Adfassa89](https://github.com/Adfassa89)

### Privacy policy

This program talks to other PCs running LAN Messenger 2 on the same local network, and only to
deliver what the user sends (messages, files, calls, screen sharing, alerts and status) and to share
signed app updates between those PCs. Chats and settings are stored only on the user's own PC.

The only contact with the internet is the update check: the app asks GitHub
(`api.github.com`, this repository's latest release) for the newest version number and, if it is
newer, downloads that signed release. Nothing about the user, their messages or their files is sent.
It happens when the user clicks **Check for updates**, and otherwise every few hours unless
**Settings → Also look for updates on the internet** is switched off.

## License

LAN Messenger 2 is free and open-source software under the [MIT License](LICENSE).
Third-party parts keep their own licenses (see Credits).

## Credits

- Chess pieces: Colin M.L. Burnett ("Cburnett") and Rfc1394, from Wikimedia Commons, licensed
  [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), taken from
  [cm-chessboard](https://github.com/shaack/cm-chessboard). Source: `build/third-party/chess-pieces-cburnett.svg`;
  `scripts/make-pieces.py` turns it into `src/renderer/pieces.css`.
