const Stripe = require("stripe");
const { verifyToken } = require("@clerk/backend");

/**
 * POST /.netlify/functions/createCheckoutSession
 *
 * Headers:
 *   Authorization: Bearer <clerk-session-token>
 *
 * Creates a Stripe Checkout session (subscription mode) with:
 *   - 7-day free trial
 *   - Card always required (no card-less trials)
 *   - success_url → /app.html
 *   - cancel_url  → /
 *
 * Returns: { url: string }  — the Stripe-hosted checkout URL to redirect to.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // ── 1. Verify Clerk session ──────────────────────────────────────────────
  const authHeader = event.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Missing auth token" }),
    };
  }

  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    userId = payload.sub;
  } catch (err) {
    console.error("Clerk token verification failed:", err.message);
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  // ── 2. Create Stripe Checkout session ────────────────────────────────────
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const origin = event.headers.origin || "https://lockiqrates.com";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      // Card is always collected even during trial
      payment_method_collection: "always",
      // client_reference_id is how the webhook identifies the Clerk user
      client_reference_id: userId,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 7,
        metadata: { clerk_user_id: userId },
      },
      // ?checkout=complete tells app.html the user just finished Stripe
      success_url: `${origin}/app.html?checkout=complete`,
      cancel_url: `${origin}/`,
      metadata: { clerk_user_id: userId },
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error("Stripe checkout creation failed:", err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to create checkout session" }),
    };
  }
};
