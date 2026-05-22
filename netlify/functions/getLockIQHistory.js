// getLockIQHistory.js
// Query param: ?days=N  (1–90, default 7)
// Returns: array of lockiq_daily_history docs sorted oldest-first

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

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

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const raw  = parseInt(event.queryStringParameters?.days ?? "7", 10);
  const days = isNaN(raw) || raw < 1 ? 7 : Math.min(raw, 90);

  try {
    const db = getDb();

    // Calculate start date string (YYYY-MM-DD) — N calendar days ago
    const start = new Date();
    start.setDate(start.getDate() - days);
    const startStr = start.toISOString().slice(0, 10);

    const snap = await db
      .collection("lockiq_daily_history")
      .where("date", ">=", startStr)
      .orderBy("date", "asc")
      .limit(days + 2)   // small buffer for timezone edge cases
      .get();

    const docs = snap.docs.map((d) => d.data());

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(docs),
    };
  } catch (err) {
    console.error("getLockIQHistory error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Failed to fetch history", details: err.message }),
    };
  }
};
