const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const { Resend } = require("resend");

admin.initializeApp();
const db = admin.firestore();

// Read secrets from environment variables (set in functions/.env)
const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY);

// ─── Rate Limiter (in-memory, per-instance) ──────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 30; // max requests per window per IP
const RATE_LIMIT_MAX_ENTRIES = 10000; // Max tracked IPs to prevent memory leak

function isRateLimited(ip) {
  const now = Date.now();
  // Periodic cleanup to prevent unbounded memory growth
  if (rateLimitMap.size > RATE_LIMIT_MAX_ENTRIES) {
    for (const [key, val] of rateLimitMap) {
      if (now - val.start > RATE_LIMIT_WINDOW) rateLimitMap.delete(key);
    }
  }
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

// ─── Health Check Endpoint ───────────────────────────────────────────
exports.healthCheck = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  // Rate limit health check endpoint
  const clientIp = req.headers["x-forwarded-for"] || req.ip || "unknown";
  if (isRateLimited(clientIp)) {
    res.status(429).send("Too many requests");
    return;
  }

  const start = Date.now();
  let firestoreOk = false;
  let stripeOk = false;

  // Test Firestore connectivity
  try {
    await db.collection("_healthcheck").doc("ping").set({
      timestamp: new Date().toISOString(),
    });
    firestoreOk = true;
  } catch (err) {
    console.error("Health check - Firestore failed:", err.message);
  }

  // Test Stripe connectivity
  try {
    await getStripe().balance.retrieve();
    stripeOk = true;
  } catch (err) {
    console.error("Health check - Stripe failed:", err.message);
  }

  const latency = Date.now() - start;
  const allOk = firestoreOk && stripeOk;

  // Only log to Firestore on degraded status (not every hit)
  if (!allOk) {
    try {
      await db.collection("healthLogs").add({
        timestamp: new Date().toISOString(),
        firestore: firestoreOk,
        stripe: stripeOk,
        latencyMs: latency,
        status: "degraded",
        source: "http",
      });
    } catch (e) { /* silent */ }
  }

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    checks: {
      firestore: firestoreOk ? "ok" : "fail",
      stripe: stripeOk ? "ok" : "fail",
    },
    latencyMs: latency,
    version: "1.0.0",
  });
});

// ─── Daily Metrics Snapshot (runs every day at midnight UTC) ─────────
exports.dailyMetricsSnapshot = functions.pubsub
  .schedule("every day 00:00")
  .timeZone("America/New_York")
  .onRun(async () => {
    try {
      const usersSnap = await db.collection("users").select("subscriptionStatus", "plan").get();
      let total = 0, active = 0, trial = 0, firms = 0, pastDue = 0, cancelled = 0;

      usersSnap.forEach((doc) => {
        const d = doc.data();
        total++;
        const s = d.subscriptionStatus || "trial";
        if (s === "active") active++;
        if (s === "trial") trial++;
        if (s === "past_due") pastDue++;
        if (s === "cancelled") cancelled++;
        if (d.plan === "firm" && s === "active") firms++;
      });

      const today = new Date().toISOString().split("T")[0];
      await db.collection("dailyMetrics").doc(today).set({
        date: today,
        totalUsers: total,
        activeSubscribers: active,
        trialUsers: trial,
        firmPlans: firms,
        pastDue: pastDue,
        cancelled: cancelled,
        capturedAt: new Date().toISOString(),
      });

      console.log("Daily metrics snapshot saved for", today);
    } catch (err) {
      console.error("Daily metrics snapshot failed:", err);
    }
    return null;
  });

// ─── Error Log Cleanup (runs weekly, keeps last 7 days) ─────────────
exports.cleanupErrorLogs = functions.pubsub
  .schedule("every monday 03:00")
  .timeZone("America/New_York")
  .onRun(async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffISO = cutoff.toISOString();

    try {
      const snap = await db.collection("errorLogs")
        .where("timestamp", "<", cutoffISO)
        .limit(400)
        .get();

      if (snap.empty) return null;

      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      console.log("Cleaned up", snap.size, "old error logs");
    } catch (err) {
      console.error("Error log cleanup failed:", err);
    }
    return null;
  });

