// GPX viewer page: loads the file from ?src=, draws it with Leaflet and reports "ready\t<summary>" or
// "error:<text>" to the plugin (window.chrome.webview). Works in any browser through a local web server.
import { GpxError, distanceMeters, parseGpx, summarize } from './gpx.js';

/* global L */

const params = new URLSearchParams(location.search);
const src = params.get('src');
const fileName = params.get('name') || (src ? decodeURIComponent(src.split('/').pop()) : 'GPX file');

const COLORS = ['#ff5a36', '#2f9bff', '#f5c400', '#c23cff', '#18c964', '#ff3d9a', '#00c2c7', '#ff9f1a'];
const ROUTE_COLOR = '#ffffff';
// Above this many track points only the lines are drawn: a clickable dot per point would use too much memory.
const MAX_DOTS = 20000;
const LAYER_KEY = 'gpxviewer.layer';
const LAYERS = {
  map: {
    label: 'Map',
    title: 'OpenStreetMap (Humanitarian style)',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    options: {
      subdomains: 'abc',
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors, '
        + 'style <a href="https://www.hotosm.org/" target="_blank">HOT</a>, '
        + 'hosted by <a href="https://openstreetmap.fr/" target="_blank">OSM France</a>',
    },
  },
  satellite: {
    label: 'Satellite',
    title: 'Esri World Imagery',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: {
      maxZoom: 19,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics and the GIS User Community',
    },
  },
  none: {
    label: 'No map',
    title: 'Grid only: no map tiles are downloaded',
  },
};

function post(message) {
  window.chrome?.webview?.postMessage(message);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(text) {
  document.body.classList.add('failed');
  const box = document.getElementById('message');
  box.replaceChildren(el('h1', null, 'Cannot show this GPX file'), el('p', 'file', fileName), el('p', 'detail', text));
  box.hidden = false;
  post(`error:${text}`);
}

// ---------- formatting ----------

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatRange(start, end) {
  if (!start) return null;
  if (sameDay(start, end)) {
    return `${dateFormat.format(start)}, ${timeFormat.format(start)} – ${timeFormat.format(end)}`;
  }
  return `${dateFormat.format(start)} ${timeFormat.format(start)} – ${dateFormat.format(end)} ${timeFormat.format(end)}`;
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 100000 ? 2 : 1)} km`;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h ${m} min`;
  if (h > 0) return `${h} h ${m} min`;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

