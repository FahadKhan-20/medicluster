import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Package,
  Clock,
  User,
  ShoppingBag,
  Truck,
  Search,
  RefreshCw,
  AlertCircle,
  ChevronRight,
  Filter,
} from 'lucide-react';
import { getPharmacyOrders } from '../api.js';
import { ORDER_STATUS, STATUS_LABELS, STATUS_BADGES } from '../orderStateMachine.js';

const TABS = [
  { id: 'all', label: 'All Orders' },
  { id: ORDER_STATUS.NEW, label: 'New' },
  { id: ORDER_STATUS.ACCEPTED, label: 'Accepted' },
  { id: ORDER_STATUS.PREPARING, label: 'Preparing' },
  { id: ORDER_STATUS.READY, label: 'Ready' },
  { id: ORDER_STATUS.OUT_FOR_DELIVERY, label: 'Out for Delivery' },
  { id: 'completed', label: 'Completed' },
];

function formatElapsed(createdAt) {
  if (!createdAt) return '';
  const sec = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export default function PharmacyQueueScreen({ onSelectOrder, pharmacyName }) {
  const [orders, setOrders] = useState([]);
  const [activeTab, setActiveTab] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const fetchOrders = useCallback(async (isSilent = false) => {
    if (!isSilent) setRefreshing(true);
    try {
      const data = await getPharmacyOrders();
      setOrders(Array.isArray(data) ? data : data?.orders || []);
      setError('');
    } catch (err) {
      if (!isSilent) setError(err.message || 'Failed to load order queue.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Polling every 5s per spec
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchOrders(true);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [fetchOrders]);

  // Filter orders
  const filteredOrders = orders.filter((order) => {
    // Tab filter
    if (activeTab === 'completed') {
      if (!['picked_up', 'delivered', 'rejected', 'cancelled'].includes(order.status)) return false;
    } else if (activeTab !== 'all') {
      if (order.status !== activeTab) return false;
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const patientName = (order.patientFirstName || order.patientName || '').toLowerCase();
      const orderId = (order.id || '').toLowerCase();
      const drugNames = (order.items || []).map((i) => i.drug?.toLowerCase() || '').join(' ');
      return patientName.includes(q) || orderId.includes(q) || drugNames.includes(q);
    }

    return true;
  });

  // Calculate counts per tab
  const getTabCount = (tabId) => {
    if (tabId === 'all') return orders.length;
    if (tabId === 'completed') {
      return orders.filter((o) => ['picked_up', 'delivered', 'rejected', 'cancelled'].includes(o.status)).length;
    }
    return orders.filter((o) => o.status === tabId).length;
  };

  return (
    <div className="rx-content" data-testid="pharmacy-queue-screen">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#17251d' }}>
            Prescription Orders
          </h2>
          <p className="rx-card-meta" style={{ marginTop: 2 }}>
            {pharmacyName ? `Active at ${pharmacyName}` : 'Live dispensing queue'}
          </p>
        </div>
        <button
          type="button"
          className="rx-btn rx-btn-secondary"
          onClick={() => fetchOrders(false)}
          disabled={refreshing}
          style={{ padding: '6px 12px', fontSize: 12 }}
          title="Refresh queue"
        >
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
          {refreshing ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      {error && (
        <div className="rx-alert rx-alert-error" role="alert">
          <AlertCircle size={18} style={{ flexShrink: 0 }} />
          <div>{error}</div>
        </div>
      )}

      {/* Tabs */}
      <div className="rx-tabs" role="tablist" aria-label="Order status filters">
        {TABS.map((tab) => {
          const count = getTabCount(tab.id);
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`rx-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.label}</span>
              {count > 0 && <span className="rx-tab-badge">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Search Input */}
      <div style={{ position: 'relative' }}>
        <Search
          size={16}
          style={{ position: 'absolute', left: 12, top: 12, color: '#7a8774', pointerEvents: 'none' }}
        />
        <input
          type="text"
          className="rx-input"
          placeholder="Filter by patient first name, order ID, or medication…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ paddingLeft: 36 }}
        />
      </div>

      {/* Queue list */}
      {loading && orders.length === 0 ? (
        <div className="rx-card" style={{ textAlign: 'center', padding: '36px 16px' }}>
          <RefreshCw size={24} style={{ margin: '0 auto 8px auto', color: '#52664d' }} className="spin" />
          <div style={{ fontWeight: 600 }}>Loading orders…</div>
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="rx-card" style={{ textAlign: 'center', padding: '40px 16px', color: '#55664f' }}>
          <Package size={32} style={{ margin: '0 auto 10px auto', opacity: 0.6 }} />
          <div style={{ fontWeight: 600, fontSize: 15, color: '#17251d' }}>No orders found</div>
          <div className="rx-card-meta" style={{ marginTop: 4 }}>
            {searchQuery ? 'Try clearing your search query.' : 'New orders will automatically appear here.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filteredOrders.map((order) => {
            const badgeClass = STATUS_BADGES[order.status] || 'rx-badge-gray';
            const statusLabel = STATUS_LABELS[order.status] || order.status;
            const isDelivery = order.fulfilment === 'delivery';

            return (
              <div
                key={order.id}
                className="rx-card"
                onClick={() => onSelectOrder(order.id)}
                style={{ cursor: 'pointer', transition: 'border-color 0.15s ease' }}
                data-testid={`order-row-${order.id}`}
              >
                <div className="rx-card-header">
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="rx-card-title">
                        Order #{order.id?.slice(-6).toUpperCase() || order.id}
                      </span>
                      <span className={`rx-badge ${badgeClass}`}>
                        {statusLabel}
                      </span>
                    </div>
                    <div className="rx-card-meta" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <User size={13} />
                      <strong>{order.patientFirstName || order.patientName || 'Patient'}</strong>
                      <span>•</span>
                      <Clock size={13} />
                      <span>{formatElapsed(order.createdAt || order.created_at)}</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span
                      className="rx-badge"
                      style={{
                        background: isDelivery ? '#ede9fe' : '#e0f2fe',
                        color: isDelivery ? '#5b21b6' : '#075985',
                      }}
                    >
                      {isDelivery ? <Truck size={12} /> : <ShoppingBag size={12} />}
                      {isDelivery ? 'Delivery' : 'Pickup'}
                    </span>
                    <ChevronRight size={18} style={{ color: '#8d9c84' }} />
                  </div>
                </div>

                {/* Items preview */}
                <div style={{ background: '#f8faf5', borderRadius: 12, padding: '8px 12px', fontSize: 12 }}>
                  <div style={{ fontWeight: 600, color: '#31442c', marginBottom: 2 }}>
                    Prescription Items ({order.items?.length || 0}):
                  </div>
                  <div style={{ color: '#4d5d47' }}>
                    {(order.items || []).map((it, idx) => (
                      <span key={idx}>
                        {it.drug} {it.strength} (×{it.quantity || 1})
                        {idx < (order.items?.length || 0) - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </div>
                </div>

                {order.rejectReason && (
                  <div style={{ fontSize: 11, color: '#be123c', fontStyle: 'italic' }}>
                    Rejection note: {order.rejectReason}
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
