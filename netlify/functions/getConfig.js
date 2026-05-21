/**
 * GET /.netlify/functions/getConfig
 *
 * Returns public client-side config. Only exposes the Clerk publishable key
 * (safe to be public — it is designed for client-side use).
 */
exports.handler = async () => {
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server misconfiguration: missing CLERK_PUBLISHABLE_KEY" }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      // Publishable key rarely changes — cache for 1 hour
      "Cache-Control": "public, max-age=3600",
    },
    body: JSON.stringify({
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    }),
  };
};