// ─── Scheduled Daily Health Check (runs every 6 hours) ───────────────
// Automatically tests Firestore + Stripe connectivity and logs results.
// Also checks for error spikes and flags issues in the config collection.
exports.scheduledHealthCheck = functions.pubsub
  .schedule("every 6 hours")
  .timeZone("America/New_York")
  .onRun(async () => {
    const start = Date.now();
    let firestoreOk = false;
    let stripeOk = false;

    try {
      await db.collection("_healthcheck").doc("ping").set({
        timestamp: new Date().toISOString(),
      });
      firestoreOk = true;
    } catch (err) {
      console.error("Scheduled health check - Firestore failed:", err.message);
    }

    try {
      await getStripe().balance.retrieve();
      stripeOk = true;
    } catch (err) {
      console.error("Scheduled health check - Stripe failed:", err.message);
    }

    const latency = Date.now() - start;
    const allOk = firestoreOk && stripeOk;

    // Log the check
    try {
      await db.collection("healthLogs").add({
        timestamp: new Date().toISOString(),
        firestore: firestoreOk,
        stripe: stripeOk,
        latencyMs: latency,
        status: allOk ? "healthy" : "degraded",
        source: "scheduled",
      });
    } catch (logErr) {
      console.error("Failed to write health log:", logErr.message);
    }

    // Check for error spikes (more than 20 errors in last 24h = alert)
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const errorSnap = await db.collection("errorLogs")
        .where("timestamp", ">", cutoff)
        .select()  // Don't load full documents, only need the count
        .get();

      const errorCount = errorSnap.size;
      await db.collection("config").doc("systemHealth").set({
        lastCheckAt: new Date().toISOString(),
        status: allOk ? "healthy" : "degraded",
        firestoreOk,
        stripeOk,
        latencyMs: latency,
        errorsLast24h: errorCount,
        errorAlert: errorCount > 20,
      }, { merge: true });

      if (errorCount > 20) {
        console.warn("ERROR SPIKE DETECTED:", errorCount, "errors in last 24h");
      }
    } catch (err) {
      console.error("Error spike check failed:", err.message);
    }

    console.log("Scheduled health check complete:", allOk ? "healthy" : "DEGRADED", "| Latency:", latency + "ms");
    return null;
  });

exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  // Note: No IP-based rate limiting on webhooks — Stripe sends all events from shared IPs.
  // Signature verification below is the security gate.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.rawBody,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    res.status(400).send("Webhook signature verification failed");
    return;
  }

  console.log("Stripe event received:", event.type, event.id);

  // ── Idempotency: skip if we already processed this event ──
  try {
    const existing = await db.collection("processedEvents").doc(event.id).get();
    if (existing.exists && existing.data().status === "processed") {
      console.log("Duplicate event skipped:", event.id);
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
  } catch (err) {
    // If idempotency check fails, return 500 so Stripe retries later
    console.error("Idempotency check failed:", err.message);
    res.status(500).send("Temporary error, retry later");
    return;
  }

  try {
    switch (event.type) {
      // Payment successful — activate subscription
      case "checkout.session.completed": {
        const session = event.data.object;
        const clientRefId = session.client_reference_id; // Firebase UID
        const customerEmail = session.customer_details?.email;

        if (clientRefId) {
          await activateSubscription(clientRefId, session);
        } else if (customerEmail) {
          const uid = await findUserByEmail(customerEmail);
          if (uid) await activateSubscription(uid, session);
        }
        break;
      }

      // Subscription renewed successfully
      case "invoice.paid": {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const uid = await findUserByStripeCustomer(customerId);
        if (uid) {
          await db.collection("users").doc(uid).set({
            subscriptionStatus: "active",
            lastPaymentAt: new Date().toISOString(),
          }, { merge: true });
          console.log("Subscription renewed for user:", uid);
        }
        break;
      }

      // Payment failed
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const uid = await findUserByStripeCustomer(customerId);
        if (uid) {
          await db.collection("users").doc(uid).set({
            subscriptionStatus: "past_due",
            paymentFailedAt: new Date().toISOString(),
          }, { merge: true });
          console.log("Payment failed for user:", uid);
        }
        break;
      }

      // Subscription updated (plan change, trial conversion, etc.)
      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const uid = await findUserByStripeCustomer(customerId);
        if (uid) {
          const update = {
            subscriptionStatus: subscription.status === "active" ? "active"
              : subscription.status === "past_due" ? "past_due"
              : subscription.status === "trialing" ? "trial"
              : subscription.status,
            subscriptionUpdatedAt: new Date().toISOString(),
          };
          // Sync plan if present in metadata
          if (subscription.metadata?.plan) {
            const validPlans = ["individual", "firm"];
            if (validPlans.includes(subscription.metadata.plan)) {
              update.plan = subscription.metadata.plan;
            }
          }
          await db.collection("users").doc(uid).set(update, { merge: true });
          console.log("Subscription updated for user:", uid, "status:", subscription.status);
        }
        break;
      }

      // Subscription cancelled
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const uid = await findUserByStripeCustomer(customerId);
        if (uid) {
          await db.collection("users").doc(uid).set({
            subscriptionStatus: "cancelled",
            cancelledAt: new Date().toISOString(),
          }, { merge: true });
          console.log("Subscription cancelled for user:", uid);
        }
        break;
      }

      default:
        console.log("Unhandled event type:", event.type);
    }

    // Mark as processed AFTER successful handling
    await db.collection("processedEvents").doc(event.id).set({
      type: event.type,
      status: "processed",
      processedAt: new Date().toISOString(),
    });

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error processing webhook:", err);
    // Mark as failed so retries can proceed
    try {
      await db.collection("processedEvents").doc(event.id).set({
        type: event.type,
        status: "failed",
        error: err.message,
        failedAt: new Date().toISOString(),
      });
    } catch (e) { /* silent */ }
    res.status(500).send("Webhook processing error");
  }
});

