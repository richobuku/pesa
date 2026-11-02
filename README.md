# Pesa — WhatsApp finance agent for the Budget Tracker

Send a WhatsApp message, and the expense lands in the right row of your **Budget Tracker** Google Sheet. Ask how you're spending or how to clear your debts, and it works from your real numbers.

```
you   ›  boda 3k, lunch 13k cash, airtime 5k momo
Pesa  ›  ✅ EX-2611-0109 · 3,000 · Transport & fuel · Cash
         ✅ EX-2611-0110 · 13,000 · Food & groceries · Cash
         ✅ EX-2611-0111 · 5,000 · Airtime & data · Mobile Money
         Personal Use is already 3.2m over across Sep–Oct. Transport alone is 609k this month.

you   ›  🎤 [voice note, 6 sec]
Pesa  ›  🎙️ "Boda three thousand cash, and fifty k to Khiver for food on mobile money"
         ✅ EX-2611-0110 · 3,000 · Transport & fuel · Cash
         ✅ EX-2611-0111 · 50,000 · Food & groceries · Mobile Money

you   ›  [photo of a MoMo receipt]
Pesa  ›  ✅ EX-2611-0112 · 56,800 · Food & groceries · Mobile Money · ref 4424…
         ✅ EX-2611-0113 · 1,000 · Bank & mobile money charges · Mobile Money

you   ›  paid Patrick 500k from bank
Pesa  ›  ✅ EX-2611-0114 · 500,000 · Loan repayment → Patrick Olango Okot · Bank
         Balance now 24,000,000. That's 2 of 25 payments done.

you   ›  if I put 2m a month to debt, when am I free?
you   ›  how did I spend in October?
you   ›  change that to momo  /  undo
```

## What it does

| Capability | How |
|---|---|
| Log expenses, income and transfers | Plain text in any shorthand (20k, 1.5m), several items per message, "yesterday", etc. |
| Voice notes | Speak instead of typing. The reply first shows what it heard, so a misheard amount is obvious. It asks before logging an amount that looks wrong (e.g. "boda 300k"). |
| Read receipts | Photos, MoMo screenshots and PDFs. A transaction fee is logged as a separate expense. |
| Write to your exact layout | It fills only the yellow input columns and leaves every formula alone. If a row's formulas were wiped, it puts them back. It never uses "append", which is what caused the stray row 2 entry and the duplicate codes. |
| Keep your money system | Reads buckets, categories, accounts and lenders live from **Settings** and **Debts**, so a new category you add shows up straight away. |
| Correct mistakes | "undo", "change EX-2611-0105 to 25k", "that was momo". Deleting an older entry needs your confirmation first. |
| Coach you | Month overviews, bucket status, small recurring spends that add up, the biggest items, cash-flow trend, and how much you can realistically put toward debt. |
| Plan your debt payoff | Snowball vs avalanche simulation with your balances, plus "what if" for interest rates, lump sums (per diems, consultancy) and leaving a loan out. |
| Check in on schedule | 20:30 daily "anything unlogged?" and a Sunday 18:00 weekly review. |
| Stay private | Only numbers in `ALLOWED_NUMBERS` get a response. Meta's webhook signature is verified on every request. |

## How it fits together

```
WhatsApp ──► Meta Cloud API ──► /webhook (Render, Node 20)
                                   │
                                   ├─► voice note? → Groq Whisper (or OpenAI) → transcript
                                   │
                                   ├─► Claude (tool use)  ── log_expense / log_income / log_transfer
                                   │                         undo_last / edit_entry / delete_entry
                                   │                         month_overview / cashflow_trend / find_transactions
                                   │                         get_debts / plan_debt_payoff
                                   └─► Google Sheets API (service account) ─► Budget Tracker
```

All the arithmetic happens in code (`src/finance.js`), so the model never adds up numbers in its head.

## Setup (about 45 minutes)

### 1. Google Sheets access
1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create (or pick) a project. Enable the **Google Sheets API**.
2. Go to **IAM & Admin → Service accounts**, create one, then **Keys → Add key → JSON**. Download it.
3. Open the Budget Tracker, click **Share**, and add the service account's email (`…@….iam.gserviceaccount.com`) as an **Editor**.
4. Put the key in `GOOGLE_SERVICE_ACCOUNT_JSON`. Either paste the JSON on one line, or run `base64 -w0 key.json` and paste the output.

