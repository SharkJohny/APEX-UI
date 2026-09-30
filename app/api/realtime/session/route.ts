import { NextResponse } from "next/server";
import { isLoopback } from "@/lib/localOnly";
import { NO_OPENAI_KEY_HINT, OPENAI_DEFAULTS, hasOpenAiKey, openAiError, openAiRealtimeConfig } from "@/server/voiceConfig";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* POST {} → { value, expiresAt, model, voice }: a short-lived OpenAI Realtime
 * client secret (POST /v1/realtime/client_secrets) for the browser's WebRTC
 * call (POST /v1/realtime/calls). The real API key never leaves the server.
 * The realtime model is only Apex's voice: anything needing data or actions
 * goes through the ask_apex function tool, which the browser answers by
 * running a normal Apex turn (/api/chat - agents, CRM, vault, approvals). */

const INSTRUCTIONS = [
  "Jsi hlas Apexe – osobního AI asistenta majitele firmy. Mluvíš výhradně česky, přirozeně, stručně a věcně, jako zkušený asistent; krátké věty, žádné odrážky ani čtení formátování.",
  "Cokoli, co se týká majitelovy firmy, klientů, CRM (Raqeto), kalendáře, e-mailů, paměti či vaultu (AI Mozek), úkolů, projektů, financí, rešerší nebo jakékoli akce, NEŘEŠ sám: zavolej nástroj ask_apex s úplným, samostatně srozumitelným požadavkem v češtině (včetně jmen, dat a kontextu z rozhovoru). Než ho zavoláš, řekni krátce, že se podíváš (např. „Moment, zjistím to.“).",
  "Odpověď z ask_apex pak řekni přirozeně a stručně vlastními slovy – shrň podstatné, nečti dlouhé seznamy celé, zeptej se, jestli chce detail.",
  "Nikdy netvrď, že se něco stalo (odeslal e-mail, vytvořil událost, zapsal do CRM…), pokud to ask_apex výslovně nepotvrdil. Odchozí akce (e-maily, pozvánky, příspěvky, faktury) se jen navrhují a čekají na schválení majitelem v Command Decku – tak to i řekni.",
  "Když si nejsi jistý, co majitel chce, krátce se doptej. Drobnou konverzaci (pozdrav, obecné otázky) zvládni sám bez nástroje.",
].join("\n");

const ASK_APEX = {
  type: "function",
  name: "ask_apex",
  description:
    "Předá požadavek Apexovi (hlavní mozek s agenty, CRM Raqeto, kalendářem, poštou, pamětí/vaultem, úkoly, rešeršemi a návrhy akcí ke schválení) a vrátí jeho odpověď. Použij pro vše, co potřebuje data nebo akci.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "Úplný požadavek v češtině, srozumitelný bez dalšího kontextu." },
    },
    required: ["request"],
  },
};

export async function POST(request: Request) {
  if (!isLoopback(request)) return NextResponse.json({ error: "local only" }, { status: 403 });
  if (!hasOpenAiKey()) return NextResponse.json({ error: `Plný hlasový rozhovor (Realtime) nejde spustit. ${NO_OPENAI_KEY_HINT}` }, { status: 400 });

  const { model, voice } = openAiRealtimeConfig();
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    signal: request.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      // The secret is only needed to open the call; the call itself outlives it.
      expires_after: { anchor: "created_at", seconds: 120 },
      session: {
        type: "realtime",
        model,
        instructions: INSTRUCTIONS,
        output_modalities: ["audio"],
        audio: {
          input: {
            transcription: { model: OPENAI_DEFAULTS.realtimeTranscribeModel, languages: ["cs"] },
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice },
        },
        tools: [ASK_APEX],
        tool_choice: "auto",
      },
    }),
  }).catch((e: unknown) => e as Error);
  if (res instanceof Error) return NextResponse.json({ error: `OpenAI nedostupné: ${res.message}` }, { status: 502 });
  if (!res.ok) return NextResponse.json({ error: `OpenAI Realtime odmítl vytvořit relaci (HTTP ${res.status}): ${await openAiError(res)}` }, { status: 502 });
  const data = (await res.json().catch(() => ({}))) as { value?: string; expires_at?: number };
  if (!data.value) return NextResponse.json({ error: "OpenAI nevrátilo klíč relace." }, { status: 502 });
  return NextResponse.json(
    { value: data.value, expiresAt: data.expires_at, model, voice },
    { headers: { "cache-control": "no-store" } },
  );
}
