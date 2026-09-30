/* Voice configuration, read from process.env at call time (Settings writes
 * into process.env, so a change applies on the next request). Shared by
 * /api/providers, /api/tts, /api/stt and /api/realtime/session.
 * Defaults follow the OpenAI docs (developers.openai.com, 2026-09):
 * TTS gpt-4o-mini-tts (the model that accepts `instructions`), transcription
 * gpt-transcribe, Realtime gpt-realtime-2.1 with voice marin, realtime input
 * transcription gpt-live-transcribe. */

export type VoiceMode = "browser" | "openai" | "realtime";
export type SttMode = "browser" | "openai";
export type TtsEngine = "elevenlabs" | "openai" | "browser";

export const OPENAI_DEFAULTS = {
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "marin",
  sttModel: "gpt-transcribe",
  realtimeModel: "gpt-realtime-2.1",
  realtimeVoice: "marin",
  realtimeTranscribeModel: "gpt-live-transcribe",
};

export const NO_OPENAI_KEY_HINT = "Chybí OpenAI API klíč – vlož ho v Nastavení (ozubené kolo v panelu konverzace).";
const NO_ELEVEN_KEY_HINT = "Chybí ElevenLabs API klíč – vlož ho v Nastavení. Zatím mluvím hlasem prohlížeče.";

const env = (k: string) => (process.env[k] || "").trim();

export function hasOpenAiKey(): boolean {
  return !!env("OPENAI_API_KEY");
}

export function voiceMode(): VoiceMode {
  const v = env("APEX_VOICE_MODE").toLowerCase();
  return v === "openai" || v === "realtime" ? v : "browser";
}

/* Speech-to-text engine actually used for the mic in browser/openai modes.
 * Browser mode always keeps the browser recognizer (current behaviour). */
export function resolveStt(mode: VoiceMode = voiceMode()): { stt: SttMode; hint?: string } {
  if (mode !== "openai" || env("APEX_STT").toLowerCase() !== "openai") return { stt: "browser" };
  if (!hasOpenAiKey()) return { stt: "browser", hint: `Přepis řeči přes OpenAI nejde spustit. ${NO_OPENAI_KEY_HINT}` };
  return { stt: "openai" };
}

/* Server TTS engine. auto = ElevenLabs > OpenAI > browser by available key;
 * in "openai" voice mode auto prefers the OpenAI voice. An explicit choice
 * whose key is missing falls back to the browser voice with a hint. */
export function resolveTts(mode: VoiceMode = voiceMode()): { tts: TtsEngine; hint?: string } {
  const eleven = !!env("ELEVENLABS_API_KEY");
  const openai = hasOpenAiKey();
  const pick = env("APEX_TTS").toLowerCase();
  if (pick === "browser") return { tts: "browser" };
  if (pick === "openai") return openai ? { tts: "openai" } : { tts: "browser", hint: `OpenAI hlas nejde použít. ${NO_OPENAI_KEY_HINT}` };
  if (pick === "elevenlabs") return eleven ? { tts: "elevenlabs" } : { tts: "browser", hint: NO_ELEVEN_KEY_HINT };
  if (mode === "openai" && openai) return { tts: "openai" };
  return { tts: eleven ? "elevenlabs" : openai ? "openai" : "browser" };
}

export function openAiTtsConfig() {
  return {
    model: env("OPENAI_TTS_MODEL") || OPENAI_DEFAULTS.ttsModel,
    voice: env("OPENAI_TTS_VOICE") || OPENAI_DEFAULTS.ttsVoice,
  };
}

export function openAiSttModel(): string {
  return env("OPENAI_STT_MODEL") || OPENAI_DEFAULTS.sttModel;
}

export function openAiRealtimeConfig() {
  return {
    model: env("OPENAI_REALTIME_MODEL") || OPENAI_DEFAULTS.realtimeModel,
    voice: env("OPENAI_REALTIME_VOICE") || OPENAI_DEFAULTS.realtimeVoice,
  };
}

/* OpenAI error bodies are {"error":{"message":...}}; never echo headers/keys. */
export async function openAiError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message;
    if (msg) return msg.slice(0, 300);
  } catch { /* not JSON */ }
  return raw.slice(0, 300) || `HTTP ${res.status}`;
}
