#!/usr/bin/env python3
"""Writes the synthetic test files in tests/fixtures/ and the values the viewer must show for them
(tests/fixtures/expected.json). All tracks are generated from formulas; no recorded GPS data.

Run with `python3 -B tools/make-fixtures.py` (no bytecode next to the script).
"""
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'
NS10 = 'http://www.topografix.com/GPX/1/0'
NS11 = 'http://www.topografix.com/GPX/1/1'
EARTH_RADIUS_M = 6371008.8  # mean Earth radius, same as viewer/gpx.js
START = datetime(2026, 1, 1, 9, 0, 0, tzinfo=timezone.utc)


def iso(t):
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def haversine(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def loop(lat0, lon0, n, radius, start, step_s, ele=None, phase=0.0):
    """n points on a wobbly loop around (lat0, lon0); radius in degrees of latitude."""
    pts = []
    for i in range(n):
        a = phase + 2 * math.pi * i / (n - 1)
        r = radius * (1 + 0.25 * math.sin(3 * a))
        lat = lat0 + r * math.sin(a)
        lon = lon0 + r * math.cos(a) / math.cos(math.radians(lat0))
        p = {'lat': round(lat, 6), 'lon': round(lon, 6)}
        if start is not None:
            p['time'] = start + timedelta(seconds=step_s * i)
        if ele is not None:
            p['ele'] = round(ele[0] + ele[1] * math.sin(a), 1)
        pts.append(p)
    return pts


def line(lat0, lon0, lat1, lon1, n, start, step_s):
    return [{'lat': round(lat0 + (lat1 - lat0) * i / (n - 1), 6),
             'lon': round(lon0 + (lon1 - lon0) * i / (n - 1), 6),
             'time': start + timedelta(seconds=step_s * i)} for i in range(n)]


def pt_xml(tag, p, indent):
    inner = ''
    if 'ele' in p:
        inner += f'<ele>{p["ele"]}</ele>'
    if 'time' in p:
        inner += f'<time>{iso(p["time"])}</time>'
    if 'name' in p:
        inner += f'<name>{p["name"]}</name>'
    return f'{indent}<{tag} lat="{p["lat"]}" lon="{p["lon"]}">{inner}</{tag}>\n'


def gpx_doc(ns, version, head, body):
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<gpx version="{version}" creator="make-fixtures" xmlns="{ns}">\n{head}{body}</gpx>\n')


def track_xml(name, segments):
    s = f'  <trk>\n    <name>{name}</name>\n'
    for seg in segments:
        s += '    <trkseg>\n' + ''.join(pt_xml('trkpt', p, '      ') for p in seg) + '    </trkseg>\n'
    return s + '  </trk>\n'


def expected(tracks=(), routes=(), waypoints=()):
    segments = [seg for _, segs in tracks for seg in segs]
    track_pts = [p for seg in segments for p in seg]
    dist = sum(haversine((a['lat'], a['lon']), (b['lat'], b['lon']))
               for seg in segments for a, b in zip(seg, seg[1:]))
    if not segments:
        dist = sum(haversine((a['lat'], a['lon']), (b['lat'], b['lon']))
                   for _, rte in routes for a, b in zip(rte, rte[1:]))
    times = sorted(p['time'] for p in track_pts + [p for _, r in routes for p in r] + list(waypoints) if 'time' in p)
    return {
        'tracks': len(tracks),
        'segments': len(segments),
        'routes': len(routes),
        'waypoints': len(waypoints),
        'points': len(track_pts),
        'distanceMeters': round(dist, 1),
        'start': iso(times[0]) if times else None,
        'end': iso(times[-1]) if times else None,
        'durationSeconds': int((times[-1] - times[0]).total_seconds()) if times else None,
        'elevation': any('ele' in p for p in track_pts),
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    files, exp = {}, {}

    # One track with time and elevation.
    hike = loop(46.55, 7.98, 121, 0.02, START, 30, ele=(1500, 300))
    files['track-time-ele.gpx'] = gpx_doc(NS11, '1.1',
        f'  <metadata>\n    <name>Synthetic hike</name>\n    <time>{iso(START)}</time>\n  </metadata>\n',
        track_xml('Loop', [hike]))
    exp['track-time-ele.gpx'] = expected(tracks=[('Loop', [hike])])

    # Two tracks, the first with two segments (a pause between them).
    t2 = START + timedelta(days=1)
    seg_a = line(46.60, 8.00, 46.62, 8.04, 40, t2, 20)
    seg_b = line(46.62, 8.05, 46.60, 8.09, 40, t2 + timedelta(hours=1), 20)
    seg_c = loop(46.58, 8.06, 50, 0.01, t2 + timedelta(hours=4), 25, phase=1.0)
    multi = [('Morning', [seg_a, seg_b]), ('Afternoon', [seg_c])]
    files['multi-segment.gpx'] = gpx_doc(NS11, '1.1', '', ''.join(track_xml(n, s) for n, s in multi))
    exp['multi-segment.gpx'] = expected(tracks=multi)

    # Waypoints and a planned route, no track and no timestamps.
    wpts = [{'lat': 46.57, 'lon': 7.95, 'name': 'Start'},
            {'lat': 46.59, 'lon': 7.99, 'name': 'Viewpoint'},
            {'lat': 46.56, 'lon': 8.02, 'name': 'Hut'}]
    rte = [{'lat': 46.57, 'lon': 7.95}, {'lat': 46.58, 'lon': 7.96}, {'lat': 46.59, 'lon': 7.99},
           {'lat': 46.58, 'lon': 8.01}, {'lat': 46.56, 'lon': 8.02}, {'lat': 46.555, 'lon': 8.03}]
    body = ''.join(pt_xml('wpt', w, '  ') for w in wpts)
    body += '  <rte>\n    <name>Planned route</name>\n' + ''.join(pt_xml('rtept', p, '    ') for p in rte) + '  </rte>\n'
    files['waypoints-route.gpx'] = gpx_doc(NS11, '1.1', '', body)
    exp['waypoints-route.gpx'] = expected(routes=[('Planned route', rte)], waypoints=wpts)

    # GPX 1.0 (name and time directly under <gpx>), written with a byte order mark.
    t3 = START + timedelta(days=2)
    old = line(46.50, 7.90, 46.53, 7.97, 30, t3, 60)
    files['gpx10.gpx'] = '﻿' + gpx_doc(NS10, '1.0',
        f'  <name>Old format</name>\n  <time>{iso(t3)}</time>\n', track_xml('Old track', [old]))
    exp['gpx10.gpx'] = expected(tracks=[('Old track', [old])])

    # Starts as GPX but is cut off: CanHandle accepts it, the viewer shows its error page.
    files['truncated.gpx'] = files['track-time-ele.gpx'][:len(files['track-time-ele.gpx']) // 2]
    exp['truncated.gpx'] = {'error': True}

    # Rejected by CanHandle.
    files['empty.gpx'] = ''
    files['broken.gpx'] = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="x"<trk>\n'
    files['not-gpx.gpx'] = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>\n')

    for name, text in files.items():
        (OUT / name).write_bytes(text.encode('utf-8'))
    detect = {name: name not in ('empty.gpx', 'broken.gpx', 'not-gpx.gpx') for name in sorted(files)}
    (OUT / 'expected.json').write_text(
        json.dumps({'detect': detect, 'viewer': exp}, indent=2) + '\n', encoding='utf-8')
    print(f'{len(files)} fixtures written to {OUT.name}/')


if __name__ == '__main__':
    main()
