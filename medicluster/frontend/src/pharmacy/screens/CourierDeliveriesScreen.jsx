import React, { useEffect, useState, useCallback } from 'react';
import {
  Truck,
  MapPin,
  Clock,
  User,
  Package,
  CheckCircle,
  RefreshCw,
  AlertCircle,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react';
import { getCourierDeliveries, acceptCourierDelivery } from '../api.js';
import { DELIVERY_STATUS, STATUS_BADGES } from '../orderStateMachine.js';

const TABS = [
  { id: 'all', label: 'All Jobs' },
  { id: 'assigned', label: 'New Assigned' },
  { id: 'active', label: 'Active Delivery' },
  { id: 'completed', label: 'Completed' },
];

export default function CourierDeliveriesScreen({ onSelectDelivery, courierName }) {
  const [deliveries, setDeliveries] = useState([]);
  const [activeTab, setActiveTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acceptingId, setAcceptingId] = useState(null);
  const [error, setError] = useState('');
  const [successNote, setSuccessNote] = useState('');

  const fetchDeliveries = useCallback(async (isSilent = false) => {
    if (!isSilent) setRefreshing(true);
    try {
      const data = await getCourierDeliveries();
      setDeliveries(Array.isArray(data) ? data : data?.deliveries || []);
      setError('');
    } catch (err) {
      if (!isSilent) setError(err.message || 'Failed to load assigned deliveries.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchDeliveries();
  }, [fetchDeliveries]);

  // Polling every 5s per spec
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchDeliveries(true);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [fetchDeliveries]);

  const handleAccept = async (e, deliveryId) => {
    e.stopPropagation();
    setAcceptingId(deliveryId);
    setError('');
    try {
      const res = await acceptCourierDelivery(deliveryId);
      setSuccessNote('Delivery accepted! Ready for pharmacy collection.');
      setTimeout(() => setSuccessNote(''), 3000);
      setDeliveries((prev) =>
        prev.map((d) => (d.id === deliveryId ? { ...d, status: DELIVERY_STATUS.ACCEPTED } : d))
      );
    } catch (err) {
      setError(err.message || 'Failed to accept delivery.');
    } finally {
      setAcceptingId(null);
    }
  };

  const filtered = deliveries.filter((d) => {
    if (activeTab === 'assigned') return d.status === 'assigned';
    if (activeTab === 'active') return ['accepted', 'picked_up'].includes(d.status);
    if (activeTab === 'completed') return ['delivered', 'failed'].includes(d.status);
    return true;
  });

  return (
    <div className="rx-content" data-testid="courier-deliveries-screen">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#17251d' }}>
            My Deliveries
          </h2>
          <p className="rx-card-meta" style={{ marginTop: 2 }}>
            {courierName ? `Courier: ${courierName}` : 'Prescription parcel routes'}
          </p>
        </div>
        <button
          type="button"
          className="rx-btn rx-btn-secondary"
          onClick={() => fetchDeliveries(false)}
          disabled={refreshing}
          style={{ padding: '6px 12px', fontSize: 12 }}
        >
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
          {refreshing ? 'Updating…' : 'Refresh'}
        </button>
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

      {/* Tabs */}
      <div className="rx-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`rx-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Deliveries list */}
      {loading && deliveries.length === 0 ? (
        <div className="rx-card" style={{ textAlign: 'center', padding: '36px 16px' }}>
          <RefreshCw size={24} style={{ margin: '0 auto 8px auto', color: '#55664f' }} className="spin" />
          <div style={{ fontWeight: 600 }}>Loading deliveries…</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rx-card" style={{ textAlign: 'center', padding: '40px 16px', color: '#55664f' }}>
          <Truck size={32} style={{ margin: '0 auto 10px auto', opacity: 0.6 }} />
          <div style={{ fontWeight: 600, fontSize: 15, color: '#17251d' }}>No deliveries found</div>
          <div className="rx-card-meta" style={{ marginTop: 4 }}>
            New prescription runs will appear here as pharmacies assign them.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((deliv) => {
            const isAssigned = deliv.status === 'assigned';
            const isAccepted = deliv.status === 'accepted';
            const isPickedUp = deliv.status === 'picked_up';
            const isDelivered = deliv.status === 'delivered';
            const isFailed = deliv.status === 'failed';

            const badgeClass =
              isDelivered ? 'rx-badge-green' :
              isFailed ? 'rx-badge-rose' :
              isPickedUp ? 'rx-badge-purple' :
              isAccepted ? 'rx-badge-amber' :
              'rx-badge-blue';

            return (
              <div
                key={deliv.id}
                className="rx-card"
                onClick={() => onSelectDelivery(deliv.id)}
                style={{ cursor: 'pointer' }}
                data-testid={`delivery-card-${deliv.id}`}
              >
                <div className="rx-card-header">
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="rx-card-title">
                        Delivery #{deliv.id?.slice(-6).toUpperCase() || deliv.id}
                      </span>
                      <span className={`rx-badge ${badgeClass}`}>
                        {deliv.status?.toUpperCase() || 'ASSIGNED'}
                      </span>
                    </div>

                    <div className="rx-card-meta" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <User size={13} />
                      <strong>{deliv.patientFirstName || deliv.patientName || 'Patient'}</strong>
                    </div>
                  </div>

                  <ChevronRight size={18} style={{ color: '#8d9c84' }} />
                </div>

                {/* Addresses */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#0369a1' }}>
                    <MapPin size={13} />
                    <span>Pickup: <strong>{deliv.pharmacy?.name || 'Local Pharmacy'}</strong> ({deliv.pharmacy?.address || 'Pharmacy address'})</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#15803d' }}>
                    <MapPin size={13} />
                    <span>Drop: <strong>{deliv.deliveryAddress?.text || 'Patient delivery address'}</strong></span>
                  </div>
                </div>

                {/* Actions row */}
                {isAssigned && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                    <button
                      type="button"
                      className="rx-btn"
                      onClick={(e) => handleAccept(e, deliv.id)}
                      disabled={acceptingId === deliv.id}
                      style={{ padding: '6px 14px', fontSize: 12 }}
                      data-testid={`accept-delivery-${deliv.id}`}
                    >
                      {acceptingId === deliv.id ? 'Accepting…' : 'Accept Delivery Job'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
