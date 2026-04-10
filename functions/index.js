const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// Read secrets from environment variables (set in functions/.env)
const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY);

exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

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

  console.log("Stripe event received:", event.type);

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

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error processing webhook:", err);
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
  const snapshot = await db.collection("users")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  return snapshot.docs[0].id;
}
