import React, { useState, useEffect } from 'react';
import {
  Pill,
  Boxes,
  LogOut,
  Layers,
  Building,
} from 'lucide-react';
import {
  getPharmacistToken,
  getPharmacistStaff,
  getPharmacistPharmacies,
  getActivePharmacyId,
  clearPharmacistSession,
} from './session.js';
import PharmacyLoginScreen from './screens/PharmacyLoginScreen.jsx';
import PharmacyQueueScreen from './screens/PharmacyQueueScreen.jsx';
import PharmacyOrderDetailScreen from './screens/PharmacyOrderDetailScreen.jsx';
import PharmacyStockScreen from './screens/PharmacyStockScreen.jsx';
import './pharmacy-theme.css';

export default function PharmacyPortal() {
  const [token, setToken] = useState(getPharmacistToken());
  const [staff, setStaff] = useState(getPharmacistStaff());
  const [activePharmacyId, setActiveId] = useState(getActivePharmacyId());
  const [currentView, setCurrentView] = useState('queue'); // 'queue' | 'detail' | 'stock'
  const [selectedOrderId, setSelectedOrderId] = useState(null);

  useEffect(() => {
    setToken(getPharmacistToken());
    setStaff(getPharmacistStaff());
    setActiveId(getActivePharmacyId());
  }, []);

  const handleLoginSuccess = () => {
    setToken(getPharmacistToken());
    setStaff(getPharmacistStaff());
    setActiveId(getActivePharmacyId());
    setCurrentView('queue');
  };

  const handleLogout = () => {
    clearPharmacistSession();
    setToken(null);
    setStaff(null);
    setSelectedOrderId(null);
    setCurrentView('queue');
  };

  const pharmacies = getPharmacistPharmacies();
  const currentPharmacy = pharmacies.find((p) => p.id === activePharmacyId) || { name: 'MediCluster Pharmacy' };

  if (!token) {
    return <PharmacyLoginScreen onLoginSuccess={handleLoginSuccess} />;
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
              background: '#e0f2fe',
              color: '#0369a1',
              display: 'grid',
              placeItems: 'center',
            }}>
              <Pill size={18} />
            </div>
            <div>
              <h1 style={{ fontSize: 16 }}>{currentPharmacy.name}</h1>
              <div className="rx-header-subtitle">
                {staff?.name || 'Staff Pharmacist'}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="rx-btn rx-btn-secondary"
            onClick={handleLogout}
            style={{ padding: '6px 12px', fontSize: 12 }}
            title="Sign out of pharmacy"
          >
            <LogOut size={14} /> Sign out
          </button>
        </header>

        {/* View Router */}
        {currentView === 'detail' && selectedOrderId ? (
          <PharmacyOrderDetailScreen
            orderId={selectedOrderId}
            onBack={() => {
              setSelectedOrderId(null);
              setCurrentView('queue');
            }}
          />
        ) : currentView === 'stock' ? (
          <PharmacyStockScreen pharmacyName={currentPharmacy.name} />
        ) : (
          <PharmacyQueueScreen
            pharmacyName={currentPharmacy.name}
            onSelectOrder={(orderId) => {
              setSelectedOrderId(orderId);
              setCurrentView('detail');
            }}
          />
        )}

        {/* Bottom Floating Nav Bar */}
        <nav className="rx-nav-bar" aria-label="Pharmacy portal navigation">
          <div className="rx-nav-inner">
            <button
              type="button"
              className={`rx-nav-item ${currentView === 'queue' || currentView === 'detail' ? 'active' : ''}`}
              onClick={() => {
                setSelectedOrderId(null);
                setCurrentView('queue');
              }}
            >
              <Layers size={18} />
              <span>Orders Queue</span>
            </button>

            <button
              type="button"
              className={`rx-nav-item ${currentView === 'stock' ? 'active' : ''}`}
              onClick={() => {
                setSelectedOrderId(null);
                setCurrentView('stock');
              }}
            >
              <Boxes size={18} />
              <span>Inventory Stock</span>
            </button>
          </div>
        </nav>
      </div>
    </div>
  );
}
