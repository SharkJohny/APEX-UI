import { z } from "zod";
import { defineTool } from "./registry";
import { all, get, run } from "../db";

/* Projects and tasks: the operational backbone (Ops = projects, Chief of
 * staff = tasks). */

type ProjectRow = { id: number; client_id: number | null; name: string; status: string; due_date: string | null; notes: string; created_at: string };
type TaskRow = { id: number; project_id: number | null; title: string; due_date: string | null; priority: number; done: number; created_at: string; done_at: string | null };

function projectOrThrow(id: number): ProjectRow {
  const p = get<ProjectRow>("SELECT * FROM projects WHERE id = ?", id);
  if (!p) throw new Error(`Projekt s id ${id} neexistuje.`);
  return p;
}

function taskOrThrow(id: number): TaskRow {
  const t = get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  if (!t) throw new Error(`Úkol s id ${id} neexistuje.`);
  return t;
}

defineTool({
  name: "projects_list",
  description: "Vypíše projekty, volitelně podle stavu.",
  input: {
    status: z.enum(["planned", "active", "done", "paused"]).optional().describe("Stav projektu."),
  },
  node: "ops",
  handler: ({ status }) =>
    all(
      `SELECT * FROM projects ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 100`,
      ...(status ? [status] : []),
    ),
});

defineTool({
  name: "projects_add",
  description: "Založí nový projekt.",
  input: {
    name: z.string().min(1).describe("Název projektu."),
    client_id: z.number().int().optional().describe("Id klienta, ke kterému projekt patří."),
    due_date: z.string().optional().describe("Termín dokončení (YYYY-MM-DD)."),
    notes: z.string().default("").describe("Poznámky k projektu."),
  },
  node: "ops",
  handler: ({ name, client_id, due_date, notes }) => {
    if (client_id !== undefined && !get("SELECT id FROM clients WHERE id = ?", client_id)) {
      throw new Error(`Klient s id ${client_id} neexistuje.`);
    }
    const id = Number(
      run("INSERT INTO projects (client_id, name, due_date, notes) VALUES (?,?,?,?)", client_id ?? null, name, due_date ?? null, notes)
        .lastInsertRowid,
    );
    return projectOrThrow(id);
  },
});

defineTool({
  name: "projects_update",
  description: "Upraví projekt – stav, termín, poznámky. Vyplní jen pole, která zadáš.",
  input: {
    id: z.number().int().describe("Id projektu."),
    name: z.string().optional().describe("Nový název."),
    status: z.enum(["planned", "active", "done", "paused"]).optional().describe("Nový stav."),
    due_date: z.string().optional().describe("Nový termín (YYYY-MM-DD)."),
    notes: z.string().optional().describe("Nové poznámky."),
  },
  node: "ops",
  handler: ({ id, name, status, due_date, notes }) => {
    projectOrThrow(id);
    const fields: [string, unknown][] = Object.entries({ name, status, due_date, notes }).filter(([, v]) => v !== undefined);
    if (fields.length) {
      run(`UPDATE projects SET ${fields.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...fields.map(([, v]) => v), id);
    }
    return projectOrThrow(id);
  },
});

defineTool({
  name: "tasks_list",
  description: "Vypíše úkoly. Podle výchozích nastavení jen otevřené (nedokončené), s prošlým termínem první.",
  input: {
    open_only: z.boolean().default(true).describe("Jen nedokončené úkoly."),
    due_before: z.string().optional().describe("Jen úkoly s termínem do tohoto data (YYYY-MM-DD)."),
    project_id: z.number().int().optional().describe("Jen úkoly tohoto projektu."),
  },
  node: "chief_of_staff",
  handler: ({ open_only, due_before, project_id }) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (open_only) where.push("done = 0");
    if (due_before) { where.push("due_date IS NOT NULL AND due_date <= ?"); params.push(due_before); }
    if (project_id !== undefined) { where.push("project_id = ?"); params.push(project_id); }
    const sql = `
      SELECT *, (due_date IS NOT NULL AND done = 0 AND date(due_date) < date('now','localtime')) AS overdue
      FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY overdue DESC, (due_date IS NULL), due_date ASC, priority ASC
      LIMIT 100`;
    return all(sql, ...params);
  },
});

defineTool({
  name: "tasks_add",
  description: "Založí nový úkol.",
  input: {
    title: z.string().min(1).describe("Znění úkolu."),
    due_date: z.string().optional().describe("Termín (YYYY-MM-DD)."),
    priority: z.number().int().min(1).max(3).default(2).describe("Priorita 1 (nejvyšší) až 3 (nejnižší)."),
    project_id: z.number().int().optional().describe("Id projektu, ke kterému úkol patří."),
  },
  node: "chief_of_staff",
  handler: ({ title, due_date, priority, project_id }) => {
    if (project_id !== undefined) projectOrThrow(project_id);
    const id = Number(
      run("INSERT INTO tasks (project_id, title, due_date, priority) VALUES (?,?,?,?)", project_id ?? null, title, due_date ?? null, priority)
        .lastInsertRowid,
    );
    return taskOrThrow(id);
  },
});

defineTool({
  name: "tasks_complete",
  description: "Označí úkol jako dokončený.",
  input: { id: z.number().int().describe("Id úkolu.") },
  node: "chief_of_staff",
  handler: ({ id }) => {
    taskOrThrow(id);
    run("UPDATE tasks SET done = 1, done_at = datetime('now') WHERE id = ?", id);
    return taskOrThrow(id);
  },
});

defineTool({
  name: "tasks_update",
  description: "Upraví úkol – znění, termín, priorita nebo projekt. Vyplní jen pole, která zadáš.",
  input: {
    id: z.number().int().describe("Id úkolu."),
    title: z.string().optional().describe("Nové znění."),
    due_date: z.string().optional().describe("Nový termín (YYYY-MM-DD)."),
    priority: z.number().int().min(1).max(3).optional().describe("Nová priorita 1–3."),
    project_id: z.number().int().optional().describe("Nové id projektu."),
  },
  node: "chief_of_staff",
  handler: ({ id, title, due_date, priority, project_id }) => {
    taskOrThrow(id);
    if (project_id !== undefined) projectOrThrow(project_id);
    const fields: [string, unknown][] = Object.entries({ title, due_date, priority, project_id }).filter(([, v]) => v !== undefined);
    if (fields.length) {
      run(`UPDATE tasks SET ${fields.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...fields.map(([, v]) => v), id);
    }
    return taskOrThrow(id);
  },
});
