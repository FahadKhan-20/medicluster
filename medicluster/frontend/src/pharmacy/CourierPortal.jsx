import React, { useState, useEffect } from 'react';
import { Truck, LogOut, Package } from 'lucide-react';
import {
  getCourierToken,
  getCourierStaff,
  clearCourierSession,
} from './session.js';
import CourierLoginScreen from './screens/CourierLoginScreen.jsx';
import CourierDeliveriesScreen from './screens/CourierDeliveriesScreen.jsx';
import CourierActiveDeliveryScreen from './screens/CourierActiveDeliveryScreen.jsx';
import './pharmacy-theme.css';

export default function CourierPortal() {
  const [token, setToken] = useState(getCourierToken());
  const [staff, setStaff] = useState(getCourierStaff());
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(null);

  useEffect(() => {
    setToken(getCourierToken());
    setStaff(getCourierStaff());
  }, []);

  const handleLoginSuccess = () => {
    setToken(getCourierToken());
    setStaff(getCourierStaff());
    setSelectedDeliveryId(null);
  };

  const handleLogout = () => {
    clearCourierSession();
    setToken(null);
    setStaff(null);
    setSelectedDeliveryId(null);
  };

  if (!token) {
    return <CourierLoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="rx-portal">
      <div className="rx-container">
        {/* Header */}
        <header className="rx-header">
          <div className="rx-header-title">
            <div style={{
              width: 34,
              height: 34,
              borderRadius: '50%',
              background: '#ede9fe',
              color: '#6d28d9',
              display: 'grid',
              placeItems: 'center',
            }}>
              <Truck size={18} />
            </div>
            <div>
              <h1 style={{ fontSize: 16 }}>Courier Delivery</h1>
              <div className="rx-header-subtitle">
                {staff?.name || 'Active Driver'}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="rx-btn rx-btn-secondary"
            onClick={handleLogout}
            style={{ padding: '6px 12px', fontSize: 12 }}
            title="Sign out of courier"
          >
            <LogOut size={14} /> Sign out
          </button>
        </header>

        {/* View Router */}
        {selectedDeliveryId ? (
          <CourierActiveDeliveryScreen
            deliveryId={selectedDeliveryId}
            onBack={() => setSelectedDeliveryId(null)}
          />
        ) : (
          <CourierDeliveriesScreen
            courierName={staff?.name}
            onSelectDelivery={(id) => setSelectedDeliveryId(id)}
          />
        )}

        {/* Bottom Floating Nav Bar */}
        <nav className="rx-nav-bar" aria-label="Courier portal navigation">
          <div className="rx-nav-inner">
            <button
              type="button"
              className={`rx-nav-item ${!selectedDeliveryId ? 'active' : ''}`}
              onClick={() => setSelectedDeliveryId(null)}
            >
              <Package size={18} />
              <span>Deliveries</span>
            </button>
          </div>
        </nav>
      </div>
    </div>
  );
}
