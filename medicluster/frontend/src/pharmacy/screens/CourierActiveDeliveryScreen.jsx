import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  ArrowLeft,
  Truck,
  MapPin,
  CheckCircle,
  Phone,
  Package,
  Navigation,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import {
  getCourierDelivery,
  executeCourierAction,
  sendCourierLocation,
} from '../api.js';
import CourierMap from '../components/CourierMap.jsx';
import { DELIVERY_STATUS } from '../orderStateMachine.js';

export default function CourierActiveDeliveryScreen({ deliveryId, onBack }) {
  const [delivery, setDelivery] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [successNote, setSuccessNote] = useState('');

  // Live GPS tracking state
  const [courierLocation, setCourierLocation] = useState(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [lastGpsPingTime, setLastGpsPingTime] = useState(null);
  const watchIdRef = useRef(null);

  // Handover modal
  const [handoverModalOpen, setHandoverModalOpen] = useState(false);
  const [deliveryOtp, setDeliveryOtp] = useState('');
  const [podNote, setPodNote] = useState('');

  // Fail modal
  const [failModalOpen, setFailModalOpen] = useState(false);
  const [failReason, setFailReason] = useState('');

  const loadDelivery = useCallback(async () => {
    try {
      const data = await getCourierDelivery(deliveryId);
      setDelivery(data);
      if (data?.lastLocation) {
        setCourierLocation(data.lastLocation);
      }
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to fetch delivery details.');
    } finally {
      setLoading(false);
    }
  }, [deliveryId]);

  useEffect(() => {
    loadDelivery();
  }, [loadDelivery]);

  // Geolocation watch: runs while delivery is accepted or picked_up (in transit)
  useEffect(() => {
    const isLive = delivery?.status === 'accepted' || delivery?.status === 'picked_up';
    if (!isLive || !navigator.geolocation) {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setGpsActive(false);
      return;
    }

    setGpsActive(true);

    const onPos = (position) => {
      const coords = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy || 10,
        observedAt: new Date(position.timestamp || Date.now()).toISOString(),
      };
      setCourierLocation(coords);
      setLastGpsPingTime(new Date());

      // Send to server
      sendCourierLocation(deliveryId, coords).catch(() => {});
    };

    const onErr = () => {
      // Retain existing coordinates or graceful degradation
    };

    watchIdRef.current = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    });

    return () => {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [delivery?.status, deliveryId]);

  // Action dispatcher
  const performAction = async (payload) => {
    setBusy(true);
    setError('');
    setSuccessNote('');
    try {
      const res = await executeCourierAction(deliveryId, payload);
      setDelivery(res?.delivery || res);
      setSuccessNote(`Delivery action ${payload.action} completed successfully.`);
      setHandoverModalOpen(false);
      setFailModalOpen(false);
    } catch (err) {
      setError(err.message || 'Failed to execute delivery action.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="rx-content">
        <div className="rx-card" style={{ textAlign: 'center', padding: '36px 16px' }}>
          <RefreshCw size={24} style={{ margin: '0 auto 8px auto', color: '#55664f' }} className="spin" />
          <div style={{ fontWeight: 600 }}>Loading delivery route…</div>
        </div>
      </div>
    );
  }

  if (!delivery) {
    return (
      <div className="rx-content">
        <button type="button" className="rx-btn rx-btn-secondary" onClick={onBack}>
          <ArrowLeft size={16} /> Back
        </button>
        <div className="rx-card">
          <div style={{ color: '#be123c' }}>Delivery job not found.</div>
        </div>
      </div>
    );
  }

  const isAccepted = delivery.status === 'accepted';
  const isPickedUp = delivery.status === 'picked_up';
  const isDelivered = delivery.status === 'delivered';
  const isFailed = delivery.status === 'failed';

  return (
    <div className="rx-content" data-testid="courier-active-delivery-screen">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          className="rx-btn rx-btn-secondary"
          onClick={onBack}
          style={{ padding: '8px 12px' }}
          data-testid="courier-back-btn"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <div>
          <span style={{ fontSize: 13, color: '#52664d', fontWeight: 600 }}>
            Delivery #{delivery.id?.slice(-8).toUpperCase() || delivery.id}
          </span>
        </div>
      </div>

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

      {/* Live GPS Bar */}
      {gpsActive && (
        <div
          className="rx-alert rx-alert-success"
          style={{ padding: '8px 12px', fontSize: 12, justifyContent: 'space-between' }}
          data-testid="gps-sharing-indicator"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#059669' }} className="spin" />
            <strong>Sharing Live GPS with Patient</strong>
          </div>
          {courierLocation && (
            <span style={{ fontSize: 11, color: '#065f46' }}>
              {courierLocation.lat?.toFixed(4)}, {courierLocation.lng?.toFixed(4)}
            </span>
          )}
        </div>
      )}

      {/* OSM Map View */}
      <div className="rx-card" style={{ padding: 10 }}>
        <CourierMap
          courierLocation={courierLocation}
          pharmacyLocation={delivery.pharmacy}
          patientLocation={delivery.deliveryAddress}
        />
      </div>

      {/* Delivery Overview Card */}
      <div className="rx-card">
        <div className="rx-card-header">
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#17251d' }}>
              {delivery.patientFirstName || delivery.patientName || 'Patient Recipient'}
            </h2>
            <div className="rx-card-meta" style={{ marginTop: 2 }}>
              Status: <strong>{delivery.status?.toUpperCase()}</strong>
            </div>
          </div>
          <span className="rx-badge rx-badge-purple">
            <Truck size={13} /> Active Parcel
          </span>
        </div>

        {/* Pickup & Destination Details */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
          <div style={{ background: '#f0f9ff', padding: '10px 12px', borderRadius: 14 }}>
            <div style={{ color: '#0369a1', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
              <MapPin size={14} /> 1. Pickup from Pharmacy
            </div>
            <div><strong>{delivery.pharmacy?.name || 'Local Pharmacy'}</strong></div>
            <div style={{ color: '#475569', fontSize: 12 }}>{delivery.pharmacy?.address || 'Pharmacy address'}</div>
          </div>

          <div style={{ background: '#f0fdf4', padding: '10px 12px', borderRadius: 14 }}>
            <div style={{ color: '#15803d', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
              <MapPin size={14} /> 2. Deliver to Patient
            </div>
            <div><strong>{delivery.deliveryAddress?.text || 'Patient destination address'}</strong></div>
            {delivery.patientPhone && (
              <div style={{ marginTop: 4 }}>
                <a
                  href={`tel:${delivery.patientPhone}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#166534', textDecoration: 'none', fontWeight: 600 }}
                >
                  <Phone size={13} /> {delivery.patientPhone}
                </a>
              </div>
            )}
          </div>
        </div>

        {/* Prescription items list (medications in parcel) */}
        {delivery.items && delivery.items.length > 0 && (
          <div style={{ background: '#f8faf5', padding: '10px 12px', borderRadius: 14, fontSize: 12 }}>
            <div style={{ fontWeight: 600, color: '#31442c', marginBottom: 4 }}>
              Parcel Contents ({delivery.items.length} items):
            </div>
            <div style={{ color: '#4d5d47' }}>
              {delivery.items.map((it, i) => (
                <div key={i}>• {it.drug} {it.strength} (Qty: {it.quantity || 1})</div>
              ))}
            </div>
          </div>
        )}

        {/* Completed Proof note if delivered */}
        {isDelivered && (
          <div className="rx-alert rx-alert-success">
            <CheckCircle size={16} />
            <div>
              <strong>Delivery Completed!</strong>
              {delivery.proof?.note && <div style={{ fontSize: 12, marginTop: 2 }}>Proof note: {delivery.proof.note}</div>}
            </div>
          </div>
        )}

        {isFailed && (
          <div className="rx-alert rx-alert-error">
            <AlertTriangle size={16} />
            <div>
              <strong>Delivery marked failed:</strong> {delivery.reason || 'Unreachable address'}
            </div>
          </div>
        )}
      </div>

      {/* Action Buttons Toolbar */}
      <div className="rx-card" style={{ background: '#f8faf5' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: '#17251d' }}>
          Courier Actions
        </h3>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {isAccepted && (
            <button
              type="button"
              className="rx-btn"
              onClick={() => performAction({ action: 'pickup' })}
              disabled={busy}
              data-testid="courier-pickup-btn"
            >
              <Package size={15} /> Confirm Pharmacy Pickup
            </button>
          )}

          {isPickedUp && (
            <>
              <button
                type="button"
                className="rx-btn"
                onClick={() => setHandoverModalOpen(true)}
                disabled={busy}
                data-testid="courier-handover-btn"
              >
                <ShieldCheck size={15} /> Complete Delivery with OTP
              </button>

              <button
                type="button"
                className="rx-btn rx-btn-danger"
                onClick={() => setFailModalOpen(true)}
                disabled={busy}
                data-testid="courier-fail-btn"
              >
                <AlertTriangle size={15} /> Report Issue / Failure
              </button>
            </>
          )}

          {isDelivered && (
            <div style={{ color: '#15803d', fontWeight: 600, fontSize: 13 }}>
              ✓ Delivery fulfilled and verified.
            </div>
          )}
        </div>
      </div>

      {/* Handover OTP Modal */}
      {handoverModalOpen && (
        <div className="rx-modal-backdrop" role="dialog" aria-modal="true">
          <div className="rx-modal">
            <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Patient Delivery Handover</h3>
            <p className="rx-card-meta" style={{ margin: 0 }}>
              Ask the patient for the 4-digit handover OTP from their MediCluster app to confirm receipt.
            </p>

            <div className="rx-field">
              <label htmlFor="courier-otp-input">4-Digit Handover OTP</label>
              <input
                id="courier-otp-input"
                type="text"
                maxLength={4}
                className="rx-input"
                style={{ fontSize: 20, textAlign: 'center', letterSpacing: '0.3em', fontWeight: 700 }}
                placeholder="••••"
                value={deliveryOtp}
                onChange={(e) => setDeliveryOtp(e.target.value.replace(/\D/g, ''))}
                autoFocus
                required
              />
            </div>

            <div className="rx-field">
              <label htmlFor="courier-pod-note">Proof of Delivery Note (Optional)</label>
              <input
                id="courier-pod-note"
                type="text"
                className="rx-input"
                placeholder="e.g. Handed to patient, Left with receptionist"
                value={podNote}
                onChange={(e) => setPodNote(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="rx-btn rx-btn-secondary"
                onClick={() => setHandoverModalOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rx-btn"
                onClick={() => performAction({ action: 'deliver', otp: deliveryOtp, note: podNote })}
                disabled={busy || deliveryOtp.length !== 4}
                data-testid="confirm-courier-deliver-btn"
              >
                Verify & Complete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fail Modal */}
      {failModalOpen && (
        <div className="rx-modal-backdrop" role="dialog" aria-modal="true">
          <div className="rx-modal">
            <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Report Delivery Failure</h3>
            <p className="rx-card-meta" style={{ margin: 0 }}>
              The pharmacy will be notified and can reassign or reschedule delivery.
            </p>

            <div className="rx-field">
              <label htmlFor="courier-fail-reason">Failure Reason</label>
              <textarea
                id="courier-fail-reason"
                className="rx-textarea"
                rows={3}
                placeholder="e.g. Patient unreachable, incorrect address, door locked…"
                value={failReason}
                onChange={(e) => setFailReason(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="rx-btn rx-btn-secondary"
                onClick={() => setFailModalOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rx-btn rx-btn-danger"
                onClick={() => performAction({ action: 'fail', reason: failReason })}
                disabled={busy || !failReason.trim()}
                data-testid="confirm-courier-fail-btn"
              >
                Submit Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
