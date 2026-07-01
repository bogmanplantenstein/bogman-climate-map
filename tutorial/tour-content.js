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
    note:     "You can replay any walkthrough anytime from the “?” button.",
    skip:     "Skip — I'll explore on my own",
    soon:     "This walkthrough isn't ready yet — coming soon.",
    cards: [
      { key: "browse",  icon: "camera", ready: true, label: "See the plants",            sub: "Browse real sightings and their photo galleries." },
      { key: "grow",    icon: "leaf",   ready: true, label: "What can I grow?",           sub: "Find plants suited to your local climate." },
      { key: "needs",   icon: "info",   ready: true, label: "What do these plants need?", sub: "Explore a species' climate and growing conditions." },
      { key: "explore", icon: "map",    ready: true, label: "Explore the map",            sub: "Climate-zone layers, search, and tap-anywhere info." },
    ],
  },

  paths: {
    // "What do these plants need?" — start on the map, open a species, read its
    // page, then contrast an exact-location species with an obscured one.
    needs: {
      title: "What do these plants need?",
      steps: {
        entry:    "Start here. Search for any carnivorous plant by name, or click a dot on the map to explore sightings at a place.",
        intro:    "Pick any species to see what it needs. This round-leaved sundew is a cold-hardy bog plant of the northern hemisphere.",
        stats:    "Its climate envelope: typical highs and lows, rainfall, humidity, elevation — and the cold and heat limits it experiences in the wild.",
        chart:    "Month-by-month temperatures across its whole native range, and when it flowers.",
        zones:    "The climate zones and soils it grows in — all built from real wild sightings with exact GPS locations.",
        obscured: "Protected species like this Borneo highland pitcher have their exact locations obscured, so coordinates can be ~22 km off. We correct the climate with published elevation ranges — here, 1,600–2,700 m, fixing an impossible 595–4,019 m guess.",
      },
    },

    // "See the plants" — real sightings and their photo galleries.
    browse: {
      title: "See the plants",
      steps: {
        entry:   "Every dot on the map is a real, wild sighting from iNaturalist. Search a plant by name, or zoom in and click the dots to explore.",
        species: "Open any species to meet it — a photo, its native range, and how many people have logged it in the wild.",
        gallery: "Sightings often carry photos. Open the gallery to browse them all — each one links back to the original observation.",
      },
    },

    // "What can I grow?" — reverse climate match for a chosen location.
    grow: {
      title: "What can I grow?",
      steps: {
        entry:   "Curious what you could grow outdoors? Start by telling the map where you are — search your town or click the map.",
        results: "Here we've picked Wilmington, North Carolina. The map pulls its climate and ranks every species by how well it suits an outdoor life there.",
        card:    "Each species gets a suitability score and quick flags — whether your winters, summer heat, or humidity are the sticking point.",
        filter:  "Narrow to a genus you like, or score on temperature alone.",
      },
    },

    // "Explore the map" — layers, search, tap-anywhere info.
    explore: {
      title: "Explore the map",
      steps: {
        search: "Search finds any species, a town, or a whole region — type a name and jump straight to it.",
        layers: "These buttons switch to satellite, toggle the climate-zone tint, open the color key, and add soil layers.",
        zones:  "The map is tinted by Köppen climate zone. Open the key to see what each color means — and click a zone to show only the plants that grow there.",
        click:  "And anywhere you click on the map, you'll get that spot's climate, soil, and USDA hardiness zone.",
      },
    },
  },
};
