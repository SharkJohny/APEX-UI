"use client";

import { useEffect, useSyncExternalStore } from "react";

/* Is the Apex window the one the owner is looking at? The decorative
 * animations (WebGL backdrop, 3D orb, reasoning web, CSS loops) stop when it
 * isn't - they kept Chrome's GPU process busy all day. Voice keeps working. */
export const isWindowActive = (): boolean =>
  typeof document === "undefined" || (!document.hidden && document.hasFocus());

export function onWindowActiveChange(cb: (active: boolean) => void): () => void {
  const fire = () => cb(isWindowActive());
  window.addEventListener("focus", fire);
  window.addEventListener("blur", fire);
  document.addEventListener("visibilitychange", fire);
  return () => {
    window.removeEventListener("focus", fire);
    window.removeEventListener("blur", fire);
    document.removeEventListener("visibilitychange", fire);
  };
}

export function useWindowActive(): boolean {
  return useSyncExternalStore(onWindowActiveChange, isWindowActive, () => true);
}

/* Pauses every CSS animation on the page while the window is inactive
 * (see html[data-apex-inactive] in globals.css). Mount once. */
export function usePauseCssWhenInactive(): void {
  const active = useWindowActive();
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.removeAttribute("data-apex-inactive");
    else root.setAttribute("data-apex-inactive", "");
  }, [active]);
}