// Activate a user's subscription
async function activateSubscription(uid, session) {
  const plan = session.metadata?.plan || "individual";
  const updateData = {
    subscriptionStatus: "active",
    plan: plan,
    subscribedAt: new Date().toISOString(),
    stripeCustomerId: session.customer || null,
    stripeSessionId: session.id,
    paymentPending: false,
  };

  if (plan === "firm") {
    updateData.firm = {
      members: [],
      memberEmails: [],
      maxSeats: 10,
      createdAt: new Date().toISOString(),
    };
  }

  await db.collection("users").doc(uid).set(updateData, { merge: true });
  console.log("Subscription activated for user:", uid, "plan:", plan);
}

// Find Firebase UID by email
async function findUserByEmail(email) {
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    return userRecord.uid;
  } catch (err) {
    console.warn("User not found by email:", email);
    return null;
  }
}

// Find Firebase UID by Stripe customer ID
async function findUserByStripeCustomer(customerId) {
  try {
    const snapshot = await db.collection("users")
      .where("stripeCustomerId", "==", customerId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.warn("No user found for Stripe customer:", customerId);
      return null;
    }
    return snapshot.docs[0].id;
  } catch (err) {
    console.error("Failed to find user by Stripe customer:", err.message);
    return null;
  }
}

// ─── Trial Expiration Enforcement (runs daily at 1am ET) ─────────────
// Server-side check — expires trials that have passed their end date.
// Prevents client-side bypass of trial gate.
exports.enforceTrialExpiration = functions.pubsub
  .schedule("every day 01:00")
  .timeZone("America/New_York")
  .onRun(async () => {
    const now = new Date().toISOString();
    try {
      const snap = await db.collection("users")
        .where("subscriptionStatus", "==", "trial")
        .where("trialEndsAt", "<", now)
        .select("trialEndsAt")  // Only fetch the field we need
        .limit(450)  // Stay under Firestore 500-op batch limit
        .get();

      if (snap.empty) {
        console.log("No trials to expire");
        return null;
      }

      const batch = db.batch();
      let expired = 0;

      snap.forEach((doc) => {
        batch.update(doc.ref, {
          subscriptionStatus: "trial_expired",
          trialExpiredAt: now,
        });
        expired++;
      });

      await batch.commit();
      console.log("Expired", expired, "trial accounts");
    } catch (err) {
      console.error("Trial expiration check failed:", err);
    }
    return null;
  });

