# Hackathon notes

Meta hackathon, Indie Developer track. All times Eastern.

**Name:** TailorApps for the public (repo, submission, X posts and handle). Inside the app it is just "Tailor".

## Dates

| When | What |
| --- | --- |
| Oct 27 – Nov 4 | Building period |
| **Nov 4, 9 PM ET** | **Submission deadline. Late entries are not considered.** |
| Nov 5 – 8 | Judging |
| Nov 8 EOD | Most Viral engagement window closes |
| Nov 9, noon | Finals and winners (top 5 per track advance) |
| Nov 16 | Community vote winner |

## Submission checklist

- [ ] One representative submits for the team.
- [ ] **Public repository**, containing only work done during the event (this repo was started Oct 29, 2026, so it qualifies).
- [ ] **3-minute demo video.** If anything was pre-existing, the first line of the video must say so. For Tailor: nothing pre-existing.
- [ ] Every contributor's name.
- [ ] Check that the video and repo links work.
- [ ] Optional: post the demo on X and submit the link (Most Viral, $20k).

## Rules that affect Tailor

- Must use Meta models meaningfully: Meta Model API and/or Meta open-weight models. Tailor uses **only Muse models**, and users never choose a model.
- Theme: **Build for Your World** (a problem you know firsthand) or **Push the Frontier**. Tailor fits Build for Your World.
- Avoid: medical or mental-health advice, basic RAG apps, simple image analyzers, generic education chatbots, job screeners, nutrition or personality analyzers, sports coaches, anything political or war-related. Tailor is none of these.

## Judging (equal weight, after eligibility)

1. Impact
2. Use of Meta AI tooling
3. Technical depth and execution
4. Demo quality

Bonus awards worth aiming at: **Best Agentic Use-Case** ($5k; the Observer, Designer, Builder and Tester pipeline), Most Viral ($20k), Community Vote ($10k), Best Creative Build ($5k), Best Build on Meta Open Weight Models ($10k; would need Muse Spark Open, e.g. Baseten `meta-models/muse-spark-open-1026`).

## Models available

Through the Meta Model API: Muse Spark, Muse Wonder, Muse Image, Muse Voice Transcribe, SAM 3.1. Open weights: Muse Glimmer, Muse Spark Open. Muse Code helps with coding.

What Tailor uses (set in the backend, `backend/supabase/functions/tailor/index.ts`):

| Agent | Job | Model |
| --- | --- | --- |
| Observer | Turns counted activity signals into patterns | `muse-spark-1.3`, low reasoning (frequent, structured) |
| Designer | Ideation: suggests apps from patterns and feedback | `muse-wonder-1.0`, high reasoning (the most capable model, used rarely) |
| Builder | Writes and fixes the app | `muse-wonder-1.0`, high reasoning |
| Tester | Uses the finished app as its intended person would, before it ships | `muse-spark-1.3`, medium reasoning (many quick steps) |

## Credits and billing

- $150 Meta Model API credits per approved participant. Claim by Nov 4, 9 PM ET, using the application email and the numeric `team_id` from the dev.meta.ai URL.
- A card is required. **Spend Limit alerts do not stop billing.** Tailor's backend caps requests per user per day (`TAILOR_DAILY_LIMIT`, default 300) and across all users per day (`TAILOR_GLOBAL_DAILY_LIMIT`, default 3000), so a public demo can't drain the credits.
- Support: https://dev.meta.ai/support. Office hours in #office-hours, weekdays 10–11 AM ET.
