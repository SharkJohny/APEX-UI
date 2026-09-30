import { z } from "zod";
import { defineTool } from "./registry";
import { defineAction } from "../actions";
import { publishSocial, socialStatus, verifySocial, type SocialNetwork } from "../integrations/social";

/* Social publishing: reading status/config is a plain tool, but actually
 * posting is an outbound effect - it goes through defineAction (propose_*),
 * so the owner approves it in the Deck before anything is published. */

defineTool({
  name: "social_status",
  description: "Stav napojení na sociální sítě (Facebook, Instagram, LinkedIn): jestli jsou nastavené a jestli se s nimi dá spojit.",
  input: {},
  node: "social_media",
  handler: async () => {
    const configured = socialStatus();
    const verify = await verifySocial();
    return {
      facebook: { ...configured.facebook, ...verify.facebook },
      instagram: { ...configured.instagram, ...verify.instagram },
      linkedin: { ...configured.linkedin, ...verify.linkedin },
    };
  },
});

const NETWORKS = ["facebook", "instagram", "linkedin"] as const;

defineAction({
  kind: "social_post",
  label: "Publikovat příspěvek",
  description: "Publikuje příspěvek na sociální síť (Facebook, Instagram nebo LinkedIn).",
  input: {
    network: z.enum(NETWORKS),
    text: z.string().min(1).max(3000),
    image_url: z.string().url().optional(),
    link: z.string().url().optional(),
  },
  node: "social_media",
  summarize: (p) => `${p.network}: ${p.text.slice(0, 60)}…`,
  ready: () => {
    const status = socialStatus();
    const unconfigured = NETWORKS.filter((n) => !status[n].configured);
    return unconfigured.length ? `Nenastaveno: ${unconfigured.join(", ")}.` : null;
  },
  execute: async (p) => {
    if (p.network === "instagram" && !p.image_url) {
      throw new Error("Instagram vyžaduje obrázek (veřejná URL).");
    }
    return publishSocial(p.network as SocialNetwork, p.text, p.image_url, p.link);
  },
});
