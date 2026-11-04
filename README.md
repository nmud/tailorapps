# TailorApps

**You can't prompt what you don't know.** Tailor learns how you work, notices what slows you down, and builds the small apps you'd never think to ask for, using four Meta Muse agents.

**[Demo video](YOUTUBE_LINK)** · **[Download for Windows](https://github.com/nmud/tailorapps/releases/latest/download/TailorApps-Setup.exe)** · [Mac (experimental)](https://github.com/nmud/tailorapps/releases/latest/download/TailorApps-mac.dmg) · [Website](https://tailorapps-zeta.vercel.app)

*TailorApps is the project. On your computer, the app is simply called **Tailor**.*

Every AI app builder starts with a prompt, which only helps people who already know what software they need. Tailor starts from what you actually do. It explains each idea with something it counted, never something a model made up:

> *You copied from Snippingtool to Terminal 16 times, in 7 of your last 15 work sessions.*
> → **Snip Fixes**: each screenshot becomes a fix to tick off.

## Hackathon

| | |
| --- | --- |
| Event | Meta Global AI Developer Hackathon, 2026 |
| Track | Indie Developer |
| Problem statement | Build for Your World |
| Built | From scratch during the event, Oct 29 to Nov 4, 2026 (the repo starts Oct 29) |
| Team | Raymond House (solo) |
| Meta models | Muse Spark (`muse-spark-1.3`) and Muse Wonder (`muse-wonder-1.0`) through the Meta Model API |

## Download

- **Windows 10 and 11:** [TailorApps-Setup.exe](https://github.com/nmud/tailorapps/releases/latest/download/TailorApps-Setup.exe). The installer isn't signed yet, so if Windows doesn't recognise it, choose **More info**, then **Run anyway**.
- **Mac, Apple Silicon (experimental):** [TailorApps-mac.dmg](https://github.com/nmud/tailorapps/releases/latest/download/TailorApps-mac.dmg). It's unsigned, so the first time, right-click the app and choose **Open**. On Mac, Tailor learns from websites only (through the browser add-on), and building apps needs Node 20+ installed.
- **Browser add-on** (Chrome or Edge): Tailor's onboarding walks you through loading it.

## What it does

1. **Learns how you work, with permission.** You choose what it may see: websites (browser add-on) and apps on this computer. It never reads what you type or copy.
2. **Notices friction, in code.** It counts repetition (copying between the same two places, switching back and forth) and clutter (piles of tabs, windows or AI tools).
3. **Suggests small apps** and says why, with that evidence and exactly what each app could see or reach. Make it, change it, or say "not for me". Tailor remembers either way.
4. **Builds and tests the app.** The Builder fixes its own build and runtime errors. Then the Tester uses the app the way you would, clicking and typing in a hidden copy, and sends problems back before you see it.
5. **Hands you a real app**, with its own window and icon. On Windows it also gets a taskbar button and a Start menu entry. Each app is sealed off and can reach only the sites you approved.
6. **Works toward your goals.** Write one in plain words ("spend less time in AI chats"). Progress is counted, and new ideas aim at it.

## How it uses Meta's models

Everything runs on Muse. People never pick a model: the backend assigns one per agent (`backend/supabase/functions/tailor/index.ts`).

| Agent | Job | What it sees | Model |
| --- | --- | --- | --- |
| Observer | Names patterns in the counted signals, by signal id | A digest of counts and titles | `muse-spark-1.3`, low reasoning |
| Designer (ideas) | Streams idea cards, parsed as each JSON object completes | Patterns, a short profile, your feedback | `muse-spark-1.3`, low reasoning |
| Designer (plan) | Writes the full buildable spec for the idea you choose | The chosen idea | `muse-wonder-1.0`, high reasoning |
| Builder | Writes a multi-file React app and fixes build and runtime errors (up to 3 and 2 rounds) | Only the approved spec | `muse-wonder-1.0`, high reasoning |
| Tester | Role-plays you and drives the real app, one action per step (up to 14) | The spec and the app's screen | `muse-spark-1.3`, medium reasoning |
| Goals | Picks which apps and sites a goal should count | Your goal and names of apps and sites seen | `muse-spark-1.3` |

- **Spark where speed matters, Wonder where quality does.** Wonder took about 36 s for three idea cards, so Spark streams them (first card in about 7 s) and Wonder plans only the app you pick.
- **API features used:** strict `json_schema` structured output, streaming with usage reporting, `reasoning_effort` per agent, and `max_completion_tokens` caps. If a model rejects an optional feature, the client retries without it.
- **Evidence is counted, not generated.** Sessions, copy and paste flows, switching and clutter are computed in `tailor/src/agents/digest.ts`. Models only refer to signals by id, so the numbers you see are never invented.

**Measured** on the labelled sample week: first ideas about 25 s after loading the week, a tested app about 4 minutes after clicking Make, and about $2 in Muse usage for a whole session.

## How it works

```
Browser add-on ─┐
App collector  ─┴─> local history ──> signals counted in code ──> short summary ─┐
                    (SQLite, stays on                                            │
                     your computer)                                              v
                                                  Supabase edge function: holds the Muse key, $ caps
                                                                                 │
                                                                                 v
                                                  Meta Model API: Muse Spark, Muse Wonder
                                                                                 │
sealed app at <app>.localhost:48100 <── Vite build on your computer <── app code ┘
```

- **Desktop app:** Tauri 2 (Rust) with a React and TypeScript front end. Activity, patterns and ideas live in a local SQLite database, and each app is built in a local workspace.
- **Backend:** one Supabase edge function, the only place the Muse key exists. Every call is priced from its token counts and the worst case is reserved before the request goes out, against budgets per person per day, per day, and in total, because spend-limit alerts don't stop billing.
- **Generated apps:** each runs in a sealed frame at its own address with no access to Tailor, and a CSP that blocks the network unless you approved a host. Approved sites are fetched through Tailor (GET only, those hosts only, no cookies). Live data such as open tabs or AI tool names is off unless the idea asked for it and you saw that before making it.

## Privacy

| | |
| --- | --- |
| Off until you say so | Learning stays off until you turn it on, and you choose websites, apps, or both. |
| Never collected | What you type or copy. Password managers, banking and sign-in pages are skipped. Mail and chat keep only the app or site name. Emails, long numbers and tokens are scrubbed. Private windows are ignored. |
| What leaves your computer | Only short counted summaries, sent for ideas. History stays local, 30 days by default. |
| You can see and delete it | The Learning page shows everything recorded, what Tailor noticed, and what you told it. Each item can be deleted. |
| Sign-in | Supabase Auth. The refresh token is kept in Windows Credential Manager (or the macOS Keychain); the access token stays in memory and never reaches the page. |

## Build from source

**Desktop app.** You need Node 20+ and Rust. On Windows, also the Visual Studio C++ Build Tools; on Mac, the Xcode command line tools.

```sh
cd tailor
npm install
npm run tauri dev                 # run in development
npx tauri build                   # Windows installer: src-tauri/target/release/bundle/nsis/
npx tauri build --bundles app     # Mac app (experimental): src-tauri/target/release/bundle/macos/
```

By default the app talks to the hosted backend. To use your own, set `TAILOR_SUPABASE_URL` and `TAILOR_SUPABASE_KEY` (the publishable key) when building.

**Backend** (Supabase CLI):

```sh
cd backend
supabase init                             # only if the CLI asks for a config
supabase link --project-ref <your-project>
supabase db push                          # usage limits and the dollar budget (supabase/migrations)
supabase functions deploy tailor
supabase secrets set MUSE_API_KEY=<your Meta Model API key>
```

Optional settings: `TAILOR_BUDGET_USD` (default 140), `TAILOR_BUDGET_DAY_USD` (40), `TAILOR_BUDGET_USER_DAY_USD` (5), `TAILOR_DAILY_LIMIT` (300 requests per person), and `MUSE_MODEL_OBSERVER` / `_DESIGNER` / `_BUILDER` / `_TESTER` to swap models.

**Browser add-on:** open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, choose **Load unpacked**, then pick the `extension/` folder.

**Releasing an update:** bump `version` in `tailor/package.json` and build again. Installing the new version updates Tailor in place and keeps everyone's data. Never change `identifier` (`com.tailor.desktop`) or `productName` (`Tailor`) in `tauri.conf.json`, or the installer will put in a second copy instead. The Mac build is made by `.github/workflows/mac.yml` and attached to the release.

## Try it in two minutes

1. Sign up, then choose what Tailor may learn from.
2. No history yet? **Learning → Load the sample** loads a labelled, made-up week, which you can remove at any time.
3. **Ideas:** pick one, read why, then **Make this app**. Watch Planning, Building, Trying it out. Open **Show details** to see the Tester at work.
4. **Want something different?** Ask for one change in plain words.
5. **Add to My apps**, then **Open**. On Windows, it's in the Start menu too.

## Project layout

```
backend/supabase/functions/tailor/   sign-up and the Muse proxy (models, caps, dollar budget)
backend/supabase/migrations/         usage limits and spend tables
tailor/src/agents/                   digest (counted signals), observer, designer, builder, tester, goals
tailor/src/views/                    Ideas, Goals, Building, My apps, Learning, Settings
tailor/src-tauri/src/                collector, privacy floor, add-on endpoint, app server, workspace builds
tailor/src-tauri/resources/workspace app template, app kit, runtime and test harness
extension/                           Chrome and Edge add-on
website/                             the landing page
video/                               demo video script and edit
docs/HACKATHON.md                    rules, dates, judging, model choices
```

## Limitations

- **Mac is experimental.** It learns from websites only (no app or window collector yet), needs Node 20+ already installed to build apps (Windows downloads its own), is unsigned, and doesn't yet have the extra lock that keeps app frames on their own addresses (that one uses WebView2 on Windows).
- The Windows installer isn't code-signed yet.
- One local database per computer: signing in as someone else on the same computer shows the same local history and apps.
- Generated apps can use React, React DOM and lucide-react, plus the approved data feeds.
