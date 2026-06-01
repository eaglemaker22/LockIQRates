// getPublicMarketIndicators.js
// Public-safe market direction indicators for the LockIQ dashboard.
// Reads market_data/shadow_bonds (primary) and market_data/us30y_current
// (for US30Y daily change). Does NOT expose raw MBS coupon data,
// UMBS/GNMA prices, or any MBS input fields.
//
// Fields used from shadow_bonds:
//   US10Y_Current, delta_10Y          (10Y yield + change from today's open)
//   US30Y_Current                     (30Y yield; open/delta from us30y_current)
//   US2Y_Current,  delta_2Y           (2Y yield + change from today's open)
//   ZN1_Current,   delta_ZN           (10Y futures + change from today's open)
//   MBB_Current,   delta_MBB          (MBB ETF + change from today's open)
//
// Fields used from us30y_current:
//   US30Y_Daily_Change                (scraper-computed; "N/A" when prior close missing)
//   US30Y_Current, US30Y_PriorDayClose (fallback: compute change when Daily_Change is N/A)

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

function n(v) {
  const num = Number(v);
  return isNaN(num) ? null : num;
}

function r1(v) { return Math.round(v * 10) / 10; }
function r2(v) { return Math.round(v * 100) / 100; }

// invertLogic=true  → yield up is Worse  (US10Y, US30Y)
// invertLogic=false → price up is Better (ZN, MBB)
function calcBias(change, invertLogic) {
  if (change === null || change === undefined || Math.abs(change) < 0.05) return "Neutral";
  return (invertLogic ? change < 0 : change > 0) ? "Better" : "Worse";
}

