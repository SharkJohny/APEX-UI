import { z } from "zod";
import { execFileSync } from "node:child_process";
import { defineTool } from "./registry";

/* Developer: the diary of Apex's own repo. Reads git history straight off
 * disk - no state kept in the DB. */

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
}

defineTool({
  name: "dev_log",
  description: "Vývojový deník: historie commitů repozitáře Apexu za posledních N dní plus stručný stav pracovního adresáře.",
  input: {
    days: z.number().int().min(1).max(365).default(7).describe("Kolik dní zpátky."),
    max: z.number().int().min(1).max(200).default(60).describe("Nejvíc kolik commitů vrátit."),
  },
  node: "developer",
  handler: ({ days, max }) => {
    let log: string;
    let statusSummary: string;
    try {
      log = git(["log", `--since=${days} days ago`, "--pretty=format:%h|%ad|%an|%s", "--date=short", "-n", String(max)]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not a git repository/i.test(msg)) {
        return { is_git_repo: false, message: "Tento adresář není git repozitář.", commits: [], status: [] };
      }
      throw new Error(`Nepodařilo se přečíst historii gitu: ${msg}`);
    }
    try {
      statusSummary = git(["status", "--short"]);
    } catch {
      statusSummary = "";
    }
    const commits = log
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, author, ...rest] = line.split("|");
        return { hash, date, author, message: rest.join("|") };
      });
    const status = statusSummary.split("\n").filter(Boolean);
    return { is_git_repo: true, days, commits, status };
  },
});
