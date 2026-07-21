# 🖥️ DESKTOP SETUP GUIDE — Kalshi Bot (Approval-Gated Version)

Follow every step in order. Don't skip ahead. If something looks different
than described, stop and send a screenshot.

---

## STEP 1: Install Node.js

**What this is:** Software your computer needs to run the bot at all.

1. Go to **https://nodejs.org**
2. Click the **LEFT button** that says **LTS**
3. A file downloads — double-click it to open
4. Click **"Next"** repeatedly until it finishes (defaults are fine)
5. Click **"Finish"**

✅ Done. Node.js is installed.

---

## STEP 2: Make a Folder for the Bot

1. Open **File Explorer**
2. Go to **Desktop**
3. Right-click empty space → **New** → **Folder**
4. Name it exactly: `kalshi-bot`
5. Double-click to open it (it'll be empty)

---

## STEP 3: Put the Bot Files in the Folder

Download these 2 files (they're attached above in this chat):
- `kalshi-automated-bot.js`
- `package.json`

Drag both into your `kalshi-bot` folder.

**Check:** the folder should now show exactly 2 files.

---

## STEP 4: Open Command Prompt Inside That Folder

1. With the `kalshi-bot` folder open, click into the **address bar** at the top (where the folder path is shown)
2. Type `cmd`
3. Press **Enter**

A black window opens. This is the command prompt — it's how you'll talk to the bot.

---

## STEP 5: Install Required Packages

In the black window, type exactly:

```
npm install
```

Press **Enter**. Wait 1-3 minutes — you'll see text scrolling. When it stops and gives you your cursor back, it's done.

---

## STEP 6: Set Your Credentials

Still in the black window, type each line below, pressing **Enter** after each one. Replace the placeholder values with your real ones.

```
set TELEGRAM_TOKEN=8970337520:AAHg6k1DdjL1vnGsecpyCPbw2bYDm2YfvUo
set KALSHI_API_KEY=your_actual_kalshi_key
set KALSHI_API_SECRET=your_actual_kalshi_secret
set YOUR_TELEGRAM_ID=7937830407
set BANKROLL=20
```

**Important on that last line:** `BANKROLL` should be the actual dollar amount you're comfortable trading with — start small. This number controls how big every trade the bot proposes will be (never more than 5% of it per trade). Setting it to `20` means max ~$1 suggested per trade.

⚠️ These `set` commands only last while this window is open. If you close the window, you'll need to retype them next time before running the bot (Step 7 explains a shortcut for that).

---

## STEP 7: Start the Bot

Type:

```
npm start
```

Press **Enter**. Within a few seconds you should see:

```
✅ Bot initialized. Send /start_bot in Telegram to begin scanning.
```

**That means it's running.** Leave this window open — closing it stops the bot.

---

## STEP 8: Turn It On From Telegram

1. Open **Telegram** on your phone
2. Go to your bot's chat
3. Send: `/start`
4. Send: `/start_bot`
5. Send: `/status`

You should get real responses with live BTC/ETH/SOL/DOGE prices.

---

## STEP 9: How Trades Actually Work Now

This bot **never trades on its own.** When it finds something worth flagging, it'll message you in Telegram like this:

```
📊 Opportunity: Bitcoin
Price: $65,420
Drop from recent high: 0.41% (trigger: 0.35%)
Estimated win probability: 58%
Suggested size (Kelly): $2.15

Bet ID: 1720...
/approve 1720...  or  /deny 1720...
```

You reply `/approve [id]` to confirm, or `/deny [id]` to skip it. Nothing happens without you.

**Note:** Real order placement to Kalshi isn't wired up yet in this version — approving a trade currently just logs it and tracks it, so you can watch how the bot's sizing and confidence scoring behaves with zero real money at risk before we connect it to live orders.

---

## KEEPING IT RUNNING

- The bot only runs while that black command prompt window is open and your computer is on.
- You can minimize the window — just don't close it.
- If you restart your computer, redo Steps 4, 6, and 7 (folder → set credentials → npm start).

**Tip to save time next round:** instead of retyping all the `set` lines every time, you can save them into a file called `start.bat` inside the same folder with this content, then just double-click it:

```bat
@echo off
set TELEGRAM_TOKEN=your_token
set KALSHI_API_KEY=your_key
set KALSHI_API_SECRET=your_secret
set YOUR_TELEGRAM_ID=7937830407
set BANKROLL=20
npm start
```

---

## TROUBLESHOOTING

**"node is not recognized"** → Node.js didn't install right. Restart your computer, redo Step 1.

**"npm is not recognized"** → Same fix as above.

**Bot starts but Telegram doesn't respond** → Double-check `TELEGRAM_TOKEN` — retype it carefully, don't guess characters.

**"Cannot find package.json"** → Make sure `package.json` is directly inside `kalshi-bot`, not in a subfolder.

**Nothing happens after `/start_bot`** → That's normal — it only messages you when it finds an opportunity meeting the confidence threshold. Could be minutes between signals.

---

## YOU'RE DONE 🎉

Send `/start_bot` and wait. When something worth looking at comes up, you'll get a Telegram message with the full breakdown, and it's your call from there.
