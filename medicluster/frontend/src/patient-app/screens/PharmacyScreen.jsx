import React, { useCallback, useEffect, useState, useRef } from "react";
import { useLocation } from "react-router-dom";
import { usePatient, TabBar } from "../PatientApp";
import { Body, ErrorNote } from "../ui";
import { PatientHeading, PatientViews, PatientList } from "../PatientComponents";
import {
  getPatientPrescriptions,
  getNearbyPharmacies,
  getOrders,
  getOrder,
  createOrder,
  cancelOrder,
  requestRefill,
  ORDER_STATUS_LABELS,
  shouldShowCourierLocation,
  shouldShowHandoverOtp,
  sanitizeOrderForPatient,
  getOrderTimeline,
} from "../../pharmacy/patientApi";
import CourierTrackingMap from "./CourierTrackingMap";
import {
  Pill,
  ShoppingBag,
  Clock,
  MapPin,
  CheckCircle2,
  AlertCircle,
  Truck,
  Building2,
  ChevronRight,
  ArrowLeft,
  KeyRound,
  RotateCw,
} from "lucide-react";

const POLL_INTERVAL_MS = 5_000;

export default function PharmacyScreen() {
  const { patientId, reminders, offlineStatus, apiError } = usePatient();
  const location = useLocation();

  const [view, setView] = useState("orders"); // "orders" | "prescriptions" | "order"
  const [orders, setOrders] = useState([]);
  const [prescriptions, setPrescriptions] = useState([]);
  const [pharmacies, setPharmacies] = useState([]);

  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);

  // New Order Form state
  const [selectedRxId, setSelectedRxId] = useState("");
  const [selectedRefillReminderId, setSelectedRefillReminderId] = useState("");
  const [selectedPharmacyId, setSelectedPharmacyId] = useState("");
  const [fulfilment, setFulfilment] = useState("delivery"); // "pickup" | "delivery"
  const [deliveryAddressText, setDeliveryAddressText] = useState("");
  const [deliveryLat, setDeliveryLat] = useState(12.9716);
  const [deliveryLng, setDeliveryLng] = useState(77.5946);

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [statusNotice, setStatusNotice] = useState("");

  const isMounted = useRef(true);

  // Check query params for initial route / pre-selection
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const refillId = params.get("refillReminderId");
    const rxId = params.get("prescriptionId");

    if (refillId) {
      setSelectedRefillReminderId(refillId);
      setView("order");
    } else if (rxId) {
      setSelectedRxId(rxId);
      setView("order");
    }
  }, [location.search]);

  // Load Prescriptions & Pharmacies
  const loadStaticData = useCallback(async () => {
    if (!patientId) return;
    try {
      const [rxData, pharmData] = await Promise.all([
        getPatientPrescriptions(patientId).catch(() => []),
        getNearbyPharmacies(patientId).catch(() => []),
      ]);
      if (!isMounted.current) return;
      const rxList = Array.isArray(rxData) ? rxData : rxData?.items || [];
      setPrescriptions(rxList);
      setPharmacies(Array.isArray(pharmData) ? pharmData : []);
      if (rxList.length > 0 && !selectedRxId) {
        setSelectedRxId(rxList[0]._id || rxList[0].id);
      }
      if (pharmData.length > 0 && !selectedPharmacyId) {
        setSelectedPharmacyId(pharmData[0]._id || pharmData[0].id);
      }
    } catch (err) {
      if (isMounted.current) setError(apiError(err));
    }
  }, [patientId, selectedRxId, selectedPharmacyId, apiError]);

  // Load & Refresh Orders
  const refreshOrders = useCallback(async () => {
    if (!patientId) return;
    try {
      const ordersData = await getOrders(patientId);
      if (!isMounted.current) return;
      const list = Array.isArray(ordersData) ? ordersData : ordersData?.items || [];
      const sanitizedList = list.map(sanitizeOrderForPatient);
      setOrders(sanitizedList);

      // If viewing a specific order, refresh its detail
      if (selectedOrderId) {
        try {
          const detail = await getOrder(patientId, selectedOrderId);
          if (isMounted.current && detail) {
            setSelectedOrder(sanitizeOrderForPatient(detail));
          }
        } catch {
          // If individual detail fetch fails, find in list
          const found = sanitizedList.find((o) => (o._id || o.id) === selectedOrderId);
          if (found && isMounted.current) setSelectedOrder(found);
        }
      }
    } catch (err) {
      if (isMounted.current && !selectedOrder) {
        setError(apiError(err));
      }
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [patientId, selectedOrderId, selectedOrder, apiError]);

  useEffect(() => {
    isMounted.current = true;
    loadStaticData();
    refreshOrders();

    // 5-second polling interval for live status & courier tracking
    const interval = setInterval(() => {
      if (!offlineStatus.offline) {
        refreshOrders();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      isMounted.current = false;
      clearInterval(interval);
    };
  }, [loadStaticData, refreshOrders, offlineStatus.offline]);

  // Handle Order Selection
  const handleSelectOrder = async (order) => {
    const oId = order._id || order.id;
    setSelectedOrderId(oId);
    setSelectedOrder(sanitizeOrderForPatient(order));
    setError("");
    setStatusNotice("");
    try {
      const detail = await getOrder(patientId, oId);
      if (isMounted.current && detail) {
        setSelectedOrder(sanitizeOrderForPatient(detail));
      }
    } catch {
      // Use fallback
    }
  };

  // Place Order Submit
  const handlePlaceOrder = async (e) => {
    e.preventDefault();
    setError("");
    setStatusNotice("");

    if (!selectedPharmacyId) {
      setError("Please select a pharmacy to fulfill your order.");
      return;
    }

    if (fulfilment === "delivery" && !deliveryAddressText.trim()) {
      setError("Please provide your delivery address.");
      return;
    }

    setSubmitting(true);
    try {
      const orderPayload = {
        pharmacyId: selectedPharmacyId,
        fulfilment,
        source: selectedRefillReminderId
          ? { type: "refill", reminderId: selectedRefillReminderId }
          : { type: "prescription", prescriptionId: selectedRxId },
      };

      if (fulfilment === "delivery") {
        orderPayload.deliveryAddress = {
          text: deliveryAddressText.trim(),
          lat: deliveryLat,
          lng: deliveryLng,
        };
      }

      const created = await createOrder(patientId, orderPayload);
      const sanitized = sanitizeOrderForPatient(created);
      setStatusNotice("Your order has been placed successfully!");
      setSelectedOrderId(sanitized._id || sanitized.id);
      setSelectedOrder(sanitized);
      setView("orders");
      await refreshOrders();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Cancel Order
  const handleCancelOrder = async () => {
    if (!selectedOrder) return;
    const oId = selectedOrder._id || selectedOrder.id;
    setSubmitting(true);
    setError("");
    try {
      const result = await cancelOrder(patientId, oId);
      setStatusNotice("Order cancelled.");
      setSelectedOrder(sanitizeOrderForPatient(result));
      await refreshOrders();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Request Refill from Order
  const handleRequestRefill = async (order) => {
    setSubmitting(true);
    setError("");
    try {
      const reminderId = order?.source?.reminderId;
      if (reminderId) {
        await requestRefill(reminderId);
        setStatusNotice("Refill requested successfully.");
      } else {
        // Pre-select prescription and open order view
        const rxId = order?.source?.prescriptionId;
        if (rxId) {
          setSelectedRxId(rxId);
          setView("order");
        }
      }
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const pharmacyMap = new Map(pharmacies.map((p) => [p._id || p.id, p]));

  // Selected Order details
  const activePharmacy = selectedOrder?.pharmacyId ? pharmacyMap.get(selectedOrder.pharmacyId) : null;
  const isDelivery = selectedOrder?.fulfilment === "delivery";
  const isOutForDelivery = selectedOrder?.status === "out_for_delivery";
  const isDelivered = selectedOrder?.status === "delivered";
  const canCancel = ["new", "accepted", "preparing"].includes(String(selectedOrder?.status || "").toLowerCase());
  const showOtp = shouldShowHandoverOtp(selectedOrder?.status) && Boolean(selectedOrder?.handoverOtp);
  const showMap = isDelivery && isOutForDelivery && Boolean(selectedOrder?.courierLocation || selectedOrder?.delivery?.lastLocation);
  const timelineSteps = selectedOrder ? getOrderTimeline(selectedOrder) : [];

  return (
    <>
      <Body className="pt-view">
        <PatientHeading
          title="Pharmacy"
          sub="Prescriptions, orders & live delivery."
          actions={
            view !== "order" && (
              <button
                type="button"
                className="pt-button-secondary"
                onClick={() => {
                  setSelectedOrderId(null);
                  setSelectedOrder(null);
                  setView("order");
                }}
                disabled={offlineStatus.offline}
              >
                + New order
              </button>
            )
          }
        />

        <ErrorNote>{error}</ErrorNote>

        {statusNotice && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center gap-2">
            <CheckCircle2 size={15} className="shrink-0" />
            <span>{statusNotice}</span>
          </div>
        )}

        {/* View Switcher Tabs (hidden when inspecting a single order) */}
        {!selectedOrder && (
          <PatientViews
            label="Pharmacy sections"
            value={view}
            onChange={(v) => {
              setView(v);
              setError("");
              setStatusNotice("");
            }}
            options={[
              { id: "orders", label: `Orders (${orders.length})` },
              { id: "prescriptions", label: `Prescriptions (${prescriptions.length})` },
              { id: "order", label: "Place order" },
            ]}
          />
        )}

        {/* ── View 1: Order Detail & Tracking ────────────────────────────── */}
        {selectedOrder ? (
          <section className="pt-card pt-grow pt-stack overflow-y-auto">
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-line">
              <button
                type="button"
                className="pt-text-button flex items-center gap-1 text-xs"
                onClick={() => {
                  setSelectedOrderId(null);
                  setSelectedOrder(null);
                }}
              >
                <ArrowLeft size={14} />
                <span>Back to orders</span>
              </button>

              <span className="font-mono text-[11px] text-slate-500">
                Poll: 5s
              </span>
            </div>

            {/* Order Status Badge & Pharmacy */}
            <div className="flex items-start justify-between gap-3 pt-1">
              <div>
                <span className="text-[11px] font-mono text-slate-500">
                  Order #{String(selectedOrder._id || selectedOrder.id).slice(-8)}
                </span>
                <h2 className="text-lg font-semibold text-ink mt-0.5">
                  {ORDER_STATUS_LABELS[selectedOrder.status] || selectedOrder.status}
                </h2>
                <p className="text-xs text-slate-600 mt-1">
                  {activePharmacy ? activePharmacy.name : "Local Partner Pharmacy"}
                  {isDelivery ? " · Home delivery" : " · Pharmacy counter pickup"}
                </p>
              </div>

              <span
                className={`pt-pill ${
                  isDelivered || selectedOrder.status === "picked_up"
                    ? "pt-positive"
                    : selectedOrder.status === "cancelled" || selectedOrder.status === "rejected"
                    ? "bg-red-50 text-red-700"
                    : "bg-emerald-50 text-emerald-800"
                }`}
              >
                {selectedOrder.status}
              </span>
            </div>

            {/* Handover OTP (Spec 4.2 & 4.5: shown when ready or out_for_delivery) */}
            {showOtp && (
              <div className="p-4 bg-emerald-50/80 border border-emerald-300 rounded-2xl flex flex-col gap-1.5 shadow-sm">
                <div className="flex items-center gap-2 text-emerald-900 font-semibold text-xs">
                  <KeyRound size={15} />
                  <span>Handover Verification OTP</span>
                </div>
                <div className="text-2xl font-mono font-bold tracking-widest text-emerald-950 py-1">
                  {selectedOrder.handoverOtp}
                </div>
                <p className="text-[11.5px] text-emerald-800 leading-normal">
                  Give this 4-digit code to the {isDelivery ? "courier" : "pharmacist"} when you receive your medications.
                </p>
              </div>
            )}

            {/* Delivery Tracking Map (Spec 4.5: shown ONLY while out_for_delivery, HIDDEN once delivered) */}
            {isDelivery && (
              <div className="flex flex-col gap-2 pt-2">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span className="flex items-center gap-1.5">
                    <Truck size={15} className="text-emerald-700" />
                    <span>Delivery Live Tracking</span>
                  </span>
                  {isOutForDelivery && (
                    <span className="text-[11px] font-mono text-emerald-700 flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                      Live GPS
                    </span>
                  )}
                </div>

                {showMap ? (
                  <div className="flex flex-col gap-1.5">
                    <CourierTrackingMap
                      courierLocation={selectedOrder.courierLocation || selectedOrder.delivery?.lastLocation}
                      deliveryAddress={selectedOrder.deliveryAddress}
                      pharmacyLocation={activePharmacy ? { lat: activePharmacy.lat, lng: activePharmacy.lng } : null}
                    />
                    <p className="text-[11px] text-slate-500 italic">
                      Tracking courier in real time · Location refreshes every 5 seconds.
                    </p>
                  </div>
                ) : isDelivered ? (
                  <div className="p-3 bg-surface rounded-xl border border-line text-xs text-slate-600 flex items-center gap-2">
                    <CheckCircle2 size={16} className="text-emerald-700 shrink-0" />
                    <span>
                      Package delivered. Courier tracking ended per privacy protection policy.
                    </span>
                  </div>
                ) : (
                  <div className="p-3 bg-surface rounded-xl border border-line text-xs text-slate-500 flex items-center gap-2">
                    <Clock size={15} className="text-slate-400 shrink-0" />
                    <span>
                      Live map tracking activates once a courier picks up your package and is out for delivery.
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Status Timeline */}
            <div className="pt-3 border-t border-line flex flex-col gap-3">
              <span className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Progress Timeline
              </span>

              <div className="flex flex-col gap-3 pl-1">
                {timelineSteps.map((step, idx) => {
                  const isLast = idx === timelineSteps.length - 1;
                  return (
                    <div key={step.key} className="flex items-start gap-3 relative">
                      {!isLast && (
                        <div
                          className={`absolute left-3 top-5 bottom-0 w-0.5 -ml-px ${
                            step.completed ? "bg-emerald-600" : "bg-line"
                          }`}
                        />
                      )}

                      <div
                        className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 z-10 text-xs font-mono ${
                          step.completed
                            ? "bg-emerald-600 text-white"
                            : step.active
                            ? step.failed
                              ? "bg-red-600 text-white animate-pulse"
                              : "bg-emerald-100 text-emerald-900 border-2 border-emerald-600 font-bold"
                            : "bg-slate-100 text-slate-400 border border-line"
                        }`}
                      >
                        {step.completed ? "✓" : idx + 1}
                      </div>

                      <div className="flex-1 pb-3">
                        <div className="flex items-center justify-between">
                          <strong
                            className={`text-xs ${
                              step.active
                                ? step.failed
                                  ? "text-red-700 font-bold"
                                  : "text-ink font-semibold"
                                : step.completed
                                ? "text-slate-700"
                                : "text-slate-400"
                            }`}
                          >
                            {step.label}
                          </strong>
                          {step.at && (
                            <span className="font-mono text-[10px] text-slate-400">
                              {new Date(step.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                          {step.description}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="pt-3 mt-auto border-t border-line flex gap-2">
              {canCancel && (
                <button
                  type="button"
                  onClick={handleCancelOrder}
                  disabled={submitting}
                  className="pt-button-secondary text-red-700 border-red-200 hover:bg-red-50 text-xs flex-1"
                >
                  {submitting ? "Cancelling…" : "Cancel order"}
                </button>
              )}

              {(isDelivered || selectedOrder.status === "picked_up") && (
                <button
                  type="button"
                  onClick={() => handleRequestRefill(selectedOrder)}
                  disabled={submitting}
                  className="pt-button text-xs flex-1"
                >
                  Order refill
                </button>
              )}
            </div>
          </section>
        ) : view === "orders" ? (
          /* ── View 2: Orders List ─────────────────────────────────────── */
          <section className="pt-card pt-grow">
            <PatientList
              items={orders}
              empty={
                <>
                  No pharmacy orders placed yet.
                  <br />
                  Order a prescription or medication refill.
                </>
              }
              renderItem={(order) => {
                const oId = order._id || order.id;
                const status = order.status || "new";
                const isDeliv = order.fulfilment === "delivery";
                const ph = order.pharmacyId ? pharmacyMap.get(order.pharmacyId) : null;
                const itemsCount = Array.isArray(order.items) ? order.items.length : 1;

                return (
                  <button
                    key={oId}
                    type="button"
                    className="pt-list-row"
                    onClick={() => handleSelectOrder(order)}
                  >
                    <div>
                      <strong>
                        {ph ? ph.name : "Pharmacy Order"} · {itemsCount} {itemsCount === 1 ? "item" : "items"}
                      </strong>
                      <p>
                        {isDeliv ? "Delivery" : "Counter pickup"} ·{" "}
                        {order.createdAt ? new Date(order.createdAt).toLocaleDateString() : "Recent"}
                      </p>
                      <small className="text-slate-500">
                        {ORDER_STATUS_LABELS[status] || status}
                      </small>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className={`pt-pill ${status === "delivered" || status === "picked_up" ? "pt-positive" : ""}`}>
                        {status}
                      </span>
                      <ChevronRight size={16} className="text-slate-400" />
                    </div>
                  </button>
                );
              }}
            />
          </section>
        ) : view === "prescriptions" ? (
          /* ── View 3: Prescriptions List ──────────────────────────────── */
          <section className="pt-card pt-grow">
            <PatientList
              items={prescriptions}
              empty="No prescriptions on file from your doctor."
              renderItem={(rx) => {
                const rxId = rx._id || rx.id;
                const itemsList = Array.isArray(rx.items) ? rx.items : [];
                const firstItem = itemsList[0] || {};

                return (
                  <div key={rxId} className="pt-list-row flex flex-col items-start gap-2 h-auto py-3">
                    <div className="flex items-start justify-between w-full">
                      <div>
                        <strong>{firstItem.drug || "Prescription"}</strong>
                        <p className="text-xs text-slate-600">
                          {firstItem.dose || firstItem.strength} {firstItem.form ? `(${firstItem.form})` : ""} · {firstItem.frequency}
                        </p>
                        <small className="text-slate-500">
                          Qty: {firstItem.quantity || "—"} · {rx.createdAt ? new Date(rx.createdAt).toLocaleDateString() : ""}
                        </small>
                      </div>

                      <span className={`pt-pill ${rx.status === "active" ? "pt-positive" : ""}`}>
                        {rx.status || "active"}
                      </span>
                    </div>

                    {rx.status === "active" && (
                      <div className="w-full flex justify-end pt-1">
                        <button
                          type="button"
                          className="pt-button-secondary text-xs py-1 px-3"
                          onClick={() => {
                            setSelectedRxId(rxId);
                            setView("order");
                          }}
                        >
                          Order now →
                        </button>
                      </div>
                    )}
                  </div>
                );
              }}
            />
          </section>
        ) : (
          /* ── View 4: Place New Order ─────────────────────────────────── */
          <form onSubmit={handlePlaceOrder} className="pt-card pt-grow pt-stack overflow-y-auto">
            <div className="pt-row">
              <h2 className="text-base font-semibold">New Pharmacy Order</h2>
              <button
                type="button"
                className="pt-text-button"
                onClick={() => setView("orders")}
              >
                Cancel
              </button>
            </div>

            {/* Select Prescription or Refill Item */}
            <label className="pt-field">
              Select Prescription
              <select
                value={selectedRxId}
                onChange={(e) => {
                  setSelectedRxId(e.target.value);
                  setSelectedRefillReminderId("");
                }}
                disabled={Boolean(selectedRefillReminderId)}
              >
                {prescriptions.map((rx) => {
                  const rxId = rx._id || rx.id;
                  const item = rx.items?.[0] || {};
                  return (
                    <option key={rxId} value={rxId}>
                      {item.drug ? `${item.drug} (${item.dose || ""})` : `Prescription ${rxId}`}
                    </option>
                  );
                })}
              </select>
            </label>

            {/* Pharmacy Selection (spec 4.4: sorted by distance) */}
            <label className="pt-field">
              Select Pharmacy
              <select
                value={selectedPharmacyId}
                onChange={(e) => setSelectedPharmacyId(e.target.value)}
                required
              >
                {pharmacies.map((ph) => {
                  const pId = ph._id || ph.id;
                  return (
                    <option key={pId} value={pId}>
                      {ph.name} {ph.address ? `— ${ph.address}` : ""}
                    </option>
                  );
                })}
              </select>
            </label>

            {/* Fulfilment Selection: Pickup vs Delivery */}
            <div className="pt-field">
              <span>Fulfilment Method</span>
              <div className="grid grid-cols-2 gap-2 mt-1">
                <button
                  type="button"
                  className={`p-3 rounded-xl border text-xs font-medium flex flex-col items-center gap-1.5 transition-colors ${
                    fulfilment === "delivery"
                      ? "border-emerald-700 bg-emerald-50/60 text-emerald-950 font-semibold"
                      : "border-line bg-paper text-slate-600 hover:bg-surface"
                  }`}
                  onClick={() => setFulfilment("delivery")}
                >
                  <Truck size={18} />
                  <span>Home Delivery</span>
                </button>

                <button
                  type="button"
                  className={`p-3 rounded-xl border text-xs font-medium flex flex-col items-center gap-1.5 transition-colors ${
                    fulfilment === "pickup"
                      ? "border-emerald-700 bg-emerald-50/60 text-emerald-950 font-semibold"
                      : "border-line bg-paper text-slate-600 hover:bg-surface"
                  }`}
                  onClick={() => setFulfilment("pickup")}
                >
                  <Building2 size={18} />
                  <span>Pickup in Store</span>
                </button>
              </div>
            </div>

            {/* Delivery Address (required if delivery) */}
            {fulfilment === "delivery" && (
              <label className="pt-field">
                Delivery Street Address *
                <textarea
                  rows={2}
                  required
                  placeholder="Street, Building, Apartment, City, Pincode"
                  value={deliveryAddressText}
                  onChange={(e) => setDeliveryAddressText(e.target.value)}
                />
              </label>
            )}

            <button
              type="submit"
              disabled={submitting || offlineStatus.offline}
              className="pt-button pt-bottom mt-4"
            >
              {submitting ? "Placing order…" : "Place Order"}
            </button>
          </form>
        )}
      </Body>
      <TabBar />
    </>
  );
}
