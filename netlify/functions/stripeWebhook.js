const Stripe = require("stripe");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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
 * POST /stripe-webhook  (redirected from /.netlify/functions/stripeWebhook)
 *
 * Verifies Stripe signature then handles:
 *   checkout.session.completed    → users/{clerkUserId}  status=active
 *   customer.subscription.deleted → users/{clerkUserId}  status=inactive
 *   invoice.payment_failed        → users/{clerkUserId}  status=past_due
 *
 * Stripe sends the raw request body — Netlify exposes it as event.body (string).
 * If Netlify base64-encodes it, we decode before passing to constructEvent.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers["stripe-signature"];

  // Netlify may base64-encode binary bodies; decode if needed
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Stripe signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  const db = getDb();
  const usersCol = db.collection("users");

  try {
    switch (stripeEvent.type) {
      // ── Checkout completed → provision access ────────────────────────
      case "checkout.session.completed": {
        const session = stripeEvent.data.object;
        const clerkUserId = session.client_reference_id;

        if (!clerkUserId) {
          console.warn("checkout.session.completed missing client_reference_id");
          break;
        }

        // Fetch subscription to get trial_end
        let trialEnd = null;
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
        }

        await usersCol.doc(clerkUserId).set(
          {
            status: "active",
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            trial_end: trialEnd,
            created_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        console.log(`Provisioned user ${clerkUserId} — status=active`);
        break;
      }

      // ── Subscription cancelled → revoke access ───────────────────────
      case "customer.subscription.deleted": {
        const sub = stripeEvent.data.object;

        const snap = await usersCol
          .where("stripe_subscription_id", "==", sub.id)
          .limit(1)
          .get();

        if (!snap.empty) {
          await snap.docs[0].ref.update({ status: "inactive" });
          console.log(`User ${snap.docs[0].id} — status=inactive`);
        } else {
          console.warn(`No user found for subscription ${sub.id}`);
        }
        break;
      }

      // ── Payment failed → flag as past due ────────────────────────────
      case "invoice.payment_failed": {
        const invoice = stripeEvent.data.object;

        const snap = await usersCol
          .where("stripe_customer_id", "==", invoice.customer)
          .limit(1)
          .get();

        if (!snap.empty) {
          await snap.docs[0].ref.update({ status: "past_due" });
          console.log(`User ${snap.docs[0].id} — status=past_due`);
        } else {
          console.warn(`No user found for customer ${invoice.customer}`);
        }
        break;
      }

      default:
        // Ignore other event types
        break;
    }
  } catch (err) {
    console.error(`Error handling ${stripeEvent.type}:`, err);
    return { statusCode: 500, body: "Internal error processing webhook" };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
