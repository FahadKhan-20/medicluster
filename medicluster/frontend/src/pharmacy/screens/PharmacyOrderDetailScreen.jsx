import React, { useEffect, useState, useCallback } from 'react';
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  User,
  Stethoscope,
  ShoppingBag,
  Truck,
  ShieldCheck,
  Send,
  AlertCircle,
  RotateCcw,
} from 'lucide-react';
import {
  getPharmacyOrder,
  executeOrderAction,
  getPharmacyCouriers,
  getPharmacyStock,
} from '../api.js';
import {
  ORDER_STATUS,
  STATUS_LABELS,
  STATUS_BADGES,
  getAllowedActions,
} from '../orderStateMachine.js';

export default function PharmacyOrderDetailScreen({ orderId, onBack }) {
  const [order, setOrder] = useState(null);
  const [stockMap, setStockMap] = useState({});
  const [couriers, setCouriers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflictMessage, setConflictMessage] = useState('');
  const [successNote, setSuccessNote] = useState('');

  // Modals state
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [handoverModalOpen, setHandoverModalOpen] = useState(false);
  const [patientOtp, setPatientOtp] = useState('');
  const [courierModalOpen, setCourierModalOpen] = useState(false);
  const [selectedCourierId, setSelectedCourierId] = useState('');

  const loadData = useCallback(async () => {
    try {
      const data = await getPharmacyOrder(orderId);
      setOrder(data);
      setError('');
      setConflictMessage('');

      // Optionally load stock and couriers in parallel
      const [stocks, courierList] = await Promise.all([
        getPharmacyStock().catch(() => []),
        getPharmacyCouriers().catch(() => []),
      ]);

      const map = {};
      for (const s of (Array.isArray(stocks) ? stocks : stocks?.items || [])) {
        const key = `${(s.drug || '').toLowerCase()}|${(s.strength || '').toLowerCase()}`;
        map[key] = (map[key] || 0) + (s.quantity || 0);
      }
      setStockMap(map);

      const clist = Array.isArray(courierList) ? courierList : courierList?.couriers || [];
      setCouriers(clist);
      if (clist.length > 0 && !selectedCourierId) {
        setSelectedCourierId(clist[0].id);
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch order details.');
    } finally {
      setLoading(false);
    }
  }, [orderId, selectedCourierId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle action transition
  const handleAction = async (actionObj) => {
    const action = actionObj.action;

    if (action === 'reject') {
      setRejectModalOpen(true);
      return;
    }
    if (action === 'handover') {
      setHandoverModalOpen(true);
      return;
    }
    if (action === 'assign_courier') {
      setCourierModalOpen(true);
      return;
    }

    await performAction({ action });
  };

  const performAction = async (payload) => {
    setActionBusy(true);
    setError('');
    setConflictMessage('');
    setSuccessNote('');

    try {
      const res = await executeOrderAction(orderId, payload);
      setOrder(res?.order || res);
      setSuccessNote(`Order successfully updated to ${STATUS_LABELS[res?.status] || res?.status || 'next stage'}.`);
      setRejectModalOpen(false);
      setHandoverModalOpen(false);
      setCourierModalOpen(false);
    } catch (err) {
      if (err.isConflict || err.status === 409) {
        setConflictMessage('This order was already changed by someone else. Refetching latest updates…');
        // Auto-refetch on 409 conflict per spec
        setTimeout(() => {
          loadData();
        }, 1200);
      } else {
        setError(err.message || 'Failed to update order action.');
      }
    } finally {
      setActionBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="rx-content">
        <div className="rx-card" style={{ textAlign: 'center', padding: '36px 16px' }}>
          <Clock size={24} style={{ margin: '0 auto 8px auto', color: '#55664f' }} className="spin" />
          <div style={{ fontWeight: 600 }}>Loading order details…</div>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="rx-content">
        <button type="button" className="rx-btn rx-btn-secondary" onClick={onBack} style={{ width: 'max-content' }}>
          <ArrowLeft size={16} /> Back to Queue
        </button>
        <div className="rx-card">
          <div style={{ color: '#be123c', fontWeight: 600 }}>Order not found or access denied.</div>
        </div>
      </div>
    );
  }

  const allowedActions = getAllowedActions(order, 'pharmacist');
  const badgeClass = STATUS_BADGES[order.status] || 'rx-badge-gray';
  const isDelivery = order.fulfilment === 'delivery';

  // Check if any prescription item has low stock
  let hasStockShortage = false;
  const itemsWithStock = (order.items || []).map((it) => {
    const key = `${(it.drug || '').toLowerCase()}|${(it.strength || '').toLowerCase()}`;
    const available = stockMap[key];
    const needed = it.quantity || 1;
    const isSufficient = available === undefined || available >= needed;
    if (!isSufficient) hasStockShortage = true;
    return { ...it, availableStock: available, isSufficient };
  });

  return (
    <div className="rx-content" data-testid="pharmacy-order-detail-screen">
      {/* Top navigation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          className="rx-btn rx-btn-secondary"
          onClick={onBack}
          style={{ padding: '8px 12px' }}
          data-testid="back-to-queue-btn"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <div>
          <span style={{ fontSize: 13, color: '#52664d', fontWeight: 600 }}>
            Order #{String(order.id || order._id || "").slice(-6).toUpperCase()}
          </span>
        </div>
      </div>

      {conflictMessage && (
        <div className="rx-alert rx-alert-warn" role="alert" data-testid="conflict-alert">
          <RotateCcw size={18} style={{ flexShrink: 0 }} className="spin" />
          <div>
            <strong>Conflict detected:</strong> {conflictMessage}
          </div>
        </div>
      )}

      {error && (
        <div className="rx-alert rx-alert-error" role="alert">
          <AlertCircle size={18} style={{ flexShrink: 0 }} />
          <div>{error}</div>
        </div>
      )}

      {successNote && (
        <div className="rx-alert rx-alert-success" role="alert">
          <CheckCircle size={18} style={{ flexShrink: 0 }} />
          <div>{successNote}</div>
        </div>
      )}

      {/* Primary Order Overview Card */}
      <div className="rx-card">
        <div className="rx-card-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#17251d' }}>
                {order.patientFirstName || order.patientName || 'Patient Prescription'}
              </h2>
              <span className={`rx-badge ${badgeClass}`} data-testid="order-status-badge">
                {STATUS_LABELS[order.status] || order.status}
              </span>
            </div>
            <div className="rx-card-meta" style={{ marginTop: 4 }}>
              Ordered on {order.createdAt ? new Date(order.createdAt).toLocaleString() : 'Recent'}
            </div>
          </div>

          <span
            className="rx-badge"
            style={{
              background: isDelivery ? '#ede9fe' : '#e0f2fe',
              color: isDelivery ? '#5b21b6' : '#075985',
            }}
          >
            {isDelivery ? <Truck size={13} /> : <ShoppingBag size={13} />}
            {isDelivery ? 'Home Delivery' : 'Pharmacy Pickup'}
          </span>
        </div>

        {/* Doctor and fulfilment info */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}>
          <div style={{ background: '#f8faf6', padding: '10px 12px', borderRadius: 14 }}>
            <div style={{ color: '#55664f', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
              <Stethoscope size={13} /> Prescribing Doctor
            </div>
            <strong style={{ color: '#17251d' }}>{order.doctorName || order.doctorUserId || 'Dr. Attending'}</strong>
          </div>

          <div style={{ background: '#f8faf6', padding: '10px 12px', borderRadius: 14 }}>
            <div style={{ color: '#55664f', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
              {isDelivery ? <Truck size={13} /> : <ShoppingBag size={13} />} Fulfilment
            </div>
            <strong style={{ color: '#17251d' }}>
              {isDelivery ? (order.deliveryAddress?.text || 'Patient Address') : 'In-Store Collection'}
            </strong>
          </div>
        </div>

        {order.courierId && (
          <div style={{ fontSize: 12, padding: '8px 12px', background: '#f1f5f9', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Truck size={14} style={{ color: '#475569' }} />
            <span>Assigned Courier: <strong>{order.courierName || order.courierId}</strong></span>
          </div>
        )}
      </div>

      {/* Prescription Items Card */}
      <div className="rx-card">
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: '#17251d' }}>
          Prescription Medications
        </h3>

        {hasStockShortage && order.status === ORDER_STATUS.PREPARING && (
          <div className="rx-alert rx-alert-warn" style={{ padding: '8px 12px', fontSize: 12 }}>
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <span>Warning: Some medication items have insufficient inventory in stock.</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {itemsWithStock.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 12px',
                border: '1px solid #e2e8dc',
                borderRadius: 14,
                background: '#fcfdfa',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: '#17251d', fontSize: 14 }}>
                  {item.drug} <span style={{ color: '#55664f', fontWeight: 500 }}>{item.strength}</span>
                </div>
                <div style={{ fontSize: 12, color: '#55664f', marginTop: 2 }}>
                  {item.form || 'Tablet'} • {item.dose || '1 dose'} • {item.frequency || 'Daily'} • {item.durationDays ? `${item.durationDays} days` : ''}
                </div>
                {item.instructions && (
                  <div style={{ fontSize: 11, color: '#7a8874', marginTop: 2, fontStyle: 'italic' }}>
                    "{item.instructions}"
                  </div>
                )}
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#17251d' }}>
                  Qty: {item.quantity || 1}
                </div>
                {item.availableStock !== undefined && (
                  <div style={{ fontSize: 11, marginTop: 2, color: item.isSufficient ? '#15803d' : '#b45309', fontWeight: 500 }}>
                    {item.isSufficient ? `✓ ${item.availableStock} in stock` : `⚠️ only ${item.availableStock} in stock`}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Action Buttons Toolbar */}
      {allowedActions.length > 0 && (
        <div className="rx-card" style={{ background: '#f8faf5' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: '#17251d' }}>
            Available Pharmacist Actions
          </h3>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {allowedActions.map((actionObj) => {
              const isPrimary = actionObj.variant === 'primary';
              const isDanger = actionObj.variant === 'danger';
              const btnClass = isDanger ? 'rx-btn rx-btn-danger' : isPrimary ? 'rx-btn' : 'rx-btn rx-btn-secondary';

              return (
                <button
                  key={actionObj.action}
                  type="button"
                  className={btnClass}
                  onClick={() => handleAction(actionObj)}
                  disabled={actionBusy}
                  data-testid={`action-${actionObj.action}-btn`}
                >
                  {actionObj.action === 'accept' && <CheckCircle size={15} />}
                  {actionObj.action === 'reject' && <XCircle size={15} />}
                  {actionObj.action === 'start' && <Clock size={15} />}
                  {actionObj.action === 'ready' && <ShieldCheck size={15} />}
                  {actionObj.action === 'handover' && <CheckCircle size={15} />}
                  {actionObj.action === 'assign_courier' && <Truck size={15} />}
                  <span>{actionObj.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Status History Timeline */}
      {order.statusHistory && order.statusHistory.length > 0 && (
        <div className="rx-card">
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: '#17251d' }}>
            Order Event History
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
            {order.statusHistory.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#4b6b44', marginTop: 5 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong style={{ color: '#17251d' }}>{STATUS_LABELS[h.status] || h.status}</strong>
                    <span style={{ color: '#7a8874' }}>{h.at ? new Date(h.at).toLocaleTimeString() : ''}</span>
                  </div>
                  {h.note && <div style={{ color: '#55664f', marginTop: 2 }}>{h.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {rejectModalOpen && (
        <div className="rx-modal-backdrop" role="dialog" aria-modal="true">
          <div className="rx-modal">
            <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Reject Prescription Order</h3>
            <p className="rx-card-meta" style={{ margin: 0 }}>
              Specify the clinical or inventory reason for rejecting this order.
            </p>
            <div className="rx-field">
              <label htmlFor="reject-reason">Rejection Reason</label>
              <textarea
                id="reject-reason"
                className="rx-textarea"
                rows={3}
                placeholder="e.g. Drug out of stock, prescription dosing clarification needed…"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                required
              />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="rx-btn rx-btn-secondary"
                onClick={() => setRejectModalOpen(false)}
                disabled={actionBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rx-btn rx-btn-danger"
                onClick={() => performAction({ action: 'reject', reason: rejectReason })}
                disabled={actionBusy || !rejectReason.trim()}
                data-testid="confirm-reject-btn"
              >
                Confirm Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Handover OTP Modal */}
      {handoverModalOpen && (
        <div className="rx-modal-backdrop" role="dialog" aria-modal="true">
          <div className="rx-modal">
            <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Patient Pickup Handover</h3>
            <p className="rx-card-meta" style={{ margin: 0 }}>
              Enter the 4-digit handover OTP presented by the patient from their app.
            </p>
            <div className="rx-field">
              <label htmlFor="patient-otp-input">4-Digit Handover OTP</label>
              <input
                id="patient-otp-input"
                type="text"
                maxLength={4}
                className="rx-input"
                style={{ fontSize: 20, textAlign: 'center', letterSpacing: '0.3em', fontWeight: 700 }}
                placeholder="••••"
                value={patientOtp}
                onChange={(e) => setPatientOtp(e.target.value.replace(/\D/g, ''))}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="rx-btn rx-btn-secondary"
                onClick={() => setHandoverModalOpen(false)}
                disabled={actionBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rx-btn"
                onClick={() => performAction({ action: 'handover', otp: patientOtp })}
                disabled={actionBusy || patientOtp.length !== 4}
                data-testid="confirm-handover-btn"
              >
                Complete Handover
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Courier Modal */}
      {courierModalOpen && (
        <div className="rx-modal-backdrop" role="dialog" aria-modal="true">
          <div className="rx-modal">
            <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Assign Delivery Courier</h3>
            <p className="rx-card-meta" style={{ margin: 0 }}>
              Select a courier to collect and deliver this package to the patient.
            </p>
            <div className="rx-field">
              <label htmlFor="select-courier">Available Couriers</label>
              {couriers.length > 0 ? (
                <select
                  id="select-courier"
                  className="rx-select"
                  value={selectedCourierId}
                  onChange={(e) => setSelectedCourierId(e.target.value)}
                >
                  {couriers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} {c.phone ? `(${c.phone})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ fontSize: 12, color: '#be123c', padding: 8 }}>
                  No couriers currently registered for this pharmacy.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="rx-btn rx-btn-secondary"
                onClick={() => setCourierModalOpen(false)}
                disabled={actionBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rx-btn"
                onClick={() => performAction({ action: 'assign_courier', courierId: selectedCourierId })}
                disabled={actionBusy || !selectedCourierId}
                data-testid="confirm-assign-courier-btn"
              >
                Assign Courier
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
