#!/usr/bin/env node
/* Installs (or with --remove uninstalls) a LaunchAgent that starts the Rambox
 * bridge at login, so Rambox always runs with the pipe Apex reads through.
 * Rambox's own "start at login" may stay on - the bridge takes it over. */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.apex.rambox-bridge";
const here = dirname(fileURLToPath(import.meta.url));
const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
if (process.argv.includes("--remove")) {
  rmSync(plist, { force: true });
  console.log("LaunchAgent odstraněn.");
  process.exit(0);
}

const logFile = join(here, "..", "..", "data", "rambox-bridge.log");
mkdirSync(dirname(plist), { recursive: true });
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(process.execPath)}</string><string>${esc(join(here, "rambox-bridge.mjs"))}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`);
const r = spawnSync("launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });
if (r.status !== 0) { console.error(r.stderr || "launchctl bootstrap selhal"); process.exit(1); }
console.log(`LaunchAgent ${LABEL} nainstalován a spuštěn (log: ${logFile}).`);
