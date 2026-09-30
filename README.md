# APEX-UI

An animated **autonomous-agent orb + reasoning-graph** interface — the front-end of
[Apex](https://reznikov-engineering.com/apex), released open source.

Tap the orb to cycle its state (idle → thinking → speaking); the reasoning web reacts,
agent nodes orbit the core, and clicking any node opens an overview card. The orb ring,
agent graph and status bar are **hand-written SVG / CSS**; the cyan particle core is a
small `react-three-fiber` scene (skipped under `prefers-reduced-motion`); and the WebGL
shader backdrop + the overview lamp panel are **MIT community components from
[21st.dev](https://21st.dev/community/components)** (see [CREDITS](./CREDITS.md)).

> ⚠ **The Apex Humanoid is NOT part of this repo.** The particle-figure face of Apex
> (assembly, states, voice-driven energy) lives in a separate repository with its own
> access - what you see here is the orb + reasoning-graph interface only.

> Built with Next.js 15 + React 19. Runtime deps: `lucide-react` (icons) and
> `three` / `@react-three/fiber` / `@react-three/postprocessing` (the particle core) —
> all MIT-licensed.

## Live demo

**[apex-ui-xi.vercel.app](https://apex-ui-xi.vercel.app)** - the same code, running.
Tap the orb.

## Run it yourself

```bash
npm install
npm run dev
# open http://127.0.0.1:3000   (the server only listens on this machine)
```

Requirements: Node 22.5+ (built-in `node:sqlite`), and at least one AI CLI logged in:
`claude` (Claude Code, Claude Pro/Max) and/or `codex` (Codex CLI, ChatGPT account).
No API key is needed — Apex runs on your subscriptions.

## The Apex backend

This fork adds a working backend behind the interface, rebuilt from what the UI and the
author's public course describe: a **Chief of staff** that routes every request to
specialist agents, long-term **memory**, a local **CRM**, **loops** (scheduled agent jobs),
and outbound work that always **needs your approval and returns evidence**.

```
browser (orb · agent web · chat dock · Command Deck)
   │  POST /api/chat → NDJSON events: state · token · trace · job · action
   ▼
Chief of staff  = claude / codex CLI + MCP bridge (lib/mcp/apex-mcp.mjs)
   │  tools: memory_* crm_* tasks_* projects_* finance_* analytics_* gmail_* calendar_* drive_*
   │         delegate_to_<specialist>   propose_<action>   loops_*
   ├─► specialists (Strategist, Researcher, Finance, Editor, Sales, Marketing, Ops,
   │    Social, Engineering, Design, Developer, Analytics) — one level deep, each with its own tools
   └─► SQLite  data/apex.db  (memory, clients/leads/payments, projects/tasks, jobs, actions,
                              loops, call log, guide versions, OAuth tokens)
```

- **Talk:** tap the orb (voice, Chrome, Czech) or type in the dock. The agent web lights up
  live with every tool call and delegation (`trace` events drive `ReasoningWeb`).
- **Agent cockpit:** click any node — real status (no fake green lights), its recent jobs,
  and example requests you can send with one click.
- **Command Deck** (dock → Deck): approvals, jobs, CRM pipeline, loops, memory, the owner's
  guide (versioned instructions every agent follows), integrations, and the LLM call log.
- **Approvals & evidence:** agents never send mail, create events or publish posts
  themselves. They call `propose_*`; you review/edit and approve in the Deck; only then does
  the action run, and the provider's id/link is stored as evidence. No evidence → not done.
- **Loops:** morning brief, weekly strategy review, lead follow-ups — off by default; toggle
  and schedule them in the Deck (`daily 08:00`, `weekly mon 09:00`, `every 30m`). A loop runs
  at most once per period, even across restarts.
- **Providers:** Claude and ChatGPT/Codex get the full agent system. Gemini and the paid API
  providers are chat-only.

### Google setup (Gmail, Calendar, Drive)

1. [Google Cloud Console](https://console.cloud.google.com) → new project.
2. APIs & Services → Library → enable **Gmail API**, **Google Calendar API**, **Google Drive API**.
3. OAuth consent screen → External, Testing → add your own account under *Test users*.
4. Credentials → OAuth client ID → **Web application**, redirect URI exactly
   `http://127.0.0.1:3000/api/integrations/google/callback`.
5. Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` into `.env.local`, restart `npm run dev`.
6. Open `http://127.0.0.1:3000` → Deck → Integrace → *Připojit Google*.

Agents can then read mail, calendar and Drive and write Gmail drafts; sending mail and
creating events still go through approval.

### Social networks

Set the tokens from `.env.local.example`: a Facebook Page token (+ Instagram Business user id)
from a Meta developer app, and a LinkedIn token with `w_member_social`. Social drafts posts
without them; publishing happens only after approval.

### Natural voice

Listening and speaking use the browser by default. Add `ELEVENLABS_API_KEY` (what the
original Apex used) or `OPENAI_API_KEY` to `.env.local` for a natural voice.
"Voice off" stops the TTS requests entirely, not just the sound.

### Security

- The server binds to `127.0.0.1`; every route rejects non-local hosts and cross-site
  browser requests (CSRF / DNS rebinding). The internal tools API also needs a per-process
  secret that only the spawned MCP bridge knows.
- Agent CLIs run in an empty temp dir: Claude with only Apex tools (+ web search for
  research roles), Codex in a read-only sandbox.
- Mail, web pages and files are wrapped as untrusted data; outbound actions need your click.
- OAuth tokens live only in `data/apex.db` (git-ignored) and never reach the browser.

## What's inside

| Piece | What it does |
|-------|--------------|
| `ApexOrb` | The golden ring frame, waveform and orbit dots (pure SVG) |
| `ApexCore3D` | The cyan particle core (`react-three-fiber` + bloom) |
| `ApexHeroOrb` | Stacks the SVG ring + the particle core, scaled to fit |
| `ReasoningWeb` | The agent constellation — circuit traces, orbit rings, 18-node roster |
| `OrbStatusBar` | The equalizer + STANDBY cluster along the bottom |
| `ShaderBackground` | Animated WebGL "plasma waves" backdrop (MIT component from 21st.dev — see CREDITS) |
| `ApexWorld` | Composes the above; owns the tap-state cycle and the agent overview cards |
| `ApexOverviewPanel` | Top-left HUD: live clock, weather, and social links |
| `app/api/weather` | Keyless [open-meteo](https://open-meteo.com) proxy for the panel's weather |

## Customise

- **Social links** → edit `TILES` in `components/ApexOverviewPanel.tsx`.
- **Weather** → auto-detects the **visitor's** city on Vercel (geo headers); edit `FALLBACK` in `app/api/weather/route.ts` to change the off-Vercel / localhost default.
- **Agents & copy** → `lib/roster.ts` (names, roles, example requests); personas and tool permissions in `server/agents.ts`; how Apex behaves for you → Deck › Pokyny.
- **Backdrop** → the shader in `components/ShaderBackground.jsx`; its opacity/tint are set where `<ShaderBackground>` is used in `ApexWorld.tsx`.

## Accessibility

The decorative SVG graph is mirrored by a real, keyboard-navigable agent list
(`.visually-hidden`), the orb and every control are focusable, and the whole thing
respects `prefers-reduced-motion`.

## Not included (on purpose)

This repo is the **UI only**. The production Apex page also has a spoken-voice layer and a
"story" narrative — those are personal recordings and private copy, so they are intentionally
left out. The orb stays fully interactive without them.

## License

Code is released under the **[MIT License](./LICENSE)** — use it, fork it, ship it.

The **name "Apex" and the Reznikov Engineering branding are not part of this license.**
If you build on this, please use your own product name and branding.

---

Made by [Ruben Mouradian — Reznikov Engineering](https://reznikov-engineering.com).
If you use it, a link back is appreciated (not required).
