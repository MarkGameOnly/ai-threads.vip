# Installation Guide

All three builds are in this repository: `extension/` (desktop), `extension-android/`, and `extension-mobile/` (iPhone), plus ready-made packages in `builds/`.

## 💻 Desktop — Chrome, Edge, Arc, Brave

1. Download or clone this repository to a **permanent folder** — not your Downloads folder. Downloads get cleaned out sooner or later, and that's the #1 reason an installed extension "stops working".
2. Open `chrome://extensions` in your browser.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the `extension` folder — the one that directly contains `manifest.json`.
5. Open [threads.com](https://www.threads.com/), log in as usual, click the extension icon, and enter your key (see [Getting a key](./README.md#getting-a-key) in the README).

## 🤖 Android

Standard mobile Chrome doesn't support extensions. Use a Chromium-based Android browser that does, such as **Kiwi Browser** (Play Store).

1. Download `builds/extension-android.zip` and unzip it on your device (or use the `extension-android/` folder from this repo directly).
2. In Kiwi Browser, go to the extensions menu → **Developer mode** → **Load unpacked**.
3. Select the unzipped folder (the one containing `manifest.json`).
4. Open threads.com, log in, tap the extension icon, and enter your key.

## 🍎 iPhone / iPad

Safari and Chrome on iOS don't support browser extensions — that's an iOS platform restriction. You need **[Orion Browser](https://apps.apple.com/app/orion-browser-by-kagi/id1484498200)** (free, from the App Store — search "Orion Browser by Kagi").

1. Download `builds/extension-mobile.crx` from this repo and save it to the **Files** app. **Do not unzip it** — Orion expects the `.crx` file itself.
2. In Orion: tap **•••** → **Extensions** → **+** → **Install from file**.
3. Select `extension-mobile.crx`.
4. If you see an "Extensions error", tap **Cancel** and try again — extension support in Orion is still in beta and usually works on the second attempt.
5. Open threads.com, log in, and tap the extension icon. The panel opens as an overlay on top of the page — there's no browser side panel on mobile.

**What's different on mobile:** scheduled auto-posting needs background timers, which iOS restricts, so the scheduler is reliable only from a desktop browser. DM replies, text generation, and analytics all work normally on mobile.

## Getting your key

1. Open **[@aithreads50_bot](https://t.me/aithreads50_bot)** on Telegram and press **Start** for 50 free generations.
2. In the extension, open ⚙️ **Settings → Account**, enter your Telegram ID and the key/PIN from the bot's "Cabinet" section, then click **Connect**.
3. To go unlimited, upgrade through **[@aithreadsvip_bot](https://t.me/aithreadsvip_bot)**.

## Troubleshooting

- **A metric shows 0, or a button doesn't respond:** Threads changed its markup. Open the panel's 🩺 diagnostic, check the browser console (F12) for the current `aria-label` values, and update them in **Options → Selectors**.
- **Auto-send isn't working on comments/posts/DMs:** check **Options → Selectors → Send labels**, and add whatever label the button currently shows (e.g. "Post", "Reply", "Send").
- **Still stuck:** message **[@aithreads50_bot](https://t.me/aithreads50_bot)** with `/support`, or see the visual walkthrough at **https://ai-threads.vip/install**.

## A note on automation risk

Auto-commenting, auto-posting, and DM replies work by emulating clicks in the Threads interface, which is against Threads' automation rules and can lead to rate limits or a ban. The extension defaults to **draft/review mode** (text is prepared, you press send) with built-in pauses and daily limits — keep them on unless you understand the risk.
