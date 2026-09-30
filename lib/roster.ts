/* The 18-agent roster, shared by the UI (graph, cockpit cards) and the backend
 * (agent registry, trace events). Keys match ReasoningWeb.jsx's roster ids.
 * Content is generic - not tied to any one kind of business. */

export type AgentKind = "consultant" | "doer" | "tool";
export type AgentKey =
  | "chief_of_staff" | "memory" | "strategist" | "researcher" | "finance" | "editor"
  | "sales" | "marketing" | "ops" | "social_media" | "engineering" | "design" | "developer"
  | "analytics" | "crm" | "calendar" | "email" | "drive";

export type RosterEntry = {
  key: AgentKey;
  name: string;
  kind: AgentKind;
  color: string;
  role: string;
  caps: string[];
  asks?: string[];
};

const COL: Record<AgentKind, string> = { consultant: "#00e5ff", doer: "#f5a623", tool: "#7f9bb3" };

const R = (key: AgentKey, name: string, kind: AgentKind, role: string, caps: string[], asks?: string[]): RosterEntry =>
  ({ key, name, kind, color: COL[kind], role, caps, asks });

export const ROSTER: RosterEntry[] = [
  R("chief_of_staff", "Chief of staff", "consultant", "Pravá ruka – řídí den",
    ["Určuje priority dne a hlídá nedodělky", "Každý požadavek pošle správnému specialistovi", "Eskaluje jen to, co opravdu potřebuje člověka"],
    ["Co dnes potřebuje pozornost?", "Projdi otevřené nabídky"]),
  R("memory", "Memory", "consultant", "Dlouhodobá paměť",
    ["Pamatuje si klienty, projekty a rozhodnutí", "Automaticky dodává kontext ke každému úkolu", "Učí se tvoje preference"],
    ["Co víme o klientovi Novák?", "Zapamatuj si, že faktury posílám vždy v pondělí"]),
  R("strategist", "Strategist", "consultant", "Velký obraz",
    ["Týdenní strategická revize", "Sledování cílů a milníků", "Včas vidí příležitosti a rizika"],
    ["Kam bychom měli víc investovat?"]),
  R("researcher", "Researcher", "consultant", "Hloubkový průzkum",
    ["Průzkum trhu a konkurence na webu", "Technické rešerše", "Shrnutí s ověřenými zdroji"],
    ["Prozkoumej konkurenci v mém oboru", "Porovnej tyhle dodavatele"]),
  R("finance", "Finance", "consultant", "Hlídač peněz",
    ["Přehled tržeb a pipeline", "Kontrola cen nabídek", "Měsíční souhrny výkonu"],
    ["Jaký byl tenhle měsíc?", "Je tahle nabídka správně naceněná?"]),
  R("editor", "Editor", "consultant", "Kontrola kvality",
    ["Přepíše a zpřesní každý koncept", "Drží jednotný hlas značky", "Poslední kontrola před odesláním"],
    ["Učesej tenhle příspěvek", "Zkrať tenhle e-mail"]),
  R("sales", "Sales", "doer", "Uzavírá obchody",
    ["Follow-upy ke každému leadu", "Koncepty oslovení", "Hlídá, aby nic nevychladlo"],
    ["Napiš follow-up", "Kdo se odmlčel?"]),
  R("marketing", "Marketing", "doer", "Motor růstu",
    ["Návrhy kampaní", "Analýza cen a pozicování", "Obsahový kalendář"],
    ["Navrhni kampaň", "Jak se odlišit od konkurence?"]),
  R("ops", "Ops", "doer", "Provoz firmy",
    ["Nabídky a návrhy pro klienty", "Rozsah projektů a harmonogramy", "Hledání dodavatelů"],
    ["Připrav nabídku pro klienta", "Sestav rozsah projektu"]),
  R("social_media", "Social", "doer", "Hlas značky",
    ["Píše příspěvky a popisky", "Scénáře k reels", "Publikuje na Instagram, LinkedIn a Facebook (po schválení)"],
    ["Napiš popisek k příspěvku", "Naplánuj obsah na týden"]),
  R("engineering", "Engineering", "doer", "Technický mozek",
    ["Technické výpočty a specifikace", "Návrh řešení a materiálů", "Kontrola technické proveditelnosti"],
    ["Spočítej tolerance", "Zkontroluj tuhle specifikaci"]),
  R("design", "Design", "doer", "Vizuální dílna",
    ["Vizuální koncepty a zadání", "Prompty pro generování obrázků", "Formáty pro sociální sítě"],
    ["Navrhni vizuál k příspěvku", "Jaké rozměry pro IG?"]),
  R("developer", "Developer", "doer", "Strážce vývojového deníku",
    ["Vede vývojový deník Apexu", "Shrnutí toho, co se změnilo – den / týden / měsíc"],
    ["Shrň minulý týden vývoje"]),
  R("analytics", "Analytics", "tool", "Čísla",
    ["Metriky napříč CRM, úkoly a tržbami", "Podklady pro týdenní revize"],
    ["Ukaž konverzi leadů"]),
  R("crm", "CRM", "tool", "Banka klientů",
    ["Všichni klienti a leady v jedné pipeline", "Fáze od poptávky po zaplacení"],
    ["Přidej lead", "Ukaž pipeline"]),
  R("calendar", "Calendar", "tool", "Smysl pro čas",
    ["Zná tvůj Google kalendář", "Připomínky a načasování follow-upů"],
    ["Co mám tento týden?"]),
  R("email", "Email", "tool", "Ruce v inboxu",
    ["Třídí Gmail a připravuje odpovědi", "Odeslání jen po tvém schválení"],
    ["Co nového v poště?"]),
  R("drive", "Drive", "tool", "Přístup k souborům",
    ["Hledá a čte dokumenty na Google Drive"],
    ["Najdi smlouvu s klientem"]),
];

export const ROSTER_BY_KEY: Record<string, RosterEntry> = Object.fromEntries(ROSTER.map((r) => [r.key, r]));

export type AgentStatus = "online" | "standby" | "integration" | "offline";