function formatCoord(p) {
  return `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
}

function pointPopup(p, title) {
  const box = el('div', 'point-popup');
  if (title) box.append(el('strong', null, title));
  if (p.time) box.append(el('div', null, fullFormat.format(p.time)));
  box.append(el('div', 'coord', formatCoord(p)));
  if (p.ele !== undefined) box.append(el('div', null, `${Math.round(p.ele)} m elevation`));
  return box;
}

// ---------- info box and elevation profile ----------

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

function renderInfo(gpx, summary) {
  const box = document.getElementById('info');
  box.append(el('h1', null, gpx.name || fileName));
  if (gpx.name && gpx.name !== fileName) box.append(el('p', 'file', fileName));

  const rows = [];
  const range = formatRange(summary.start, summary.end);
  if (range) rows.push(['Date', range]);
  if (summary.points > 0) rows.push(['Points', summary.points.toLocaleString()]);
  if (summary.segments > 0 || summary.routes > 0) {
    rows.push([summary.segments > 0 ? 'Distance' : 'Route length', formatDistance(summary.distanceMeters)]);
  }
  if (summary.durationSeconds !== null) rows.push(['Time', formatDuration(summary.durationSeconds)]);

  const parts = [];
  if (summary.tracks > 0) {
    parts.push(plural(summary.tracks, 'track') + (summary.segments > summary.tracks ? ` (${summary.segments} segments)` : ''));
  }
  if (summary.routes > 0) parts.push(plural(summary.routes, 'route'));
  if (summary.waypoints > 0) parts.push(plural(summary.waypoints, 'waypoint'));
  if (parts.length > 0) rows.push(['Contents', parts.join(', ')]);

  const table = el('dl');
  for (const [key, value] of rows) table.append(el('dt', null, key), el('dd', null, value));
  box.append(table);
  if (parts.length === 0) box.append(el('p', 'empty', 'No tracks, routes or waypoints in this file.'));
  box.hidden = false;
}

function renderProfile(gpx) {
  // Elevation against distance along the tracks; segments follow each other without a gap.
  const samples = [];
  let along = 0;
  for (const seg of gpx.tracks.flatMap((t) => t.segments)) {
    seg.forEach((p, i) => {
      if (i > 0) along += distanceMeters(seg[i - 1], p);
      if (p.ele !== undefined) samples.push([along, p.ele]);
    });
  }
  if (samples.length < 2) return;

  const width = 600;
  const height = 100;
  const total = samples[samples.length - 1][0] || 1;
  let min = Infinity;
  let max = -Infinity;
  for (const [, e] of samples) {
    min = Math.min(min, e);
    max = Math.max(max, e);
  }
  const span = max - min || 1;
  const xy = samples.map(([d, e]) => `${((d / total) * width).toFixed(1)},${(height - ((e - min) / span) * (height - 8) - 4).toFixed(1)}`);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('class', 'area');
  area.setAttribute('d', `M0,${height} L${xy.join(' L')} L${width},${height} Z`);
  const line = document.createElementNS(ns, 'path');
  line.setAttribute('class', 'line');
  line.setAttribute('d', `M${xy.join(' L')}`);
  svg.append(area, line);

  const box = document.getElementById('profile');
  box.append(
    el('div', 'label', `Elevation ${Math.round(min)}–${Math.round(max)} m`),
    svg,
  );
  box.hidden = false;
  document.body.classList.add('with-profile');
}

// ---------- map ----------

function graticule(map) {
  // Lines every "nice" number of degrees, so the track keeps a sense of scale without map tiles.
  const group = L.layerGroup();
  const steps = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30];
  const style = { color: '#ffffff', opacity: 0.12, weight: 1, interactive: false };

  function redraw() {
    group.clearLayers();
    const b = map.getBounds();
    const span = Math.max(b.getNorth() - b.getSouth(), 1e-6);
    const step = steps.find((s) => span / s <= 10) ?? 30;
    const south = Math.max(-90, b.getSouth());
    const north = Math.min(90, b.getNorth());
    for (let lat = Math.ceil(south / step) * step; lat <= north; lat += step) {
      group.addLayer(L.polyline([[lat, b.getWest()], [lat, b.getEast()]], style));
    }
    for (let lon = Math.ceil(b.getWest() / step) * step; lon <= b.getEast(); lon += step) {
      group.addLayer(L.polyline([[south, lon], [north, lon]], style));
    }
  }

  group.on('add', () => {
    map.on('moveend', redraw);
    redraw();
  });
  group.on('remove', () => map.off('moveend', redraw));
  return group;
}

function savedLayer() {
  try {
    const value = localStorage.getItem(LAYER_KEY);
    return value in LAYERS ? value : 'map';
  } catch {
    return 'map';
  }
}

function layerSwitcher(map) {
  const layers = {};
  for (const [key, def] of Object.entries(LAYERS)) {
    layers[key] = def.url ? L.tileLayer(def.url, def.options) : graticule(map);
  }
  let current = null;
  const buttons = {};

  function select(key, remember) {
    if (current) map.removeLayer(layers[current]);
    current = key;
    layers[key].addTo(map);
    document.body.classList.toggle('no-map', key === 'none');
    for (const [k, button] of Object.entries(buttons)) button.classList.toggle('active', k === key);
    if (remember) {
      try {
        localStorage.setItem(LAYER_KEY, key);
      } catch {
        // Private mode or storage disabled: the choice just is not remembered.
      }
    }
  }

  const Control = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const bar = el('div', 'layer-switch leaflet-bar');
      for (const [key, def] of Object.entries(LAYERS)) {
        const button = el('button', null, def.label);
        button.type = 'button';
        button.title = def.title;
        button.tabIndex = -1; // never keep focus: Space and Esc belong to QuickLook
        button.dataset.layer = key;
        button.addEventListener('click', () => {
          select(key, true);
          button.blur();
        });
        buttons[key] = button;
        bar.append(button);
      }
      L.DomEvent.disableClickPropagation(bar);
      return bar;
    },
  });
  map.addControl(new Control());
  select(savedLayer(), false);
  return { select, current: () => current };
}

function pinIcon(color) {
  return L.divIcon({
    className: 'gpx-pin',
    html: `<svg viewBox="0 0 24 34" width="24" height="34"><path d="M12 1C6 1 1.5 5.6 1.5 11.5 1.5 19.5 12 33 12 33s10.5-13.5 10.5-21.5C22.5 5.6 18 1 12 1z" fill="${color}" stroke="#1b1b1b" stroke-width="1.5"/><circle cx="12" cy="11.5" r="4" fill="#1b1b1b"/></svg>`,
    iconSize: [24, 34],
    iconAnchor: [12, 33],
    popupAnchor: [0, -30],
  });
}

function drawGpx(map, gpx) {
  const bounds = L.latLngBounds([]);
  const dots = L.canvas({ padding: 0.5 });
  let colorIndex = 0;
  const withDots = gpx.tracks.reduce((n, t) => n + t.segments.reduce((m, seg) => m + seg.length, 0), 0) <= MAX_DOTS;

  gpx.tracks.forEach((track) => {
    const segments = track.segments;
    segments.forEach((seg, s) => {
      const color = COLORS[colorIndex++ % COLORS.length];
      const latlngs = seg.map((p) => [p.lat, p.lon]);
      const title = track.name ? (segments.length > 1 ? `${track.name} (segment ${s + 1})` : track.name) : null;
      const line = L.polyline(latlngs, { color, weight: 4, opacity: 0.9, className: 'gpx-track' }).addTo(map);
      if (title) line.bindTooltip(el('span', null, title), { sticky: true });
      bounds.extend(line.getBounds());
      if (!withDots) return;
      for (const p of seg) {
        L.circleMarker([p.lat, p.lon], {
          renderer: dots, radius: 3, color: '#1b1b1b', weight: 1, fillColor: color, fillOpacity: 1,
        }).bindPopup(() => pointPopup(p, track.name)).addTo(map);
      }
    });
    const first = segments[0]?.[0];
    const lastSeg = segments[segments.length - 1];
    const last = lastSeg?.[lastSeg.length - 1];
    // End first, start on top and smaller: on a closed loop both stay visible.
    if (last) {
      L.circleMarker([last.lat, last.lon], { radius: 8, color: '#ffffff', weight: 3, fillColor: '#e5243b', fillOpacity: 1, className: 'gpx-end' })
        .bindPopup(() => pointPopup(last, 'End')).addTo(map);
    }
    if (first) {
      L.circleMarker([first.lat, first.lon], { radius: 5, color: '#ffffff', weight: 2, fillColor: '#18c964', fillOpacity: 1, className: 'gpx-start' })
        .bindPopup(() => pointPopup(first, 'Start')).addTo(map);
    }
  });

  for (const route of gpx.routes) {
    const line = L.polyline(route.points.map((p) => [p.lat, p.lon]), {
      color: ROUTE_COLOR, weight: 3, opacity: 0.9, dashArray: '8 8', className: 'gpx-route',
    }).addTo(map);
    if (route.name) line.bindTooltip(el('span', null, route.name), { sticky: true });
    bounds.extend(line.getBounds());
  }

  for (const w of gpx.waypoints) {
    L.marker([w.lat, w.lon], { icon: pinIcon('#f5c400'), keyboard: false, title: w.name || '' })
      .bindPopup(() => pointPopup(w, w.name || 'Waypoint')).addTo(map);
    bounds.extend([w.lat, w.lon]);
  }
  return bounds;
}

async function main() {
  if (!src) {
    showError('No file given (?src= is missing).');
    return;
  }

  let text;
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (e) {
    showError(`Could not read the file (${e.message}).`);
    return;
  }

  let gpx;
  let summary;
  try {
    gpx = parseGpx(text);
    summary = summarize(gpx);
  } catch (e) {
    showError(e instanceof GpxError ? e.message : `Unexpected error: ${e.message}`);
    return;
  }

  renderInfo(gpx, summary);
  if (summary.elevation) renderProfile(gpx);

  const map = L.map('map', { keyboard: false, worldCopyJump: false });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank">Leaflet</a>');
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  map.setView([20, 0], 2); // a view first: layers added to a map without one are queued, which is very slow
  const bounds = drawGpx(map, gpx);
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
  } else {
    map.setView([20, 0], 2);
  }
  const switcher = layerSwitcher(map); // after the view is set: the grid needs the map bounds

  window.gpxViewer = { gpx, summary, map, selectLayer: (key) => switcher.select(key, true), layer: switcher.current };
  document.body.classList.add('loaded');
  post(`ready\t${summary.points} points, ${formatDistance(summary.distanceMeters)}`);
}

main().catch((e) => showError(`Unexpected error: ${e.message}`));
