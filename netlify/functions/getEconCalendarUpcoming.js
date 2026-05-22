const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

exports.handler = async () => {
  try {
    const doc = await db
      .collection("econ_calendar_focus")
      .doc("upcoming")
      .get();

    if (!doc.exists) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          events: [],
          message: "No upcoming events found"
        })
      };
    }

    const data = doc.data();

    return {
      statusCode: 200,
      body: JSON.stringify({
        events: data.events || [],
        event_count: data.event_count || 0,
        last_updated: data.last_updated || null
      })
    };

  } catch (error) {
    console.error("Error fetching upcoming calendar:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to fetch upcoming calendar",
        details: error.message
      })
    };
  }
};
