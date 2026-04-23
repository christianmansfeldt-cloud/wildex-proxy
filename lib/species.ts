export const CURATED_SPECIES = [
  { id: "dog", commonName: "Dog", latinName: "Canis familiaris" },
  { id: "cat", commonName: "Cat", latinName: "Felis catus" },
  { id: "rabbit", commonName: "Rabbit", latinName: "Oryctolagus cuniculus" },
  { id: "fox", commonName: "Red Fox", latinName: "Vulpes vulpes" },
  { id: "hedgehog", commonName: "Hedgehog", latinName: "Erinaceus europaeus" },
  { id: "rat", commonName: "Brown Rat", latinName: "Rattus norvegicus" },
  { id: "pigeon", commonName: "Rock Pigeon", latinName: "Columba livia" },
  { id: "sparrow", commonName: "House Sparrow", latinName: "Passer domesticus" },
  { id: "crow", commonName: "American Crow", latinName: "Corvus brachyrhynchos" },
  { id: "owl", commonName: "Tawny Owl", latinName: "Strix aluco" },
  { id: "butterfly", commonName: "Red Admiral", latinName: "Vanessa atalanta" },
  { id: "bee", commonName: "Honey Bee", latinName: "Apis mellifera" },
  { id: "dragonfly", commonName: "Emperor Dragonfly", latinName: "Anax imperator" },
  { id: "frog", commonName: "Common Frog", latinName: "Rana temporaria" },
  { id: "mallard", commonName: "Mallard", latinName: "Anas platyrhynchos" },
  { id: "koi", commonName: "Koi Carp", latinName: "Cyprinus rubrofuscus" },
  { id: "goldfish", commonName: "Goldfish", latinName: "Carassius auratus" },
  { id: "otter", commonName: "Eurasian Otter", latinName: "Lutra lutra" },
  { id: "toad", commonName: "Common Toad", latinName: "Bufo bufo" },
  { id: "squirrel", commonName: "Grey Squirrel", latinName: "Sciurus carolinensis" },
  { id: "deer", commonName: "White-tailed Deer", latinName: "Odocoileus virginianus" },
  { id: "raccoon", commonName: "Raccoon", latinName: "Procyon lotor" },
  { id: "ladybug", commonName: "Seven-spot Ladybug", latinName: "Coccinella septempunctata" },
  { id: "ant", commonName: "Wood Ant", latinName: "Formica rufa" },
  { id: "stagbeetle", commonName: "Stag Beetle", latinName: "Lucanus cervus" },
  { id: "snowleopard", commonName: "Snow Leopard", latinName: "Panthera uncia" },
  { id: "blackrhino", commonName: "Black Rhino", latinName: "Diceros bicornis" },
  { id: "sumtiger", commonName: "Sumatran Tiger", latinName: "Panthera tigris sumatrae" },
  { id: "kakapo", commonName: "Kakapo", latinName: "Strigops habroptilus" },
  { id: "vaquita", commonName: "Vaquita", latinName: "Phocoena sinus" },
] as const;

export type CuratedId = (typeof CURATED_SPECIES)[number]["id"];

export const CURATED_SPECIES_BLOCK = CURATED_SPECIES
  .map((s) => `- id="${s.id}" common="${s.commonName}" latin="${s.latinName}"`)
  .join("\n");