// ─── Stripe Customer Portal ──────────────────────────────────────────
// Creates a Stripe billing portal session so users can manage their subscription.
exports.createPortalSession = functions.https.onRequest(async (req, res) => {
  // CORS
  res.set("Access-Control-Allow-Origin", "https://getnoteflowapp.com");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

  // Verify Firebase auth token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing auth token" });
    return;
  }

  try {
    const token = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    // Get user's Stripe customer ID
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists || !userDoc.data().stripeCustomerId) {
      res.status(400).json({ error: "No Stripe customer found for this account" });
      return;
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: userDoc.data().stripeCustomerId,
      return_url: "https://getnoteflowapp.com",
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Portal session creation failed:", err.message);
    res.status(500).json({ error: "Failed to create portal session" });
  }
});

// ─── User Data Export ────────────────────────────────────────────────
// Returns all of a user's data as JSON (GDPR compliance).
exports.exportUserData = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "https://getnoteflowapp.com");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing auth token" });
    return;
  }

  try {
    const token = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    // Gather all user data (GDPR Article 20 — include all personal data)
    const userDoc = await db.collection("users").doc(uid).get();
    const projectsSnap = await db.collection("users").doc(uid).collection("projects").get();
    const emailQueueSnap = await db.collection("emailQueue")
      .where("from", "==", decoded.email)
      .limit(500)
      .get();

    const projects = [];
    projectsSnap.forEach((doc) => {
      projects.push({ id: doc.id, ...doc.data() });
    });

    const emails = [];
    emailQueueSnap.forEach((doc) => {
      emails.push({ id: doc.id, ...doc.data() });
    });

    const exportData = {
      exportedAt: new Date().toISOString(),
      profile: userDoc.exists ? userDoc.data() : null,
      projects: projects,
      projectCount: projects.length,
      emailHistory: emails,
    };

    // Remove sensitive internal fields
    if (exportData.profile) {
      delete exportData.profile.stripeSessionId;
      delete exportData.profile.stripeCustomerId;
    }

    res.status(200).json(exportData);
  } catch (err) {
    console.error("Data export failed:", err.message);
    res.status(500).json({ error: "Failed to export data" });
  }
});

// ─── User Account Deletion ───────────────────────────────────────────
// Deletes all user data from Firestore and Firebase Auth (GDPR right to erasure).
exports.deleteUserAccount = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "https://getnoteflowapp.com");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing auth token" });
    return;
  }

  try {
    const token = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const email = decoded.email;

    // Don't let admin delete themselves
    if (email === "getnoteflowapp@gmail.com") {
      res.status(403).json({ error: "Cannot delete admin account" });
      return;
    }

    // Get user data first (need stripeCustomerId for Stripe cleanup)
    const userDoc = await db.collection("users").doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Delete Stripe customer if exists (GDPR right to erasure)
    if (userData.stripeCustomerId) {
      try {
        await getStripe().customers.del(userData.stripeCustomerId);
        console.log("Stripe customer deleted:", userData.stripeCustomerId);
      } catch (stripeErr) {
        console.warn("Stripe customer deletion failed (may already be deleted):", stripeErr.message);
      }
    }

    // Delete all projects + emailQueue in batches of 450 (Firestore limit is 500)
    const projectsSnap = await db.collection("users").doc(uid).collection("projects").get();
    const emailSnap = await db.collection("emailQueue")
      .where("from", "==", email)
      .limit(500)
      .get();

    const allDocs = [...projectsSnap.docs, ...emailSnap.docs];
    // Chunk into batches of 450 to stay under Firestore 500-op limit
    for (let i = 0; i < allDocs.length; i += 450) {
      const chunk = allDocs.slice(i, i + 450);
      const batch = db.batch();
      chunk.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }

    // Delete user document
    await db.collection("users").doc(uid).delete();

    // Delete Firebase Auth account
    await admin.auth().deleteUser(uid);

    console.log("User account deleted:", email, uid);
    res.status(200).json({ deleted: true });
  } catch (err) {
    console.error("Account deletion failed:", err.message);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

// ─── Processed Events Cleanup (runs weekly with error cleanup) ───────
// Cleans up old idempotency records (older than 30 days).
exports.cleanupProcessedEvents = functions.pubsub
  .schedule("every monday 03:30")
  .timeZone("America/New_York")
  .onRun(async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffISO = cutoff.toISOString();

    try {
      // Clean up successfully processed events
      const processedSnap = await db.collection("processedEvents")
        .where("processedAt", "<", cutoffISO)
        .limit(400)
        .get();

      // Also clean up failed events (stored with failedAt instead of processedAt)
      const failedSnap = await db.collection("processedEvents")
        .where("failedAt", "<", cutoffISO)
        .limit(400)
        .get();

      const allDocs = [...processedSnap.docs, ...failedSnap.docs];
      if (allDocs.length === 0) return null;

      // Deduplicate (a doc could theoretically match both queries)
      const seen = new Set();
      const batch = db.batch();
      let count = 0;
      allDocs.forEach((doc) => {
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          batch.delete(doc.ref);
          count++;
        }
      });
      await batch.commit();
      console.log("Cleaned up", count, "old processed event records");
    } catch (err) {
      console.error("Processed events cleanup failed:", err);
    }
    return null;
  });

