# LAN Chat Desktop — Next Version

This version adds:

- message persistence on the host server
- delete message support for sender-authored messages
- file and image sending
- desktop notifications for incoming messages and incoming calls
- Electron desktop packaging for Windows using electron-builder

## Architecture

- Electron main process + preload bridge
- React renderer UI
- Built-in local Express + Socket.IO server that can be started in **host mode** on one Windows PC
- Other Windows desktop clients can connect to that host over the same local network
- WebRTC one-to-one calls using Socket.IO signaling

Electron's IPC and preload guidance recommend exposing narrow APIs from preload instead of exposing Node directly to the renderer. Electron's notifications docs show desktop notifications via the main-process `Notification` module, and the notification object must call `show()` to appear. Socket.IO is used for low-latency, bidirectional communication, and WebRTC still requires a signaling step to exchange connection details. Electron-builder can be configured in the top-level `package.json`, and its Windows NSIS target is the standard installer path. Vite uses `base: './'` here so the built renderer can be loaded from `file://` inside Electron. citeturn635199search1turn635199search0turn635199search2turn284549view0turn471858view2turn177992search5turn177992search2turn177992search9turn177992search3

## Features

### Chat
- one-to-one chat
- persistent message history on the host machine
- delete message (sender only)
- file sending
- image sending with preview
- typing indicator
- online presence
- dark Telegram-like layout

### Calls
- one-to-one video calls only
- incoming call prompt
- accept / decline
- mute / unmute
- camera on / off

### Notifications
- message notifications
- file/image notifications
- incoming call notifications

## Local network workflow

### Host machine
1. Launch the desktop app
2. Enable **Host the LAN server on this PC**
3. Click **Enter app**
4. Share the shown LAN URL with other users on the same network

### Client machines
1. Launch the desktop app
2. Leave host mode disabled
3. Enter the server URL from the host machine
4. Enter a display name
5. Click **Enter app**

## First-time setup

You still need package access once for `npm install`, unless your environment already has a local npm cache or registry mirror.

```bash
npm install
```

## Development

### Run the React renderer dev server
```bash
npm run dev:client
```

### Run Electron against the Vite dev server
On Windows PowerShell:
```powershell
$env:ELECTRON_START_URL="http://localhost:5173"
npm run start:desktop
```

If you are not using the dev server, build the renderer first and then start Electron:

```bash
npm run build:client
npm run start:desktop
```

## Windows packaging

Build the Windows installer and portable executable:

```bash
npm run dist:win
```

The packaged outputs are written to:

```txt
release/
```

## Persistence

The host machine stores data under Electron's `userData` directory in:

```txt
lan-chat-data/
```

That includes:
- `db.json` for users and messages
- `uploads/` for transferred files and images

## Security note

This is designed for a trusted local network. Before wider deployment, add stronger auth, rate limiting, and TLS/WSS. Electron's security guide also recommends context isolation and keeping renderer privileges narrow, which this project follows with a preload bridge. citeturn635199search7turn635199search3
