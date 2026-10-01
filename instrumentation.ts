/* Node 25 exposes a global `localStorage` whose methods are missing unless
 * started with --localstorage-file. Next's server code sees the global and
 * crashes on `localStorage.getItem`, so drop the broken stub at startup.
 * On the Node runtime also register all tools and start the loop scheduler. */
export async function register() {
  const g = globalThis as { localStorage?: { getItem?: unknown } };
  if (typeof g.localStorage !== "undefined" && typeof g.localStorage?.getItem !== "function") {
    delete g.localStorage;
  }
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      (await import("./server/settings")).applySettings();
      await import("./server/tools");
      const { startScheduler } = await import("./server/loops");
      startScheduler();
      const { startSemanticIndexer } = await import("./server/semantic");
      startSemanticIndexer();
      const { startRaqetoQueue } = await import("./server/raqetoQueue");
      startRaqetoQueue();
      const { startChatSync } = await import("./server/chatSync");
      startChatSync();
      const { startAiccWatch } = await import("./server/aiccWatch");
      startAiccWatch();
    } catch (e) {
      console.error("[apex] scheduler start failed:", e);
    }
  }
}
