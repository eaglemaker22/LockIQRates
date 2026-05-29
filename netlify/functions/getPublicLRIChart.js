// getPublicLRIChart.js — Public-safe LockIQ Rate Impact tick history for 1D chart
// Query param: ?date=YYYY-MM-DD  (defaults to today)
// Reads only: lri_ticks/{date}/ticks  — no MBS, UMBS, GNMA, or private model data
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// Whitelist of fields allowed in each point returned to the client.
const POINT_FIELDS = [
  "timestamp",
  "trading_date",
  "anchor_time",
  "anchor_label",
  "anchor_status",
  "confidence",
  "status",
  "conv_lri_bps",
  "gov_lri_bps",
  "conv_dollars_per_100k",
  "gov_dollars_per_100k",
  "conv_direction",
  "gov_direction",
];

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

function todayDateStr() {
  // Server date in UTC — acceptable for intraday chart use.
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function pickFields(raw) {
  const point = {};
  for (const key of POINT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      point[key] = raw[key];
    }
  }
  return point;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const rawDate = event.queryStringParameters?.date;
  const date    = (rawDate && isValidDate(rawDate)) ? rawDate : todayDateStr();

  try {
    const snap = await getDb()
      .collection("lri_ticks")
      .doc(date)
      .collection("ticks")
      .orderBy("timestamp", "asc")
      .get();

    const points = snap.docs.map((d) => pickFields(d.data()));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, date, count: points.length, points }),
    };
  } catch (err) {
    console.error("getPublicLRIChart error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Failed to load LRI chart data", details: err.message }),
    };
  }
};
