// Classic 42-territory Risk-style map (Lux-classic variant naming), 83 routes.
// Adjacency verified against the canonical pyLux classic_world_map dataset.
// `lon`/`lat` are geographic centroids used to place nodes over the world outline.

export interface TerritoryDef {
  id: string;
  name: string;
  continent: string;
  lon: number;
  lat: number;
}

export interface ContinentDef {
  name: string;
  bonus: number;
  territories: string[];
}

export const CONTINENTS: ContinentDef[] = [
  { name: "North America", bonus: 5, territories: ["ALA", "NWT", "GRE", "WC", "ONT", "QBC", "WUS", "EUS", "MEX"] },
  { name: "South America", bonus: 2, territories: ["VEN", "PER", "BRA", "ARG"] },
  { name: "Europe", bonus: 5, territories: ["ICE", "GB", "SCA", "NEU", "WEU", "SEU", "UKR"] },
  { name: "Africa", bonus: 3, territories: ["NAF", "EGY", "CON", "EAF", "SAF", "MAD"] },
  { name: "Asia", bonus: 7, territories: ["MDE", "AFG", "URA", "SIB", "YAK", "IRK", "MON", "CHI", "IND", "SIA", "JAP", "KAM"] },
  { name: "Oceania", bonus: 3, territories: ["INDO", "NGU", "WAU", "EAU"] },
];

export const TERRITORIES: TerritoryDef[] = [
  { id: "ALA", name: "Alaska", continent: "North America", lon: -150, lat: 64 },
  { id: "NWT", name: "Northwest Territory", continent: "North America", lon: -115, lat: 68 },
  { id: "GRE", name: "Greenland", continent: "North America", lon: -42, lat: 73 },
  { id: "WC", name: "Western Canada", continent: "North America", lon: -115, lat: 54 },
  { id: "ONT", name: "Ontario", continent: "North America", lon: -84, lat: 47 },
  { id: "QBC", name: "Quebec", continent: "North America", lon: -72, lat: 53 },
  { id: "WUS", name: "Western United States", continent: "North America", lon: -105, lat: 39 },
  { id: "EUS", name: "Eastern United States", continent: "North America", lon: -78, lat: 38 },
  { id: "MEX", name: "Central America", continent: "North America", lon: -90, lat: 12 },
  { id: "VEN", name: "Venezuela", continent: "South America", lon: -66, lat: 8 },
  { id: "PER", name: "Peru", continent: "South America", lon: -75, lat: -10 },
  { id: "BRA", name: "Brazil", continent: "South America", lon: -48, lat: -10 },
  { id: "ARG", name: "Argentina", continent: "South America", lon: -65, lat: -35 },
  { id: "ICE", name: "Iceland", continent: "Europe", lon: -19, lat: 65 },
  { id: "GB", name: "Great Britain", continent: "Europe", lon: -3, lat: 54 },
  { id: "SCA", name: "Scandinavia", continent: "Europe", lon: 15, lat: 62 },
  { id: "NEU", name: "Northern Europe", continent: "Europe", lon: 10, lat: 52 },
  { id: "WEU", name: "Western Europe", continent: "Europe", lon: 2, lat: 47 },
  { id: "SEU", name: "Southern Europe", continent: "Europe", lon: 12, lat: 42 },
  { id: "UKR", name: "Ukraine", continent: "Europe", lon: 32, lat: 49 },
  { id: "NAF", name: "North Africa", continent: "Africa", lon: -5, lat: 25 },
  { id: "EGY", name: "Egypt", continent: "Africa", lon: 30, lat: 26 },
  { id: "CON", name: "Central Africa", continent: "Africa", lon: 22, lat: 0 },
  { id: "EAF", name: "East Africa", continent: "Africa", lon: 38, lat: -5 },
  { id: "SAF", name: "South Africa", continent: "Africa", lon: 25, lat: -30 },
  { id: "MAD", name: "Madagascar", continent: "Africa", lon: 47, lat: -19 },
  { id: "MDE", name: "Middle East", continent: "Asia", lon: 45, lat: 30 },
  { id: "AFG", name: "Afghanistan", continent: "Asia", lon: 67, lat: 34 },
  { id: "URA", name: "Ural", continent: "Asia", lon: 60, lat: 55 },
  { id: "SIB", name: "Siberia", continent: "Asia", lon: 95, lat: 60 },
  { id: "YAK", name: "Yakutsk", continent: "Asia", lon: 128, lat: 68 },
  { id: "IRK", name: "Irkutsk", continent: "Asia", lon: 108, lat: 54 },
  { id: "MON", name: "Mongolia", continent: "Asia", lon: 103, lat: 46 },
  { id: "KAM", name: "Kamchatka", continent: "Asia", lon: 160, lat: 56 },
  { id: "JAP", name: "Japan", continent: "Asia", lon: 138, lat: 37 },
  { id: "IND", name: "India", continent: "Asia", lon: 77, lat: 22 },
  { id: "CHI", name: "China", continent: "Asia", lon: 105, lat: 35 },
  { id: "SIA", name: "Siam", continent: "Asia", lon: 101, lat: 16 },
  { id: "INDO", name: "Indonesia", continent: "Oceania", lon: 110, lat: -2 },
  { id: "NGU", name: "New Guinea", continent: "Oceania", lon: 142, lat: -5 },
  { id: "WAU", name: "Western Australia", continent: "Oceania", lon: 125, lat: -25 },
  { id: "EAU", name: "Eastern Australia", continent: "Oceania", lon: 145, lat: -30 },
];

