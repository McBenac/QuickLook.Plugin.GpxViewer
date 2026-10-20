// Parses GPX 1.0 and 1.1 with DOMParser and computes the summary shown in the info box.
// Elements are matched by local name, so files with or without the GPX namespace both work.

const EARTH_RADIUS_M = 6371008.8; // mean Earth radius, same as tools/make-fixtures.py

export class GpxError extends Error {}

function children(parent, name) {
  return Array.from(parent.children).filter((el) => el.localName === name);
}

function childText(parent, name) {
  const el = children(parent, name)[0];
  const text = el?.textContent.trim();
  return text || null;
}

function readPoint(el) {
  const lat = Number(el.getAttribute('lat'));
  const lon = Number(el.getAttribute('lon'));
  if (!el.hasAttribute('lat') || !el.hasAttribute('lon') || !Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  const point = { lat, lon };
  const ele = childText(el, 'ele');
  if (ele !== null && Number.isFinite(Number(ele))) point.ele = Number(ele);
  const time = childText(el, 'time');
  if (time !== null && !Number.isNaN(Date.parse(time))) point.time = new Date(time);
  const name = childText(el, 'name');
  if (name !== null) point.name = name;
  return point;
}

function readPoints(parent, name) {
  return children(parent, name).map(readPoint).filter(Boolean);
}

export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
  return total;
}

/** Parses GPX text. Throws GpxError with a readable message when the file cannot be shown. */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) {
    // Chromium puts the parser message in a <div> inside <parsererror>.
    const detail = (error.querySelector('div')?.textContent || error.textContent || '').trim().split('\n')[0];
    throw new GpxError(`The file is not valid XML${detail ? `: ${detail}` : '.'}`);
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'gpx') throw new GpxError('The file is not a GPX document.');

  const metadata = children(root, 'metadata')[0];
  const tracks = children(root, 'trk').map((trk) => ({
    name: childText(trk, 'name'),
    segments: children(trk, 'trkseg').map((seg) => readPoints(seg, 'trkpt')).filter((pts) => pts.length > 0),
  }));
  const routes = children(root, 'rte')
    .map((rte) => ({ name: childText(rte, 'name'), points: readPoints(rte, 'rtept') }))
    .filter((rte) => rte.points.length > 0);
  const waypoints = readPoints(root, 'wpt');

  return {
    version: root.getAttribute('version'),
    // The file's own name, else the name of its only track or route; several tracks show the file name.
    name: (metadata && childText(metadata, 'name')) || childText(root, 'name')
      || (tracks.length === 1 && routes.length === 0 ? tracks[0].name : null)
      || (routes.length === 1 && tracks.length === 0 ? routes[0].name : null),
    tracks,
    routes,
    waypoints,
  };
}

/** Totals for the info box. Distance is the track length, or the route length when there are no tracks. */
export function summarize(gpx) {
  const segments = gpx.tracks.flatMap((t) => t.segments);
  const trackPoints = segments.flat();
  const routePoints = gpx.routes.flatMap((r) => r.points);
  const distance = segments.length > 0
    ? segments.reduce((sum, seg) => sum + pathLength(seg), 0)
    : gpx.routes.reduce((sum, rte) => sum + pathLength(rte.points), 0);

  let start = null;
  let end = null;
  for (const p of [...trackPoints, ...routePoints, ...gpx.waypoints]) {
    if (!p.time) continue;
    if (!start || p.time < start) start = p.time;
    if (!end || p.time > end) end = p.time;
  }

  return {
    tracks: gpx.tracks.length,
    segments: segments.length,
    routes: gpx.routes.length,
    waypoints: gpx.waypoints.length,
    points: trackPoints.length,
    distanceMeters: distance,
    start,
    end,
    durationSeconds: start ? Math.round((end - start) / 1000) : null,
    elevation: trackPoints.some((p) => p.ele !== undefined),
  };
}