// ─── Email Sending Function ───────────────────────────────────────────
// Triggered when a new document is created in the emailQueue collection.
// The client-side workflow system writes to emailQueue; this function
// picks it up, sends via Gmail SMTP, and marks it sent.

const getResend = () => new Resend(process.env.RESEND_API_KEY);

// HTML escape to prevent injection in emails
function escHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Email format validation
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

exports.sendQueuedEmail = functions.firestore
  .document("emailQueue/{emailId}")
  .onCreate(async (snap, context) => {
    const emailData = snap.data();

    // Skip if already sent (safety check)
    if (emailData.sent) {
      console.log("Email already marked sent, skipping:", context.params.emailId);
      return null;
    }

    // Validate required fields + email format
    if (!emailData.to || !emailData.subject || !isValidEmail(emailData.to)) {
      console.error("Missing/invalid fields (to, subject):", context.params.emailId);
      await snap.ref.update({ sent: false, error: "Missing or invalid required fields", processedAt: new Date().toISOString() });
      return null;
    }

    // Build a nice HTML email — ALL user input is HTML-escaped
    // Keys must match Firestore rules eventType whitelist (hyphenated format)
    const ALLOWED_EVENTS = {
      "assigned": "Assigned",
      "in-review": "Submitted for Review",
      "manager-approved": "Manager Approved",
      "partner-approved": "Partner Approved",
      "returned": "Returned for Revision",
      "comment": "New Comment",
    };

    // Only use predefined labels — don't trust raw eventType as display text
    const eventLabel = ALLOWED_EVENTS[emailData.eventType] || "Workflow Update";
    const projectName = escHtml(emailData.projectName || "a project");
    const safeMessage = escHtml(emailData.message || "");

    const htmlBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px 32px; border-radius: 12px 12px 0 0;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">📋 NoteFlow</h1>
        </div>
        <div style="background: #ffffff; padding: 32px; border: 1px solid #e2e8f0; border-top: none;">
          <h2 style="color: #1a202c; margin: 0 0 8px 0; font-size: 18px;">${eventLabel}</h2>
          <p style="color: #4a5568; margin: 0 0 20px 0; font-size: 15px;">
            Project: <strong>${projectName}</strong>
          </p>
          ${safeMessage ? `<div style="background: #f7fafc; border-left: 4px solid #667eea; padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
            <p style="color: #4a5568; margin: 0; font-size: 14px;">${safeMessage}</p>
          </div>` : ""}
          <p style="color: #718096; font-size: 13px; margin: 20px 0 0 0;">
            Log in to NoteFlow to view details and take action.
          </p>
        </div>
        <div style="background: #f7fafc; padding: 16px 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #a0aec0; font-size: 12px; margin: 0; text-align: center;">
            This is an automated notification from NoteFlow. Do not reply to this email.
          </p>
        </div>
      </div>
    `;

    try {
      const resend = getResend();

      // Sanitize subject: strip control chars, enforce length limit
      const safeSubject = (emailData.subject || "").replace(/[\r\n\t]/g, " ").substring(0, 200);

      await resend.emails.send({
        from: "NoteFlow <onboarding@resend.dev>",
        to: emailData.to,
        subject: `[NoteFlow] ${safeSubject}`,
        html: htmlBody,
      });

      await snap.ref.update({
        sent: true,
        sentAt: new Date().toISOString(),
        error: null,
      });

      console.log("Email sent successfully to:", emailData.to, "| Event:", emailData.eventType);
      return null;
    } catch (err) {
      console.error("Failed to send email:", err.message);

      await snap.ref.update({
        sent: false,
        error: err.message,
        processedAt: new Date().toISOString(),
      });

      return null;
    }
  });
