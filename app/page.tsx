import ApexWorld from "@/components/ApexWorld";
import ApexOverviewPanel from "@/components/ApexOverviewPanel";

export default function Home() {
  return (
    <main
      id="main"
      style={{ background: "#04080f", color: "#f0ede8", position: "relative", overflow: "hidden" }}
    >
      {/* Top-left overview HUD: clock + weather + social links */}
      <ApexOverviewPanel />

      {/* The world: orb core + orbiting agent graph + chat dock + Command Deck.
          Tap the orb to talk; click any agent node to open its live cockpit. */}
      <section style={{ position: "relative", height: "100vh", minHeight: 620 }}>
        <ApexWorld />
      </section>
    </main>
  );
}
