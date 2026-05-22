const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// Initialize Firebase Admin once (Netlify functions may be warm-reused)
function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Netlify stores multi-line env vars with literal \n — restore newlines
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

/**
 * GET /.netlify/functions/getMarketData
 *
 * Returns a JSON object with the latest documents from:
 *   market_data/shadow_bonds
 *   market_data/mbs_products
 *   market_data/us10y_current
 *   market_data/broker_rates
 *   market_data/fred_cache
 *   market_data/econ_calendar      (legacy)
 *   econ_calendar_focus/today      (today's high-impact events)
 *   econ_calendar_focus/upcoming   (next 7-day events)
 */
exports.handler = async (event) => {
  // Only allow GET requests
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const db = getDb();
    const marketDataRef = db.collection("market_data");
    const calFocusRef  = db.collection("econ_calendar_focus");

    // Fetch all documents in parallel
    const [
      shadowBonds, mbsProducts, us10y, brokerRates, fredCache, econCalendar,
      calToday, calUpcoming,
    ] = await Promise.all([
      marketDataRef.doc("shadow_bonds").get(),
      marketDataRef.doc("mbs_products").get(),
      marketDataRef.doc("us10y_current").get(),
      marketDataRef.doc("broker_rates").get(),
      marketDataRef.doc("fred_cache").get(),
      marketDataRef.doc("econ_calendar").get(),
      calFocusRef.doc("today").get(),
      calFocusRef.doc("upcoming").get(),
    ]);

    const payload = {
      shadow_bonds:  shadowBonds.exists  ? shadowBonds.data()  : null,
      mbs_products:  mbsProducts.exists  ? mbsProducts.data()  : null,
      us10y_current: us10y.exists        ? us10y.data()        : null,
      broker_rates:  brokerRates.exists  ? brokerRates.data()  : null,
      fred_cache:    fredCache.exists    ? fredCache.data()    : null,
      econ_calendar: econCalendar.exists ? econCalendar.data() : null,
      econ_calendar_today:    calToday.exists    ? calToday.data()    : null,
      econ_calendar_upcoming: calUpcoming.exists ? calUpcoming.data() : null,
      fetched_at: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Prevent clients from caching stale market data
        "Cache-Control": "no-store",
      },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error("getMarketData error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch market data" }),
    };
  }
};
