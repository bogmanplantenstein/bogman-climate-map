/* ─────────────────────────────────────────────────────────────────────────
   Bogman Climate Map — guided tour COPY.

   This file holds every word the tour shows. Edit the strings here to change
   wording; you never need to touch tour.js (the engine). Each step's text is
   keyed by an id that the engine references.

   Loaded before tour.js; exposes window.BMG_TOUR_CONTENT.
   ───────────────────────────────────────────────────────────────────────── */
window.BMG_TOUR_CONTENT = {

  picker: {
    title:    "What would you like to do?",
    subtitle: "Pick a goal and we'll give you a short guided walkthrough. You can switch anytime.",
    skip:     "Skip — I'll explore on my own",
    soon:     "This walkthrough isn't ready yet — coming soon.",
    cards: [
      { key: "browse",  icon: "camera", ready: false, label: "See the plants",            sub: "Browse real sightings and their photo galleries." },
      { key: "grow",    icon: "leaf",   ready: false, label: "What can I grow?",           sub: "Find plants suited to your local climate." },
      { key: "needs",   icon: "info",   ready: true,  label: "What do these plants need?", sub: "Explore a species' climate and growing conditions." },
      { key: "explore", icon: "map",    ready: false, label: "Explore the map",            sub: "Climate-zone layers, search, and tap-anywhere info." },
    ],
  },

  paths: {
    // "What do these plants need?" — reads a species page, then contrasts an
    // exact-location species with an obscured (location-hidden) one.
    needs: {
      title: "What do these plants need?",
      steps: {
        intro:    "Pick any species to see what it needs. This round-leaved sundew is a cold-hardy bog plant of the northern hemisphere.",
        stats:    "Its climate envelope: typical highs and lows, rainfall, humidity, elevation — and the cold and heat limits it can survive.",
        chart:    "Month-by-month temperatures across its whole native range, and when it flowers.",
        zones:    "The climate zones and soils it grows in — all built from real wild sightings with exact GPS locations.",
        obscured: "Rare plants like this Borneo highland pitcher hide their locations from poachers, so coordinates can be ~22 km off. We correct the climate with published elevation ranges — here, 1,600–2,700 m, fixing an impossible 595–4,019 m guess.",
        end:      "That's how to read what a plant needs — and how far to trust it. You can replay this anytime from the “?” button.",
      },
    },
  },
};