function row(id, label, current, todayChangeBps, todayChangeValue, todayChangeUnit, bias, updated, status) {
  return {
    id,
    label,
    current,
    today_change_bps:   todayChangeBps,
    today_change_value: todayChangeValue,
    today_change_unit:  todayChangeUnit,
    bias,
    updated,
    status,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const db = getDb();

    // Parallel reads — shadow_bonds for most instruments, us30y_current for 30Y daily change
    const [sbSnap, us30ySnap] = await Promise.all([
      db.collection("market_data").doc("shadow_bonds").get(),
      db.collection("market_data").doc("us30y_current").get(),
    ]);

    if (!sbSnap.exists) {
      return {
        statusCode: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ ok: false, error: "Market data unavailable" }),
      };
    }

    const sb      = sbSnap.data();
    const us30yDoc = us30ySnap.exists ? us30ySnap.data() : {};
    const fetchedAt = new Date().toISOString();

    // Current prices / yields (from shadow_bonds)
    const us10y = n(sb.US10Y_Current);
    const us30y = n(sb.US30Y_Current);
    const us2y  = n(sb.US2Y_Current);
    const zn    = n(sb.ZN1_Current);
    const mbb   = n(sb.MBB_Current);

    // Scraper-computed deltas from today's open (null until market opens)
    const d10y  = n(sb.delta_10Y);   // yield % points → ×100 = bps
    const d2y   = n(sb.delta_2Y);    // yield % points
    const dZN   = n(sb.delta_ZN);    // price points (decimal)
    const dMBB  = n(sb.delta_MBB);   // price points

    // US10Y: change from today's open in bps
    const us10yBps = d10y !== null ? r1(d10y * 100) : null;

    // US30Y: daily change (current − prior close), yield % pts → bps
    // Two-step: (1) scraper-computed Daily_Change; (2) compute from Current − PriorDayClose.
    // Daily_Change is stored as "N/A" (string) when prior close is missing → n() → null.
    let us30yBps = null;
    const us30yDailyChg = n(us30yDoc.US30Y_Daily_Change);
    if (us30yDailyChg !== null) {
      us30yBps = r1(us30yDailyChg * 100);
    } else {
      const us30yCurDoc   = n(us30yDoc.US30Y_Current);
      const us30yPriorDoc = n(us30yDoc.US30Y_PriorDayClose);
      if (us30yCurDoc !== null && us30yPriorDoc !== null && us30yPriorDoc > 0) {
        us30yBps = r1((us30yCurDoc - us30yPriorDoc) * 100);
      }
    }

    // ZN: price-point change from today's open
    const znChg = dZN !== null ? r2(dZN) : null;

    // MBB: price-point change from today's open (displayed as pts, not bps)
    const mbbChg = dMBB !== null ? r2(dMBB) : null;

    // 2s/10s curve spread — both US2Y and US10Y available via shadow_bonds
    const sp2s10s    = (us2y !== null && us10y !== null)
      ? r1((us10y - us2y) * 100) : null;
    const sp2s10sChg = (d10y !== null && d2y !== null)
      ? r1((d10y - d2y) * 100) : null;

    // 10s/30s curve spread — no delta_30Y on shadow_bonds; change not calculable
    const sp10s30s = (us10y !== null && us30y !== null)
      ? r1((us30y - us10y) * 100) : null;

    const indicators = [
      // US10Y: change from today's open via delta_10Y
      row("us10y", "US10Y Treasury Yield",
        us10y !== null ? us10y.toFixed(3) + "%" : null,
        us10yBps,
        null,
        us10yBps !== null ? "bps" : null,
        calcBias(us10yBps, true),
        us10y !== null ? fetchedAt : null,
        us10y !== null ? "LIVE" : "UNAVAILABLE"),

      // US30Y: daily change (vs prior close) from us30y_current
      row("us30y", "US30Y Treasury Yield",
        us30y !== null ? us30y.toFixed(3) + "%" : null,
        us30yBps,
        null,
        us30yBps !== null ? "bps" : null,
        calcBias(us30yBps, true),
        us30y !== null ? fetchedAt : null,
        us30y !== null ? "LIVE" : "UNAVAILABLE"),

      // 10Y Futures (ZN): price-point change from today's open
      row("zn", "10Y Futures",
        zn !== null ? zn.toFixed(3) : null,
        null,
        znChg,
        znChg !== null ? "pts" : null,
        calcBias(dZN, false),
        zn !== null ? fetchedAt : null,
        zn !== null ? "LIVE" : "UNAVAILABLE"),

      // Mortgage Bond Momentum (MBB): price-point change from today's open, shown as pts
      row("mbb", "Mortgage Bond Momentum",
        mbb !== null ? mbb.toFixed(2) : null,
        null,
        mbbChg,
        mbbChg !== null ? "pts" : null,
        calcBias(dMBB, false),
        mbb !== null ? fetchedAt : null,
        mbb !== null ? "LIVE" : "UNAVAILABLE"),

      // Placeholders — underlying data not yet exposed publicly
      row("mbs_tsy_spread", "MBS–Treasury Spread",      null, null, null, null, "Neutral", null, "PENDING"),
      row("ps_spread",       "Primary–Secondary Spread", null, null, null, null, "Neutral", null, "PENDING"),

      // 2s/10s — both US10Y and US2Y data available via shadow_bonds
      row("curve_2s10s", "2s/10s Curve Spread",
        sp2s10s !== null ? sp2s10s.toFixed(1) + " bps" : null,
        sp2s10sChg,
        null,
        sp2s10sChg !== null ? "bps" : null,
        "Neutral",
        sp2s10s !== null ? fetchedAt : null,
        sp2s10s !== null ? "LIVE" : "UNAVAILABLE"),

      // 10s/30s — current spread computable; change not calculable (no delta_30Y)
      row("curve_10s30s", "10s/30s Curve Spread",
        sp10s30s !== null ? sp10s30s.toFixed(1) + " bps" : null,
        null,
        null,
        null,
        "Neutral",
        sp10s30s !== null ? fetchedAt : null,
        sp10s30s !== null ? "LIVE" : "UNAVAILABLE"),
    ];

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, updated_at: fetchedAt, indicators }),
    };
  } catch (err) {
    console.error("getPublicMarketIndicators error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Failed to fetch market indicators" }),
    };
  }
};
