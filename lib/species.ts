// 2026-04-26 (Q2 — genus-level matching): each curated entry now carries
// a `matches` rule describing what real-world species should map to it.
// Opus reads this in the system prompt and uses it as the matching
// criterion, so a Pomeranian → "dog", a Roe Deer → "deer", a Sea Otter
// → "otter" — without curating each subspecies. Defensive NOT clauses
// are spelled out to prevent over-matching (coyote shouldn't become
// "fox", moose shouldn't become "deer"). Species without a defensible
// genus match (snowleopard, kakapo, vaquita) keep tight species-level
// matching.
export const CURATED_SPECIES = [
  { id: "dog", commonName: "Dog", latinName: "Canis familiaris",
    matches: "any domestic dog breed — Pomeranian, Husky, Labrador, Pit Bull, Poodle, etc. NOT wolf, coyote, jackal, fox, dingo (treat as generated)." },
  { id: "cat", commonName: "Cat", latinName: "Felis catus",
    matches: "any domestic cat breed — tabby, Persian, Siamese, Maine Coon, ragdoll, etc. NOT wildcat (use forestcat), lynx, bobcat, big cats (treat as generated or use sumtiger)." },
  { id: "rabbit", commonName: "Rabbit", latinName: "Oryctolagus cuniculus",
    matches: "any rabbit OR hare — European rabbit, cottontail, jackrabbit, brown hare, snowshoe hare, mountain hare. (Hares lumped in — close enough visually.) NOT pikas (treat as generated)." },
  { id: "horse", commonName: "Horse", latinName: "Equus ferus caballus",
    matches: "any domestic horse breed — Arabian, Thoroughbred, Clydesdale, pony, Shetland, etc. NOT donkey, mule, zebra (treat as generated)." },
  { id: "cow", commonName: "Cow", latinName: "Bos taurus",
    matches: "any domestic cattle breed — Holstein, Angus, Hereford, Jersey, Highland, Brahman, etc. NOT bison, buffalo, yak, ox (treat as generated)." },
  { id: "fox", commonName: "Red Fox", latinName: "Vulpes vulpes",
    matches: "any true fox — red, arctic, fennec, gray, kit, swift, bat-eared, corsac, Tibetan. NOT coyote, wolf, jackal, raccoon dog (treat as generated)." },
  { id: "hedgehog", commonName: "Hedgehog", latinName: "Erinaceus europaeus",
    matches: "any hedgehog species — European, African pygmy, long-eared, Indian, etc. NOT porcupine, echidna, tenrec (treat as generated)." },
  { id: "rat", commonName: "Brown Rat", latinName: "Rattus norvegicus",
    matches: "any true rat in the Rattus genus — brown rat, black rat, Polynesian rat, fancy pet rats. NOT mice, voles, hamsters, gerbils, shrews (treat as generated — they're meaningfully different)." },
  { id: "forestcat", commonName: "European Wildcat", latinName: "Felis silvestris",
    matches: "wildcats only — European wildcat (Felis silvestris silvestris), African wildcat (Felis lybica). NOT domestic cat (use cat), lynx, bobcat, ocelot, serval (treat as generated)." },
  { id: "pigeon", commonName: "Rock Pigeon", latinName: "Columba livia",
    matches: "any pigeon or dove (Columbidae family) — rock pigeon, wood pigeon, mourning dove, collared dove, fancy domestic pigeons, white doves. NOT extinct dodo (treat as generated)." },
  { id: "sparrow", commonName: "House Sparrow", latinName: "Passer domesticus",
    matches: "any small brown LBJ-style passerine that a casual observer would call a sparrow — house sparrow, tree sparrow, song sparrow, fox sparrow, chipping sparrow, white-throated sparrow, dunnock, junco. NOT finches, warblers, wrens, tits/chickadees (treat as generated — they have distinct visual identities)." },
  { id: "crow", commonName: "American Crow", latinName: "Corvus brachyrhynchos",
    matches: "any corvid — crow, raven, rook, jackdaw, magpie. NOT jays (too colorful, distinct — treat as generated)." },
  { id: "owl", commonName: "Tawny Owl", latinName: "Strix aluco",
    matches: "any owl species — great horned, snowy, barn, eagle, screech, burrowing, little, long-eared, etc. (All Strigiformes.)" },
  { id: "butterfly", commonName: "Red Admiral", latinName: "Vanessa atalanta",
    matches: "any butterfly OR skipper — monarch, swallowtail, painted lady, blue morpho, cabbage white, common skipper, etc. NOT moths (treat as generated — distinct silhouette + behavior)." },
  { id: "bee", commonName: "Honey Bee", latinName: "Apis mellifera",
    matches: "any bee — honey bee, bumble bee, carpenter bee, mason bee, leafcutter bee, sweat bee. NOT wasps, hornets, yellowjackets, hoverflies (treat as generated — different family/order)." },
  { id: "dragonfly", commonName: "Emperor Dragonfly", latinName: "Anax imperator",
    matches: "any dragonfly OR damselfly (all Odonata) — emperor, hawker, darter, common blue damselfly, banded demoiselle, etc." },
  { id: "frog", commonName: "Common Frog", latinName: "Rana temporaria",
    matches: "any true frog (smooth-skinned, aquatic-leaning) — common frog, bullfrog, tree frog, leopard frog, dart frog, glass frog. NOT toads (use toad — warty, terrestrial)." },
  { id: "mallard", commonName: "Mallard", latinName: "Anas platyrhynchos",
    matches: "any duck species — mallard, wood duck, pintail, teal, wigeon, mandarin, eider, domestic ducks. NOT geese, swans, grebes, coots (treat as generated — body plan + size differ)." },
  { id: "koi", commonName: "Koi Carp", latinName: "Cyprinus rubrofuscus",
    matches: "any ornamental koi or domestic carp variety — kohaku, sanke, showa, asagi, butterfly koi, mirror carp, ghost koi. NOT wild common carp species (treat as generated — koi is the ornamental cultivar)." },
  { id: "goldfish", commonName: "Goldfish", latinName: "Carassius auratus",
    matches: "any goldfish variety — common, comet, oranda, ryukin, ranchu, fantail, telescope eye, shubunkin, lionhead. NOT other aquarium fish (tetras, guppies, bettas — treat as generated)." },
  { id: "otter", commonName: "Eurasian Otter", latinName: "Lutra lutra",
    matches: "any otter species — Eurasian, North American river otter, sea otter, giant otter, Asian small-clawed, marine otter, smooth-coated, hairy-nosed." },
  { id: "toad", commonName: "Common Toad", latinName: "Bufo bufo",
    matches: "any toad species (warty, terrestrial) — common toad, American toad, cane toad, fire-bellied toad, fowler's toad, natterjack. NOT frogs (use frog — smooth-skinned, aquatic)." },
  { id: "squirrel", commonName: "Grey Squirrel", latinName: "Sciurus carolinensis",
    matches: "any tree squirrel OR ground squirrel OR chipmunk (Sciuridae) — grey, red, fox, eastern, Eurasian, golden-mantled, eastern chipmunk, palm squirrel, flying squirrel. NOT marmots, groundhogs, prairie dogs (treat as generated — much bigger body)." },
  { id: "deer", commonName: "White-tailed Deer", latinName: "Odocoileus virginianus",
    matches: "any small/medium deer — white-tailed, mule, fallow, roe, sika, axis, muntjac, red deer, black-tailed. NOT moose, elk, caribou, reindeer (much larger body — treat as generated)." },
  { id: "raccoon", commonName: "Raccoon", latinName: "Procyon lotor",
    matches: "any raccoon species (Procyon genus) — common raccoon, crab-eating raccoon, Cozumel raccoon. NOT coati, kinkajou, ringtail (related but distinct genus — treat as generated)." },
  { id: "ladybug", commonName: "Seven-spot Ladybug", latinName: "Coccinella septempunctata",
    matches: "any ladybug / ladybird / lady beetle (Coccinellidae) — seven-spot, two-spot, harlequin, Asian lady beetle, convergent lady beetle, etc. NOT other beetles." },
  { id: "ant", commonName: "Wood Ant", latinName: "Formica rufa",
    matches: "any ant species (Formicidae) — wood ant, fire ant, carpenter ant, leafcutter, harvester, weaver, army ant, etc. NOT termites (different order — treat as generated)." },
  { id: "stagbeetle", commonName: "Stag Beetle", latinName: "Lucanus cervus",
    matches: "any stag beetle (Lucanidae) — European, giant, golden, etc. NOT rhinoceros beetles, scarabs, ground beetles, weevils (different families — treat as generated)." },
  { id: "snowleopard", commonName: "Snow Leopard", latinName: "Panthera uncia",
    matches: "snow leopard ONLY (Panthera uncia). Tight species match — do NOT broaden to other big cats." },
  { id: "blackrhino", commonName: "Black Rhino", latinName: "Diceros bicornis",
    matches: "any rhinoceros species — black, white, Indian, Sumatran, Javan. All five rhino species lump here (all endangered, all horned, all visually unmistakable as rhinos)." },
  { id: "sumtiger", commonName: "Sumatran Tiger", latinName: "Panthera tigris sumatrae",
    matches: "any tiger subspecies (Panthera tigris) — Bengal, Siberian / Amur, Sumatran, Indochinese, Malayan, South China. NOT lions, leopards, jaguars (treat as generated)." },
  { id: "kakapo", commonName: "Kakapo", latinName: "Strigops habroptilus",
    matches: "kakapo ONLY (Strigops habroptilus). Tight species match — do NOT broaden to other parrots." },
  { id: "vaquita", commonName: "Vaquita", latinName: "Phocoena sinus",
    matches: "vaquita ONLY (Phocoena sinus). Tight species match — do NOT broaden to other porpoises or dolphins." },
] as const;

export type CuratedId = (typeof CURATED_SPECIES)[number]["id"];

// 2026-04-26: matches rule appended to each catalogue line so Opus can
// see the matching criterion alongside the id/name. The system prompt
// step 4 reads this block and uses `matches` as the lumping rule.
export const CURATED_SPECIES_BLOCK = CURATED_SPECIES
  .map((s) => `- id="${s.id}" common="${s.commonName}" latin="${s.latinName}" matches="${s.matches}"`)
  .join("\n");
