// netlify/functions/getScrubChart.js
// =====================================================================
// LockIQ — Rate Impact scrubber data endpoint
// Returns the LRI series in the EXACT shape the scrub chart consumes:
//   { range, tz, asOf, series:[{t, conv_bps, gov_bps}], presets:{open,rateSheets,prevClose} }
//
//   ?range=1d  -> today only, from market_data/lockiq_intraday_chart   (PRODUCTION-CORRECT)
//   ?range=5d  -> today + prior 4 archived days, stitched continuous
//   ?range=1m  -> today + prior ~21 archived days, stitched continuous
//
// DATA SOURCES (index/synthetic only — NO raw UMBS/GNMA ever touches this payload):
//   market_data/lockiq_intraday_chart  -> { points:[{label, conv_index_pts, govt_index_pts, quality, ...}], date }
//   lockiq_daily_history/{YYYY-MM-DD}   -> { points:[ ...same shape... ] }   (archived 5:05 PM AZ)
//
// UNITS: stored values are in POINTS. chart wants bps-of-price where bps = points * 100.
//        (your builder: conv_index_pts 0.0204 == 2.0 bps). points = bps/100, so bps = pts*100.
//
// CONTINUITY: each day's points are deltas vs THAT day's 0715 anchor, so days don't
//        share a zero. For multi-day we seam-align each new day's first point to the prior
//        day's last value -> one continuous line, no morning reset.
//        ⚠ This flattens the overnight close→open gap. Preserving it needs the
//        daily_anchors close→open delta (the anchor-enrichment we scoped separately).
//        For range=1d this is irrelevant; the day is already continuous.
// =====================================================================

const admin = require('firebase-admin');

// --- Firebase init (match the env var / parsing your other functions already use) -----
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

// --- adapter knobs: confirm these against your Firestore --------------------------------
const CHART_DOC          = 'market_data/lockiq_intraday_chart';
const DAILY_COLL         = 'lockiq_daily_history';
const DAILY_POINTS_FIELD = 'points';        // confirm vs lockiq_daily_snapshot.py output
const POINTS_FIELD       = 'points';
const CONV_FIELD         = 'conv_index_pts';
const GOV_FIELD          = 'govt_index_pts';
const LABEL_FIELD        = 'label';
const ANCHOR_MIN         = 7 * 60 + 15;     // 7:15 AM AZ — for the "Since Rate Sheets" preset
const RANGE_DAYS         = { '1d': 0, '5d': 4, '1m': 21 }; // archived days to prepend

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

function labelToMin(label) {
  const m = /(\d+):(\d+)\s*(AM|PM)/i.exec(label || '');
  if (!m) return null;
  let h = (+m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + (+m[2]);
}

// pull only the whitelisted index fields out of a stored point (raw UMBS can never leak)
function mapPoint(p) {
  const c = num(p[CONV_FIELD]);
  const g = num(p[GOV_FIELD]);
  if (c === null && g === null) return null;
  return { t: p[LABEL_FIELD], conv_pts: c ?? 0, gov_pts: g ?? 0 };
}

function segPoints(raw) {
  return (Array.isArray(raw) ? raw : []).map(mapPoint).filter(Boolean);
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',   // tighten to your domain in prod
    'Cache-Control': 'no-store',
  };

  try {
    const range = (event.queryStringParameters?.range || '1d');
    const priorN = RANGE_DAYS[range] ?? 0;

    // 1) TODAY — from the live intraday chart doc
    const chartSnap = await db.doc(CHART_DOC).get();
    const chart = chartSnap.exists ? chartSnap.data() : null;
    const todayDate = chart?.date || null;
    const todaySeg = { date: todayDate, isToday: true, points: segPoints(chart?.[POINTS_FIELD]) };

    // 2) PRIOR DAYS — most recent N archived docs (skip today's, which lives in the chart doc)
    let priorSegs = [];
    if (priorN > 0) {
      const snap = await db.collection(DAILY_COLL)
        .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
        .limit(priorN + 1)              // +1 cushion in case today is already archived
        .get();
      priorSegs = snap.docs
        .filter(d => d.id !== todayDate)
        .slice(0, priorN)
        .map(d => ({ date: d.id, isToday: false, points: segPoints(d.data()?.[DAILY_POINTS_FIELD]) }))
        .reverse();                     // chronological: oldest -> newest
    }

    // 3) STITCH into a continuous backbone (seam-align each day to the prior day's last value)
    const segments = [...priorSegs, todaySeg].filter(s => s.points.length);
    if (!segments.length) {
      return { statusCode: 200, headers, body: JSON.stringify(
        { range, tz: 'AZ', asOf: null, series: [], presets: { open: 0, rateSheets: 0, prevClose: 0 }, state: 'no_data' }) };
    }

    const out = [];
    let prevConv = null, prevGov = null, todayStartIdx = 0;
    for (const seg of segments) {
      const offC = prevConv === null ? 0 : prevConv - seg.points[0].conv_pts;
      const offG = prevGov  === null ? 0 : prevGov  - seg.points[0].gov_pts;
      if (seg.isToday) todayStartIdx = out.length;
      for (const p of seg.points) {
        out.push({ t: p.t, conv_pts: p.conv_pts + offC, gov_pts: p.gov_pts + offG });
      }
      prevConv = out[out.length - 1].conv_pts;
      prevGov  = out[out.length - 1].gov_pts;
    }

    // 4) to the chart's wire shape (bps = pts * 100)
    const series = out.map(p => ({
      t: p.t,
      conv_bps: +(p.conv_pts * 100).toFixed(1),
      gov_bps:  +(p.gov_pts  * 100).toFixed(1),
    }));

    // 5) presets (indices into series)
    //    open       = first point of today
    //    prevClose  = last point of the prior day (or open, if single-day)
    //    rateSheets = today's point nearest the 7:15 anchor
    let rateSheets = todayStartIdx;
    let best = Infinity;
    for (let i = todayStartIdx; i < out.length; i++) {
      const m = labelToMin(series[i].t);
      if (m === null) continue;
      const d = Math.abs(m - ANCHOR_MIN);
      if (d < best) { best = d; rateSheets = i; }
    }
    const presets = {
      open: todayStartIdx,
      rateSheets,
      prevClose: todayStartIdx > 0 ? todayStartIdx - 1 : todayStartIdx,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        range,
        tz: 'AZ',
        asOf: series[series.length - 1]?.t || null,
        series,
        presets,
        todayStartIdx,                 // handy if the UI wants to mark the day boundary
        state: 'live',
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'getScrubChart failed', detail: String(err?.message || err) }),
    };
  }
};
