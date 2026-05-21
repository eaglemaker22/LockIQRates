const { verifyToken } = require("@clerk/backend");
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

/**
 * GET /.netlify/functions/checkSubscription
 * Headers: Authorization: Bearer <clerk-session-token>
 *
 * Returns: { status: 'active' | 'past_due' | 'inactive' | 'none' }
 */
exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // ── Verify Clerk token ───────────────────────────────────────────────────
  const authHeader = event.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: "Missing auth token" }) };
  }

  let userId;
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
  } catch (err) {
    console.error("Clerk token verification failed:", err.message);
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  // ── Look up subscription status in Firestore ─────────────────────────────
  try {
    const db = getDb();
    const doc = await db.collection("users").doc(userId).get();

    const status = doc.exists ? (doc.data().status || "none") : "none";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ status }),
    };
  } catch (err) {
    console.error("Firestore lookup failed:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to check subscription" }) };
  }
};
