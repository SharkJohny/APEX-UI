import { z } from "zod";
import { defineTool } from "./registry";
import { all, get, run, now } from "../db";

/* CRM: clients, leads and payments. Lifecycle mirrors the original author's
 * flow: enquiry -> quote -> won (record payment) -> client. */

type ClientRow = { id: number; name: string; company: string; email: string; phone: string; notes: string; created_at: string };
type LeadRow = { id: number; client_id: number | null; title: string; stage: string; value: number; currency: string; next_step: string; next_date: string | null; notes: string; created_at: string; updated_at: string };

function clientOrThrow(id: number): ClientRow {
  const c = get<ClientRow>("SELECT * FROM clients WHERE id = ?", id);
  if (!c) throw new Error(`Klient s id ${id} neexistuje.`);
  return c;
}

function leadOrThrow(id: number): LeadRow {
  const l = get<LeadRow>("SELECT * FROM leads WHERE id = ?", id);
  if (!l) throw new Error(`Lead s id ${id} neexistuje.`);
  return l;
}

/* Today as YYYY-MM-DD in local wall-clock time (not UTC, not SQL date('now')). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* Find an existing client by name (case-insensitive) or email, else create it. */
function findOrCreateClient(name: string, email = ""): ClientRow {
  const existing = email
    ? get<ClientRow>("SELECT * FROM clients WHERE lower(name) = lower(?) OR (email <> '' AND lower(email) = lower(?))", name, email)
    : get<ClientRow>("SELECT * FROM clients WHERE lower(name) = lower(?)", name);
  if (existing) return existing;
  const id = Number(run("INSERT INTO clients (name, email) VALUES (?,?)", name, email).lastInsertRowid);
  return clientOrThrow(id);
}

defineTool({
  name: "crm_find_clients",
  description: "Najde klienty podle jména, firmy, e-mailu nebo telefonu. Bez dotazu vrátí nejnovější klienty.",
  input: {
    query: z.string().default("").describe("Klíčová slova – jméno, firma, e-mail nebo telefon."),
  },
  node: "crm",
  handler: ({ query }) => {
    if (!query.trim()) return all("SELECT * FROM clients ORDER BY id DESC LIMIT 25");
    const like = `%${query}%`;
    return all(
      "SELECT * FROM clients WHERE name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY id DESC LIMIT 25",
      like, like, like, like,
    );
  },
});

defineTool({
  name: "crm_add_client",
  description: "Založí nového klienta. Pokud už klient se stejným jménem nebo e-mailem existuje, vrátí toho stávajícího místo duplicity.",
  input: {
    name: z.string().min(1).describe("Jméno klienta nebo firmy."),
    company: z.string().default("").describe("Název firmy, pokud se liší od jména."),
    email: z.string().default("").describe("E-mail klienta."),
    phone: z.string().default("").describe("Telefon klienta."),
    notes: z.string().default("").describe("Poznámky ke klientovi."),
  },
  node: "crm",
  handler: ({ name, company, email, phone, notes }) => {
    const dup = email
      ? get<ClientRow>("SELECT * FROM clients WHERE lower(name) = lower(?) OR (email <> '' AND lower(email) = lower(?))", name, email)
      : get<ClientRow>("SELECT * FROM clients WHERE lower(name) = lower(?)", name);
    if (dup) return { created: false, existed: true, client: dup };
    const id = Number(
      run("INSERT INTO clients (name, company, email, phone, notes) VALUES (?,?,?,?,?)", name, company, email, phone, notes).lastInsertRowid,
    );
    return { created: true, existed: false, client: clientOrThrow(id) };
  },
});

