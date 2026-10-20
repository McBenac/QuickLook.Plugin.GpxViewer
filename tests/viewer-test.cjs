// Browser test of the web viewer against the fixtures in tests/fixtures/ (values in expected.json).
//
//   NODE_PATH=<folder containing playwright-core> node tests/viewer-test.cjs [screenshot-dir]
//
// Set CHROMIUM to a Chromium/Chrome executable if Playwright's own browser is not installed.
// Map mode needs internet access for the tiles; everything else runs offline.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const expected = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/expected.json'), 'utf8')).viewer;
const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.gpx': 'application/gpx+xml' };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function iso(value) {
  return value ? new Date(value).toISOString().replace('.000Z', 'Z') : null;
}

async function open(page, base, fixture) {
  await page.goto(`${base}/viewer/index.html?src=../tests/fixtures/${encodeURIComponent(fixture)}`);
  await page.waitForFunction(() => document.body.classList.contains('loaded') || document.body.classList.contains('failed'));
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const failures = [];
  const check = (fixture, what, got, want) => {
    if (got !== want) failures.push(`${fixture}: ${what} is ${got}, expected ${want}`);
  };

  for (const [fixture, want] of Object.entries(expected)) {
    await open(page, base, fixture);

    if (want.error) {
      const shown = await page.evaluate(() => ({
        failed: document.body.classList.contains('failed'),
        text: document.getElementById('message').innerText,
      }));
      check(fixture, 'error page', shown.failed, true);
      console.log(`${fixture}: error page "${shown.text.replace(/\s+/g, ' ')}"`);
      if (shots) await page.screenshot({ path: path.join(shots, `${fixture}.error.png`) });
      continue;
    }

    const got = await page.evaluate(() => {
      const s = window.gpxViewer.summary;
      return {
        ...s,
        start: s.start && s.start.toISOString(),
        end: s.end && s.end.toISOString(),
        lines: document.querySelectorAll('path.gpx-track').length,
        dashed: document.querySelectorAll('path.gpx-route').length,
        pins: document.querySelectorAll('.gpx-pin').length,
        startMarkers: document.querySelectorAll('path.gpx-start').length,
        endMarkers: document.querySelectorAll('path.gpx-end').length,
        profile: !document.getElementById('profile').hidden,
        info: document.getElementById('info').innerText,
      };
    });
    for (const key of ['tracks', 'segments', 'routes', 'waypoints', 'points', 'durationSeconds', 'elevation']) {
      check(fixture, key, got[key], want[key]);
    }
    check(fixture, 'start', iso(got.start), want.start);
    check(fixture, 'end', iso(got.end), want.end);
    if (Math.abs(got.distanceMeters - want.distanceMeters) > 0.5) {
      failures.push(`${fixture}: distance ${got.distanceMeters.toFixed(1)} m, expected ${want.distanceMeters} m`);
    }
    check(fixture, 'track lines', got.lines, want.segments);
    check(fixture, 'dashed routes', got.dashed, want.routes);
    check(fixture, 'waypoint pins', got.pins, want.waypoints);
    check(fixture, 'start markers', got.startMarkers, want.tracks);
    check(fixture, 'end markers', got.endMarkers, want.tracks);
    check(fixture, 'elevation profile', got.profile, want.elevation);
    if (want.segments > 0 && !got.info.includes('Distance')) failures.push(`${fixture}: info box has no distance`);

    const span = got.start ? `${iso(got.start)} – ${iso(got.end)} (${got.durationSeconds} s)` : 'no timestamps';
    console.log(`${fixture}: ${got.tracks} tracks, ${got.segments} segments, ${got.routes} routes, `
      + `${got.waypoints} waypoints, ${got.points} points, ${(got.distanceMeters / 1000).toFixed(3)} km, ${span}`);

    if (shots) {
      for (const layer of ['map', 'none']) {
        await page.evaluate((key) => window.gpxViewer.selectLayer(key), layer);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(layer === 'map' ? 1500 : 200);
        const tiles = await page.evaluate(() => document.querySelectorAll('img.leaflet-tile-loaded').length);
        if (layer === 'map' && tiles === 0) failures.push(`${fixture}: no map tiles loaded`);
        if (layer === 'none' && tiles !== 0) failures.push(`${fixture}: ${tiles} map tiles in "No map" mode`);
        await page.screenshot({ path: path.join(shots, `${fixture}.${layer}.png`) });
      }
    }
  }

  // Long recordings (1 Hz for hours) must load well within the plugin's 20 s timeout. Generated on the fly.
  for (const n of [15000, 30000]) {
    let body = '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>';
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      body += `<trkpt lat="${(46.5 + 0.05 * Math.sin(a)).toFixed(6)}" lon="${(8 + 0.07 * Math.cos(a)).toFixed(6)}">`
        + `<ele>${(1000 + 200 * Math.sin(3 * a)).toFixed(1)}</ele><time>${t}</time></trkpt>`;
    }
    body += '</trkseg></trk></gpx>';
    await page.route((url) => url.pathname.endsWith(`/generated-${n}.gpx`), (route) => route.fulfill({ body, contentType: 'application/gpx+xml' }));
    const started = Date.now();
    await open(page, base, `generated-${n}.gpx`);
    const seconds = (Date.now() - started) / 1000;
    const points = await page.evaluate(() => window.gpxViewer?.summary.points);
    console.log(`generated-${n}.gpx: ${points} points loaded in ${seconds.toFixed(1)} s`);
    check(`generated-${n}.gpx`, 'points', points, n);
    if (seconds > 10) failures.push(`generated-${n}.gpx: took ${seconds.toFixed(1)} s (limit 10 s)`);
  }

  // The chosen layer is remembered for the next preview.
  await open(page, base, 'track-time-ele.gpx');
  await page.evaluate(() => window.gpxViewer.selectLayer('none'));
  await open(page, base, 'track-time-ele.gpx');
  check('layer choice', 'after reload', await page.evaluate(() => window.gpxViewer.layer()), 'none');
  await page.evaluate(() => window.gpxViewer.selectLayer('map'));

  for (const e of pageErrors) failures.push(`page error: ${e}`);
  await browser.close();
  server.close();

  if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`\nAll ${Object.keys(expected).length} fixtures OK`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
