/**
 * Live end-to-end pharmacy chain against a running local backend (synthetic data only).
 * prescribe -> patient order (delivery) -> pharmacist accept/start/ready/assign -> courier
 * accept/pickup/GPS -> patient sees courier -> deliver with patient OTP -> courier GPS hidden.
 *
 * Usage (backend running on :5000, demo data seeded with scripts/seedPharmacyDemo.js):
 *   node scripts/pharmacyLiveChain.js [patientId]
 * Doctor and patient test tokens are signed with the local JWT_SECRET; pharmacist and courier
 * sign in with the seeded demo logins (PHARMA_DEMO_PASSWORD). Never point this at production.
 */
require("dotenv").config();
const jwt = require("jsonwebtoken");

const BASE = process.env.CHAIN_BASE_URL || "http://localhost:5000";
const PATIENT = process.argv[2] || "P001";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("local backend only");

const step = (n, msg, extra = "") => console.log(`${String(n).padStart(2)}. ${msg}${extra ? "  " + extra : ""}`);
async function call(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${typeof json === "string" ? json.slice(0, 200) : JSON.stringify(json).slice(0, 300)}`);
  return json;
}

(async () => {
  const db = require("../db/model");
  const User = require("../models/User");
  const Pharmacy = require("../models/Pharmacy");
  const { staffAllowed } = require("../services/staffAccess");
  const doctor = (await User.find({}).lean()).find(u => u.role !== "patient" && u.email && staffAllowed(u.email)) || null;
  if (!doctor) throw new Error("no clinician user in DB; sign in once in the web app first");
  const secret = process.env.JWT_SECRET;
  const doctorToken = jwt.sign({ sub: String(doctor._id), role: doctor.role }, secret, { expiresIn: "15m" });
  const patientToken = jwt.sign({ sub: PATIENT, kind: "patient" }, secret, { expiresIn: "15m" });
  const central = await Pharmacy.findOne({ name: "MediCluster Central Pharmacy" }).lean();
  if (!central) throw new Error("seed demo pharmacies first");
  const pw = process.env.PHARMA_DEMO_PASSWORD;

  const rx = await call("POST", "/api/prescriptions", doctorToken, {
    patientId: PATIENT, pharmacyId: String(central._id), notes: "Live chain test (synthetic)",
    items: [{ drug: "Amoxicillin", strength: "500mg", dose: "1 capsule", frequency: "3x daily", durationDays: 5, quantity: 15 }],
  });
  const rxId = rx._id || rx.id || rx.prescription?._id;
  step(1, "Doctor prescribed Amoxicillin 500mg x15", `rx=${rxId}`);

  const order = await call("POST", `/api/patient-app/${PATIENT}/orders`, patientToken, {
    source: { type: "prescription", prescriptionId: rxId }, pharmacyId: String(central._id), fulfilment: "delivery",
    deliveryAddress: { text: "12 MG Road, Bengaluru", lat: 12.9756, lng: 77.6066 },
  });
  const orderId = order._id || order.id || order.order?._id;
  step(2, "Patient ordered for home delivery", `order=${orderId} status=${order.status || order.order?.status}`);

  const ph = await call("POST", "/api/pharmacy-auth/login", null, { email: "pharmacist.central@medicluster.demo", password: pw });
  step(3, "Pharmacist signed in", ph.staff?.name || "");
  let o;
  for (const action of ["accept", "start", "ready"]) {
    o = await call("POST", `/api/pharmacy/orders/${orderId}/actions`, ph.token, { action });
    step(4, `Pharmacist: ${action}`, `-> ${o.status || o.order?.status}`);
  }
  const couriers = await call("GET", `/api/pharmacy/couriers?pharmacyId=${central._id}`, ph.token);
  const list = Array.isArray(couriers) ? couriers : couriers.couriers || couriers.items || [];
  const courier = list[0];
  o = await call("POST", `/api/pharmacy/orders/${orderId}/actions`, ph.token, { action: "assign_courier", courierId: String(courier._id || courier.id) });
  step(5, `Pharmacist assigned courier ${courier.name || courier.phone}`, `-> ${o.status || o.order?.status}`);

  const co = await call("POST", "/api/courier-auth/login", null, { phone: courier.phone, pin: pw });
  step(6, "Courier signed in", co.staff?.name || "");
  const dl = await call("GET", "/api/courier/deliveries", co.token);
  const dlist = Array.isArray(dl) ? dl : dl.deliveries || dl.items || [];
  const delivery = dlist.find(d => String(d.orderId?._id || d.orderId || d.order?._id) === String(orderId));
  if (!delivery) throw new Error(`courier has no delivery for order ${orderId} (saw ${dlist.length})`);
  const deliveryId = String(delivery._id || delivery.id);
  try { await call("POST", `/api/courier/deliveries/${deliveryId}/accept`, co.token); step(7, "Courier accepted delivery", `delivery=${deliveryId}`); }
  catch (e) { step(7, "Courier accept skipped", e.message.slice(0, 90)); }
  o = await call("POST", `/api/courier/deliveries/${deliveryId}/actions`, co.token, { action: "pickup" });
  step(8, "Courier picked up", `-> ${o.status || o.order?.status}`);
  await call("POST", `/api/courier/deliveries/${deliveryId}/location`, co.token, { lat: 12.9716, lng: 77.5946, observedAt: new Date().toISOString() });
  step(9, "Courier shared live GPS (12.9716, 77.5946)");

  const seen = await call("GET", `/api/patient-app/${PATIENT}/orders/${orderId}`, patientToken);
  const so = seen.order || seen;
  const loc = so.courier?.lastLocation || so.courierLocation || so.lastLocation;
  const otp = so.handoverOtp || so.otp || seen.otp;
  step(10, "Patient tracking view", `status=${so.status} courier GPS=${loc ? `${loc.lat},${loc.lng}` : "none"} OTP=${otp ? "shown" : "missing"}`);

  o = await call("POST", `/api/courier/deliveries/${deliveryId}/actions`, co.token, { action: "deliver", otp });
  step(11, "Courier delivered with patient OTP", `-> ${o.status || o.order?.status}`);

  const after = await call("GET", `/api/patient-app/${PATIENT}/orders/${orderId}`, patientToken);
  const ao = after.order || after;
  const hidden = !(ao.courier?.lastLocation || ao.courierLocation || ao.lastLocation);
  step(12, "Patient view after delivery", `status=${ao.status} courier GPS hidden=${hidden}`);
  console.log(hidden && ao.status === "delivered" ? "\nCHAIN PASSED" : "\nCHAIN FINISHED WITH ISSUES");
  if (db.close) await db.close().catch(() => {});
  process.exit(0);
})().catch(e => { console.error("CHAIN FAILED:", e.message); process.exit(1); });