// Undirected route pairs (deduplicated from the canonical directed link list).
const PAIRS: [string, string][] = [
  ["ARG", "PER"], ["ARG", "BRA"], ["PER", "VEN"], ["PER", "BRA"], ["BRA", "VEN"],
  ["BRA", "NAF"], // sea route
  ["VEN", "MEX"], ["MEX", "WUS"], ["MEX", "EUS"], ["WUS", "EUS"], ["WUS", "ONT"],
  ["WUS", "QBC"], ["EUS", "WC"], ["EUS", "ONT"], ["WC", "ALA"], ["WC", "NWT"],
  ["WC", "ONT"], ["ONT", "QBC"], ["ONT", "NWT"], ["ONT", "GRE"], ["QBC", "GRE"],
  ["ALA", "NWT"], ["ALA", "KAM"], // sea route (wraps the Pacific)
  ["NWT", "GRE"], ["GRE", "ICE"], ["ICE", "SCA"], ["ICE", "GB"], ["SCA", "GB"],
  ["SCA", "NEU"], ["SCA", "UKR"], ["GB", "WEU"], ["GB", "NEU"], ["WEU", "NEU"],
  ["WEU", "SEU"], ["WEU", "NAF"], ["NEU", "UKR"], ["UKR", "URA"], ["UKR", "AFG"],
  ["UKR", "MDE"], ["UKR", "SEU"], ["URA", "AFG"], ["URA", "SIB"], ["URA", "CHI"],
  ["AFG", "MDE"], ["AFG", "IND"], ["AFG", "CHI"], ["MDE", "SEU"], ["MDE", "EAF"],
  ["MDE", "EGY"], ["MDE", "IND"], ["SEU", "NAF"], ["SEU", "EGY"], ["NAF", "EGY"],
  ["NAF", "EAF"], ["NAF", "CON"], ["EGY", "EAF"], ["EAF", "CON"], ["EAF", "SAF"],
  ["EAF", "MAD"], ["CON", "SAF"], ["SAF", "MAD"], ["IND", "CHI"], ["IND", "SIA"],
  ["CHI", "SIB"], ["CHI", "MON"], ["CHI", "SIA"], ["SIB", "YAK"], ["SIB", "IRK"],
  ["SIB", "MON"], ["YAK", "KAM"], ["YAK", "IRK"], ["IRK", "KAM"], ["IRK", "MON"],
  ["MON", "KAM"], ["MON", "JAP"], ["KAM", "JAP"], ["SIA", "INDO"], ["INDO", "NGU"],
  ["INDO", "WAU"], ["NGU", "WAU"], ["NGU", "EAU"], ["WAU", "EAU"],
];

export const ADJACENCY: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  TERRITORIES.map((t) => {
    const nb = new Set<string>();
    for (const [a, b] of PAIRS) {
      if (a === t.id) nb.add(b);
      if (b === t.id) nb.add(a);
    }
    return [t.id, [...nb].sort() as string[]];
  }),
);

export const SEAS_ROUTES: Readonly<Record<string, readonly string[]>> = {
  ALA: ["KAM"],
  BRA: ["NAF"],
};

export const TERRITORY_BY_ID: Readonly<Record<string, TerritoryDef>> = Object.fromEntries(
  TERRITORIES.map((t) => [t.id, t]),
);

export function adjacent(a: string, b: string): boolean {
  return ADJACENCY[a]?.includes(b) ?? false;
}

// BFS path through territories owned by `owner` (endpoints must be owned too).
export function ownedPath(from: string, to: string, owner: string, owned: Set<string>): string[] | null {
  if (!owned.has(from) || !owned.has(to)) return null;
  if (from === to) return [from];
  const seen = new Set<string>([from]);
  const queue: string[][] = [[from]];
  while (queue.length) {
    const path = queue.shift()!;
    const last = path[path.length - 1];
    for (const nb of ADJACENCY[last]) {
      if (seen.has(nb)) continue;
      const next = [...path, nb];
      if (nb === to) return next;
      if (owned.has(nb)) {
        seen.add(nb);
        queue.push(next);
      }
    }
  }
  return null;
}

export function continentOf(id: string): ContinentDef {
  return CONTINENTS.find((c) => c.territories.includes(id))!;
}

export const TOTAL_TERRITORIES = TERRITORIES.length; // 42
