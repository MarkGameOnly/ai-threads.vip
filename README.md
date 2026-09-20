# AI Threads VIP — Browser Extension

Growth toolkit for [Threads](https://www.threads.com/): AI-generated replies, post scheduling, a "client hunter" lead finder, DM automation, and viral-post analytics — with a chat-driven side panel you talk to in plain language.

- 🌐 Website: **https://ai-threads.vip**
- 🤖 Free trial bot (50 free generations): **[@aithreads50_bot](https://t.me/aithreads50_bot)**
- 💎 VIP bot (paid plan, unlimited): **[@aithreadsvip_bot](https://t.me/aithreadsvip_bot)**
- 📣 Updates channel: **[@ai_threads_vip](https://t.me/ai_threads_vip)**

## What it does

- **💬 Chat brain (side panel):** tell it what to do in plain language — "scrape the feed", "find clients", "analyze @nickname", "start commenting", "generate a post about X", "run the hunter" — and it calls the right tool for you.
- **🕵️ Client Hunter:** a 5-step flow — builds search hypotheses for your business, collects results across all queries, keeps fresh unique threads, runs strict AI qualification to rank top leads, then goes and comments on them to softly promote you.
- **🔎 Real-metric parsing:** likes, comments, reposts, and shares pulled from the live page (not zeros). Post count is configurable (50 by default, can be increased).
- **📄 Viral posts table:** sortable, with a "Viral only" filter and a "✍ Rewrite in my style" button that rewrites a trending post to match your voice.
- **🎯 Leads table:** scored leads with the reason they're a fit and a suggested opener; one click generates a comment.
- **💬 Auto-commenting:** automatic / manual / text-only modes, with built-in prompt presets. Comments are kept short (about one sentence, ~150 characters).
- **📝 Scheduled posting:** a queue of topics, with morning/day/evening/night time slots.
- **✉️ DM replies (experimental):** drafts natural, human-sounding DM replies for your approval before sending.
- **📎 Media posts:** attach a photo/video with a short caption.
- **✦ One-click comment generation** button on every post in the feed.
- Dark UI throughout, with optional Telegram notifications for new leads.

## Builds included

| Folder | Platform | How to install |
|---|---|---|
| [`extension/`](./extension) | Desktop — Chrome, Edge, Arc, Brave | Unpacked, via `chrome://extensions` |
| [`extension-android/`](./extension-android) | Android (Chrome-based browsers that support extensions, e.g. Kiwi Browser) | Unpacked or the packaged build in `builds/` |
| [`extension-mobile/`](./extension-mobile) | iPhone/iPad (via the [Orion Browser](https://apps.apple.com/app/orion-browser-by-kagi/id1484498200)) | `.crx` file from `builds/`, "Install from file" in Orion |

Prebuilt, ready-to-install packages (`.zip` and `.crx`) for all three are in [`builds/`](./builds).

See **[INSTALL.md](./INSTALL.md)** for step-by-step setup on each platform.

## Getting a key

1. Open **[@aithreads50_bot](https://t.me/aithreads50_bot)** on Telegram and press **Start** — you get 50 free generations to try it.
2. Open the extension's options (⚙️ icon), enter your Telegram ID and the key from the bot's "Cabinet" section, and click **Connect**.
3. When your free generations run out, upgrade via **[@aithreadsvip_bot](https://t.me/aithreadsvip_bot)** for unlimited use.

## Honest notes on automation

Threads occasionally changes its markup. Metrics and buttons are read via `aria-label` and on-screen text; if something reads as zero or a button doesn't respond, open the panel's 🩺 diagnostic, check the console (F12) for the current `aria-label`s, and update the selectors in **Options → Selectors**.

Auto-commenting and auto-posting emulate clicks on the Threads UI, which goes against the platform's automation rules and carries a risk of rate limits or a ban. By default the extension runs in **draft/review mode** — text is filled in but you send it — and includes pauses and daily limits. Use them.

## Project structure

```
src/shared/      ai.js, telegram.js, storage.js — shared clients, presets
src/background/  service-worker.js — message relay + storage
src/content/     threads-dom.js (metrics/parsing), threads-rpc.js (automation engine),
                 threads-panel.js (in-feed ✦ button and HUD)
src/sidepanel/   panel.* — the chat brain, tools.js, tab-control.js
src/options/     settings and presets UI
src/popup/       toolbar popup
```

## Support

Questions or issues: message **[@aithreads50_bot](https://t.me/aithreads50_bot)** with `/support`, or see **https://ai-threads.vip/install** for a walkthrough with screenshots.