### 2. Claude API key
Create a key at [console.anthropic.com](https://console.anthropic.com) and put it in `ANTHROPIC_API_KEY`. The default model is `claude-sonnet-5-5`. You can set `CLAUDE_MODEL=claude-haiku-5-5` to save money, but receipt reading and advice will be weaker.

### 2b. Voice notes (optional, about 3 minutes)
1. Create a key at [console.groq.com](https://console.groq.com) → **API Keys**. Put it in `TRANSCRIBE_API_KEY`.
   - The default model is `whisper-large-v3-turbo`, priced at about $0.04 per hour of audio, so a month of daily notes costs a few cents.
   - Groq accepts WhatsApp's voice-note format directly.
2. To use OpenAI instead, set `TRANSCRIBE_PROVIDER=openai` and use an OpenAI key. The default model is `gpt-4o-mini-transcribe`.
   - If a provider rejects WhatsApp's format, the agent converts the note to MP3 with the bundled ffmpeg and tries again.
3. `TRANSCRIBE_LANGUAGE=en` is the default because it keeps amounts reliable. If you often mix Luo or Swahili with English, set it to blank so the model detects the language itself.
4. To test, save a voice note to your laptop and run `npm run transcribe -- note.ogg`.

The speech model gets a vocabulary hint with your lenders and the payees you've used most in the last 90 days (from the sheet), so names like AGM Solutions or Elephante come out spelled right.

### 3. WhatsApp Cloud API
1. Go to [developers.facebook.com](https://developers.facebook.com), then **My Apps → Create app → Business**. Add the **WhatsApp** product.
2. **API Setup** gives you a free **test number**. Add your personal number as a recipient there. That's enough to start.
   - Later, register a dedicated number (a spare SIM). A number registered on the Cloud API can't also be used in the normal WhatsApp app.
3. Copy the **Phone number ID** into `WHATSAPP_PHONE_NUMBER_ID`.
4. Create a permanent token: in **Business settings → System users**, add a user, assign the app, and generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`. Put it in `WHATSAPP_TOKEN`. The temporary token on the API Setup page expires after 24 hours.
5. Copy **App settings → Basic → App secret** into `WHATSAPP_APP_SECRET`.
6. After deploying (step 4 below), go to **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://<your-render-service>.onrender.com/webhook`
   - Verify token: the same value as `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the **messages** field.

### 4. Deploy on Render
1. Push this folder to a private GitHub repo.
2. In Render, go to **New → Blueprint** and pick the repo. `render.yaml` creates the web service, the two cron jobs and a `pesa-secrets` env group.
3. Fill in the secrets. Set `APP_URL` to the web service's URL once you know it.
4. Open `https://<service>/health`. It should show `{"ok":true,"spreadsheet":"Budget Tracker "}`.

The web service needs an always-on plan (Starter). On the free plan it sleeps, and the first message after a quiet spell would time out.

### 5. Try it locally first (optional)
```bash
cp .env.example .env    # fill in the Google + Anthropic values
npm install
npm run check-sheet     # confirms access and lists data problems
npm run chat            # talk to the agent in your terminal: same brain, same sheet
npm run transcribe -- note.ogg   # check voice-note transcription
npm test                # 25 offline tests
```

## Clean the sheet before go-live

`npm run check-sheet` finds the following in the current workbook. They distort the totals the advice is based on:

1. **Spending row 2** has a stray entry ("Wellsprings Holdings and Hotels, Travel, UGX 8,000") above the header. Delete it.
2. **Spending rows 17–34 and 79** have codes typed over the formula. That caused duplicate codes (e.g. EX-2610-0019 ×3) and `#REF!` in the Ask helper columns. To fix it:
   `npm run repair-formulas` (dry run), then `npm run repair-formulas -- --apply`.
3. **Income rows 15–17** have dates and "Cash" but no amount. Row 15 ("Transport to Alex's farm") is an expense that was logged as income. Clear them.
4. **Transfers row 5** is the template's *EXAMPLE — ATM withdrawal 600,000*, and it's being counted. Delete it.
5. **Some categories don't match the items**, which makes Personal Use look worse and Family look better than they are:
   - Beds, mattresses and bed covers for the boys (1.06m on 31 Oct) are under *Rent / Housing*. They belong in *Household support* (Family).
   - *Bank Charges 127,880* is under *Tithe*. It belongs in *Bank & mobile money charges*.
   - A battery swap is under *Investment*.
   - Claude/Apple subscriptions are under *Transport & fuel* and *Entertainment*.

   Consider adding a **Subscriptions & software** category on Settings.
6. **Debts sheet**:
   - No debt has an interest rate.
   - Shona Capital (165m) and Jos (63m) have no start date. Shona has no monthly plan.
   - The credit card is spelled "ABSA Bank Credut Card". If you fix the spelling, also fix it in past rows.

## Scheduled messages and the 24-hour rule
WhatsApp only lets a business send free-form messages within 24 hours of your last message to it. If you log daily, the 20:30 check-in and the Sunday review arrive normally. For the times you've been quiet:
- Create a **Utility** template in WhatsApp Manager, e.g. name `weekly_review`, body `Your weekly money review: {{1}}`.
- Once it's approved, set `WEEKLY_TEMPLATE_NAME=weekly_review`. The agent falls back to the template automatically.

## Costs to expect
- **WhatsApp**: replies to your own messages are service conversations and are free under Meta's current pricing. Template messages outside the 24-hour window are charged per message. Check Meta's pricing page for Uganda.
- **Claude**: a typical log-and-confirm turn is a few thousand tokens (prompt caching is on). A monthly review is more. Set a monthly spend limit in the Anthropic console.
- **Voice notes**: Groq Whisper Turbo costs about $0.04 per hour of audio, with a 10-second minimum billed per note.
- **Render**: Starter web service plus two small cron jobs.

## Files
```
src/index.js      webhook server, dedupe, per-user queue, cron endpoints
src/agent.js      Claude tool-use loop and short chat memory
src/prompt.js     the agent's personality, logging rules and coaching principles
src/tools.js      tool definitions and handlers (validation against Settings and Debts)
src/sheets.js     Budget Tracker layout, safe row-finding, formula restore, reads
src/finance.js    pure maths: amounts, dates, overviews, leaks, cash flow, debt simulator
src/whatsapp.js   send, templates, media download, signature check
src/transcribe.js voice-note transcription (Groq/OpenAI) with an ffmpeg convert-and-retry fallback
scripts/          chat (terminal), transcribe, check-sheet, repair-formulas, ping (cron)
test/             offline tests with a fake Sheets API laid out like your workbook
```

## Good next steps
- **Register new loans from chat**: write to the Debts adjustments log.
- **Monthly PDF statement** on the 1st, using the month overview.
