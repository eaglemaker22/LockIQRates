// getPublicMarketIndicators.js
// Public-safe market direction indicators for the LockIQ dashboard.
// Reads only market_data/shadow_bonds. Does NOT expose raw MBS coupon
// data, UMBS/GNMA prices, or any MBS input fields.

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

function r1(v) {
  return Math.round(v * 10) / 10;
}

// invertLogic=true  → yield up is Worse  (US10Y, US30Y)
// invertLogic=false → price up is Better (ZN, MBB)
function calcBias(change, invertLogic) {
  if (change === null || change === undefined || Math.abs(change) < 0.05) return "Neutral";
  return (invertLogic ? change < 0 : change > 0) ? "Better" : "Worse";
}

function row(id, label, current, changeBps, bias, updated, status) {
  return { id, label, current, today_change_bps: changeBps, bias, updated, status };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const db = getDb();
    const snap = await db.collection("market_data").doc("shadow_bonds").get();

    if (!snap.exists) {
      return {
        statusCode: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ ok: false, error: "Market data unavailable" }),
      };
    }

    const sb = snap.data();
    const fetchedAt = new Date().toISOString();

    const us10y    = n(sb.US10Y_Current);
    const us10yChg = n(sb.US10Y_Daily_Change); // % points → convert to bps below
    const us30y    = n(sb.US30Y_Current);
    const us30yChg = n(sb.US30Y_Daily_Change);
    const zn       = n(sb.ZN1_Current);
    const znChg    = n(sb.ZN1_Daily_Change);   // price points
    const mbb      = n(sb.MBB_Current);
    const mbbChg   = n(sb.MBB_Daily_Change);   // price points

    // Yield daily changes converted to bps for display
    const us10yBps = us10yChg !== null ? r1(us10yChg * 100) : 0;
    const us30yBps = us30yChg !== null ? r1(us30yChg * 100) : 0;

    // 10s/30s spread: (US30Y − US10Y) expressed in bps
    const sp1030    = (us10y !== null && us30y !== null)
      ? r1((us30y - us10y) * 100) : null;
    const sp1030Chg = (us10yChg !== null && us30yChg !== null)
      ? r1((us30yChg - us10yChg) * 100) : null;

    const indicators = [
      row("us10y", "US10Y Treasury Yield",
        us10y !== null ? us10y.toFixed(3) + "%" : null,
        us10yBps,
        calcBias(us10yBps, true),
        us10y !== null ? fetchedAt : null,
        us10y !== null ? "LIVE" : "UNAVAILABLE"),

      row("us30y", "US30Y Treasury Yield",
        us30y !== null ? us30y.toFixed(3) + "%" : null,
        us30yBps,
        calcBias(us30yBps, true),
        us30y !== null ? fetchedAt : null,
        us30y !== null ? "LIVE" : "UNAVAILABLE"),

      row("zn", "ZN Futures",
        zn !== null ? zn.toFixed(3) : null,
        znChg !== null ? r1(znChg) : 0,
        calcBias(znChg, false),
        zn !== null ? fetchedAt : null,
        zn !== null ? "LIVE" : "UNAVAILABLE"),

      row("mbb", "MBB",
        mbb !== null ? mbb.toFixed(2) : null,
        mbbChg !== null ? r1(mbbChg) : 0,
        calcBias(mbbChg, false),
        mbb !== null ? fetchedAt : null,
        mbb !== null ? "LIVE" : "UNAVAILABLE"),

      // Placeholder rows — server-side calculation pending
      row("mbs_tsy_spread",  "MBS–Treasury Spread",      null, 0, "Neutral", null, "PENDING"),
      row("ps_spread",        "Primary–Secondary Spread", null, 0, "Neutral", null, "PENDING"),
      row("curve_2s10s",      "2s/10s Curve Spread",           null, 0, "Neutral", null, "PENDING"),

      row("curve_10s30s", "10s/30s Curve Spread",
        sp1030 !== null ? sp1030.toFixed(1) + " bps" : null,
        sp1030Chg !== null ? sp1030Chg : 0,
        "Neutral",
        sp1030 !== null ? fetchedAt : null,
        sp1030 !== null ? "LIVE" : "UNAVAILABLE"),
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
