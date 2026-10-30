# FanMate — Taste-Aware K-pop Fan Agent

**Live demo:** _add your Render URL here_ · Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/)

K-pop fans love *"Son Min-soo"*: copying what their idol (their *bias*) wore and visiting the places they went. Korean fans call a friend who helps with this a *dukme* — a fan-mate.

FanMate is that friend, as an agent:

- **Facts from fans** — what idols *actually* wore (brand, product, price, source) and where they *actually* went, from our fan-verified dataset ([Son Min-soo Wiki](https://sonminsoo.kr) + reCree). It never invents idol facts.
- **Taste from Qloo** — the original is ₩1.6M? Qloo's taste graph finds brands with the same taste profile. Planning a pilgrimage in Seongsu? Qloo adds nearby places that fit *your* taste. Love NCT WISH? Qloo suggests artists.
- **Memory** — remembers your biases, budget, sizes, wishlist, what you bought and where you've been, and uses it next time.
- **Multilingual** — English, Korean, Japanese, Simplified/Traditional Chinese.

Neither half works alone: our data has no taste graph, and Qloo doesn't know what Karina wore at the airport.

## Where this is going
We start with K-pop, the most intense "copy my idol" culture in the world. But "what did they wear, where did they go, what fits *me*?" is a question fans of every celebrity, athlete and influencer ask. Sonminsoo Lab already runs an **in-house automated pipeline that collects and verifies "Son Min-soo" data** (items and places tied to a public figure) and feeds Son Min-soo Wiki. FanMate is the consumer layer on top: as the pipeline expands from K-pop to global stars and creators, fans of any star can use the same agent, with Qloo turning each verified fact into recommendations that fit their own taste and budget.

## Try it
- "Show me what Karina from aespa wore"
- "Wonbin's knit vest is over my budget ($50). Find me something with the same vibe"
- "Plan a RIIZE pilgrimage in Seongsu and add places that fit my taste"
- "I love NCT WISH. Which artists should I check out?"
- "Plan me a BTS fan-spot course in Seoul"
- Then: "I bought it!" / "I went to Seongsu yesterday" — and ask again.

## How it works
```
Browser chat ──SSE──► Node server (src/server.ts)
                        └─ Croche agent (src/agent/) — reasoning, long-term memory, expressions
                             ├─ searchItem / findAlternative   → fan-verified items (data/items.json)
                             ├─ findPlaces / planRoute         → fan-verified places (data/places.json)
                             ├─ savePreferences / addWishlist / updateOwned / markVisited → per-user state
                             └─ tasteMatch (src/tools/tasteMatch.ts) → Qloo Taste AI
                                   ├─ /search       resolve brands, places, artists to Qloo entities
                                   ├─ /v2/tags      turn a vibe ("dessert cafe") into tag IDs
                                   └─ /v2/insights  brand / place (location-filtered) / artist recommendations
```
Each answer shows **Fan-verified** cards (our data) and **Qloo taste match** cards (with affinity) separately, so you always know which is a fact and which is a recommendation.

- Qloo client: `src/qloo.ts` (server-side key, `X-Api-Key`, hackathon base URL)
- Agent framework: [Croche](https://github.com/H1R-AI/croche) (tool use + memory)
- Per-visitor isolation, rate limits and tool-call caps for a public demo

## Data
`data/` contains a **public sample** (74 items, 75 places; BTS, IVE, aespa, RIIZE, NCT WISH; Seoul and Busan). The full dataset (600+ items, 500+ places covering 30+ groups, growing through our automated pipeline) is private.

## Run locally
Requires Node 22+.
```bash
npm install
cp .env.example .env    # fill CROCHE_PROJECT_KEY, CROCHE_DEBUG_KEY, QLOO_API_KEY, SESSION_SECRET
npm start               # http://localhost:3000
npm test
```

## Deploy (Render)
`render.yaml` defines one always-on Node web service with a persistent disk (Croche file storage needs a long-running process, so serverless platforms are not used). Set `CROCHE_PROJECT_KEY`, `CROCHE_SERVER_KEY` and `QLOO_API_KEY` in the Render dashboard.

## Team
Sonminsoo Lab — Heeju Choi, Taehee Kim. 1st place, SNU × Croche AI Hackathon 2026.

## License
MIT