defineTool({
  name: "crm_update_client",
  description: "Upraví údaje klienta podle id. Vyplní jen pole, která zadáš.",
  input: {
    id: z.number().int().describe("Id klienta."),
    name: z.string().optional().describe("Nové jméno."),
    company: z.string().optional().describe("Nová firma."),
    email: z.string().optional().describe("Nový e-mail."),
    phone: z.string().optional().describe("Nový telefon."),
    notes: z.string().optional().describe("Nové poznámky."),
  },
  node: "crm",
  handler: ({ id, name, company, email, phone, notes }) => {
    clientOrThrow(id);
    const fields: [string, unknown][] = Object.entries({ name, company, email, phone, notes }).filter(([, v]) => v !== undefined);
    if (fields.length) {
      run(`UPDATE clients SET ${fields.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...fields.map(([, v]) => v), id);
    }
    return clientOrThrow(id);
  },
});

defineTool({
  name: "crm_list_leads",
  description: "Vypíše leady, volitelně podle fáze a/nebo klienta.",
  input: {
    stage: z.enum(["enquiry", "quote", "won", "lost"]).optional().describe("Fáze leadu."),
    client_id: z.number().int().optional().describe("Id klienta."),
  },
  node: "crm",
  handler: ({ stage, client_id }) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (stage) { where.push("stage = ?"); params.push(stage); }
    if (client_id !== undefined) { where.push("client_id = ?"); params.push(client_id); }
    const sql = `SELECT * FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT 100`;
    return all(sql, ...params);
  },
});

defineTool({
  name: "crm_add_lead",
  description: "Založí nový lead (obchodní příležitost). Klienta urči buď přes client_id (musí existovat), nebo client_name (klient se podle jména dohledá, nebo automaticky založí).",
  input: {
    title: z.string().min(1).describe("Název / předmět leadu."),
    client_id: z.number().int().optional().describe("Id existujícího klienta."),
    client_name: z.string().optional().describe("Jméno klienta – když neexistuje, automaticky se založí."),
    stage: z.enum(["enquiry", "quote", "won", "lost"]).default("enquiry").describe("Fáze leadu."),
    value: z.number().min(0).describe("Hodnota obchodu."),
    currency: z.string().default("CZK").describe("Měna hodnoty."),
    next_step: z.string().default("").describe("Další krok."),
    next_date: z.string().optional().describe("Datum dalšího kroku (YYYY-MM-DD)."),
    notes: z.string().default("").describe("Poznámky."),
  },
  node: "crm",
  handler: ({ title, client_id, client_name, stage, value, currency, next_step, next_date, notes }) => {
    let clientId: number | null = null;
    if (client_id !== undefined) {
      clientOrThrow(client_id);
      clientId = client_id;
    } else if (client_name) {
      clientId = findOrCreateClient(client_name).id;
    }
    const id = Number(
      run(
        "INSERT INTO leads (client_id, title, stage, value, currency, next_step, next_date, notes) VALUES (?,?,?,?,?,?,?,?)",
        clientId, title, stage, value, currency, next_step, next_date ?? null, notes,
      ).lastInsertRowid,
    );
    return leadOrThrow(id);
  },
});

defineTool({
  name: "crm_update_lead",
  description: "Upraví lead – fázi, hodnotu, další krok nebo poznámky. Přesun do fáze 'won' je jen posun leadu; platbu je potřeba zapsat samostatně přes crm_add_payment.",
  input: {
    id: z.number().int().describe("Id leadu."),
    stage: z.enum(["enquiry", "quote", "won", "lost"]).optional().describe("Nová fáze."),
    value: z.number().min(0).optional().describe("Nová hodnota."),
    next_step: z.string().optional().describe("Nový další krok."),
    next_date: z.string().optional().describe("Nové datum dalšího kroku (YYYY-MM-DD)."),
    notes: z.string().optional().describe("Nové poznámky."),
  },
  node: "crm",
  handler: ({ id, stage, value, next_step, next_date, notes }) => {
    const before = leadOrThrow(id);
    const fields: [string, unknown][] = Object.entries({ stage, value, next_step, next_date, notes }).filter(([, v]) => v !== undefined);
    if (fields.length) {
      run(
        `UPDATE leads SET ${fields.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        ...fields.map(([, v]) => v), now(), id,
      );
    }
    const after = leadOrThrow(id);
    const justWon = stage === "won" && before.stage !== "won";
    return justWon ? { lead: after, hint: "Lead je vyhraný – zapiš platbu přes crm_add_payment." } : after;
  },
});

defineTool({
  name: "crm_add_payment",
  description: "Zapíše přijatou platbu, navázanou na klienta a/nebo lead.",
  input: {
    amount: z.number().describe("Částka platby."),
    currency: z.string().default("CZK").describe("Měna platby."),
    client_id: z.number().int().optional().describe("Id klienta."),
    lead_id: z.number().int().optional().describe("Id leadu."),
    paid_at: z.string().optional().describe("Datum platby (YYYY-MM-DD), jinak dnes."),
    note: z.string().default("").describe("Poznámka k platbě."),
  },
  node: "finance",
  handler: ({ amount, currency, client_id, lead_id, paid_at, note }) => {
    if (client_id !== undefined) clientOrThrow(client_id);
    let leadClientId: number | null = null;
    if (lead_id !== undefined) leadClientId = leadOrThrow(lead_id).client_id;
    const finalClientId = client_id ?? leadClientId ?? null;
    const id = Number(
      run(
        "INSERT INTO payments (client_id, lead_id, amount, currency, paid_at, note) VALUES (?,?,?,?,?,?)",
        finalClientId, lead_id ?? null, amount, currency, paid_at ?? localToday(), note,
      ).lastInsertRowid,
    );
    return get("SELECT * FROM payments WHERE id = ?", id);
  },
});

defineTool({
  name: "crm_pipeline",
  description: "Souhrn pipeline: počty a hodnota podle fáze, zaseklé leady (bez úpravy 14+ dní) a nadcházející kroky (do 7 dní).",
  input: {},
  node: "crm",
  handler: () => {
    const byStage = all(
      "SELECT stage, COUNT(*) AS count, COALESCE(SUM(value),0) AS value, currency FROM leads GROUP BY stage, currency ORDER BY stage",
    );
    const stale = all(
      `SELECT id, title, stage, value, currency, next_step, updated_at FROM leads
       WHERE stage IN ('enquiry','quote') AND julianday('now') - julianday(updated_at) > 14
       ORDER BY updated_at ASC LIMIT 25`,
    );
    const upcoming = all(
      `SELECT id, title, stage, next_step, next_date FROM leads
       WHERE stage IN ('enquiry','quote') AND next_date IS NOT NULL
         AND date(next_date) BETWEEN date('now','localtime') AND date('now','localtime','+7 days')
       ORDER BY next_date ASC LIMIT 25`,
    );
    return { by_stage: byStage, stale_leads: stale, upcoming_next_steps: upcoming };
  },
});
