// Land outline from Natural Earth 110m (public domain) — bundled as land.geojson.
// A single SVG path string, built once at module load.
// Imported ?raw + JSON.parse because Vite/TS only auto-process .json, not .geojson.

import landRaw from "../assets/land.geojson?raw";
import { project } from "./projection";

const land: unknown = JSON.parse(landRaw);

/**
 * Project one ring to SVG path commands. Segments that jump across the
 * antimeridian (|Δlon| > 180) start a new sub-path so we never draw a
 * long horizontal smear across the whole map.
 */
function ringToPath(ring: number[][]): string {
  let d = "";
  let started = false;
  let prevLon: number | null = null;
  for (const [lon, lat] of ring) {
    const [x, y] = project(lon, lat);
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) started = false;
    if (!started) {
      d += `M${x.toFixed(1)} ${y.toFixed(1)}`;
      started = true;
    } else {
      d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    prevLon = lon;
  }
  return d + "Z";
}

/** All land polygons as one path (Antarctica clips below the viewBox — fine). */
export const LAND_PATH: string = (() => {
  let d = "";
  // land: polygon[] where polygon = ring[] where ring = point[] (point = [lon, lat])
  const polys = land as number[][][][];
  for (const polygon of polys) {
    for (const ring of polygon) d += ringToPath(ring);
  }
  return d;
})();
