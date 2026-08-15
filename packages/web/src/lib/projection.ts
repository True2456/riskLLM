// Equirectangular projection: lon -175..180, lat 78..-58 -> viewBox 1000x420.

export const VIEW_W = 1000;
export const VIEW_H = 420;
export const LON_MIN = -175;
export const LON_MAX = 180;
export const LAT_TOP = 78;
export const LAT_BOT = -58;

export function project(lon: number, lat: number): [number, number] {
  const x = ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * VIEW_W;
  const y = ((LAT_TOP - lat) / (LAT_TOP - LAT_BOT)) * VIEW_H;
  return [x, y];
}
