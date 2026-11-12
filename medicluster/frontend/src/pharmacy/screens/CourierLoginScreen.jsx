import React, { useState } from 'react';
import { Truck, Phone, KeyRound, ArrowRight, AlertCircle } from 'lucide-react';
import { loginCourier } from '../api.js';

export default function CourierLoginScreen({ onLoginSuccess }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!phone || !pin) {
      setError('Please enter both phone number and 4-digit PIN.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await loginCourier({ phone, pin });
      onLoginSuccess(res);
    } catch (err) {
      setError(err.message || 'Login failed. Please verify phone and PIN.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rx-portal">
      <div className="rx-container" style={{ justifyContent: 'center', padding: '24px' }}>
        <div className="rx-card" style={{ maxWidth: 420, margin: '0 auto', width: '100%' }}>
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <div style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: '#ede9fe',
              color: '#6d28d9',
              display: 'grid',
              placeItems: 'center',
              margin: '0 auto 12px auto'
            }}>
              <Truck size={28} />
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#17251d' }}>
              Courier Delivery
            </h1>
            <p className="rx-card-meta" style={{ marginTop: 4 }}>
              Sign in with your registered phone number and PIN
            </p>
          </div>

          {error && (
            <div className="rx-alert rx-alert-error" role="alert">
              <AlertCircle size={18} style={{ flexShrink: 0 }} />
              <div>{error}</div>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="rx-field">
              <label htmlFor="courier-phone">Mobile Phone Number</label>
              <input
                id="courier-phone"
                type="tel"
                className="rx-input"
                placeholder="+91 98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="rx-field">
              <label htmlFor="courier-pin">4-Digit Security PIN</label>
              <input
                id="courier-pin"
                type="password"
                maxLength={6}
                className="rx-input"
                placeholder="••••"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              className="rx-btn"
              disabled={busy}
              style={{ width: '100%', marginTop: 6 }}
            >
              {busy ? 'Verifying PIN…' : 'Sign in as Courier'} <ArrowRight size={16} />
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <a href="/login" className="rx-card-meta" style={{ textDecoration: 'none', color: '#55664f' }}>
              ← Return to MediCluster Home
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
