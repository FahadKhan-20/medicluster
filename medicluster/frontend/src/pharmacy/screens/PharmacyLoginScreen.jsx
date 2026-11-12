import React, { useState } from 'react';
import { Pill, Lock, Mail, AlertCircle, ArrowRight } from 'lucide-react';
import { loginPharmacist } from '../api.js';
import { setActivePharmacyId } from '../session.js';

export default function PharmacyLoginScreen({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pharmacies, setPharmacies] = useState(null);
  const [selectedPharmacyId, setSelectedPharmacyId] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please enter both email and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await loginPharmacist({ email, password });
      if (res.pharmacies && res.pharmacies.length > 1) {
        setPharmacies(res.pharmacies);
        setSelectedPharmacyId(res.pharmacies[0].id);
      } else {
        onLoginSuccess(res);
      }
    } catch (err) {
      setError(err.message || 'Login failed. Please check credentials.');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectPharmacy = (e) => {
    e.preventDefault();
    setActivePharmacyId(selectedPharmacyId);
    onLoginSuccess({ activePharmacyId: selectedPharmacyId });
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
              background: '#e0f2fe',
              color: '#0369a1',
              display: 'grid',
              placeItems: 'center',
              margin: '0 auto 12px auto'
            }}>
              <Pill size={28} />
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#17251d' }}>
              Pharmacy Portal
            </h1>
            <p className="rx-card-meta" style={{ marginTop: 4 }}>
              Sign in with your pharmacy staff credentials
            </p>
          </div>

          {error && (
            <div className="rx-alert rx-alert-error" role="alert">
              <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>{error}</div>
            </div>
          )}

          {!pharmacies ? (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="rx-field">
                <label htmlFor="pharmacy-email">Staff Email</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="pharmacy-email"
                    type="email"
                    className="rx-input"
                    placeholder="pharmacist@medicluster.test"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
              </div>

              <div className="rx-field">
                <label htmlFor="pharmacy-password">Password</label>
                <input
                  id="pharmacy-password"
                  type="password"
                  className="rx-input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              <button
                type="submit"
                className="rx-btn"
                disabled={busy}
                style={{ width: '100%', marginTop: 6 }}
              >
                {busy ? 'Authenticating…' : 'Sign in as Pharmacist'} <ArrowRight size={16} />
              </button>
            </form>
          ) : (
            <form onSubmit={handleSelectPharmacy} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="rx-field">
                <label htmlFor="select-pharmacy">Select Active Pharmacy</label>
                <select
                  id="select-pharmacy"
                  className="rx-select"
                  value={selectedPharmacyId}
                  onChange={(e) => setSelectedPharmacyId(e.target.value)}
                >
                  {pharmacies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.address || 'Active'})
                    </option>
                  ))}
                </select>
              </div>

              <button type="submit" className="rx-btn" style={{ width: '100%' }}>
                Continue to Queue <ArrowRight size={16} />
              </button>
            </form>
          )}

          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <a href="/login" className="rx-card-meta" style={{ textDecoration: 'none', color: '#55664f' }}>
              ← Return to Clinician Portal
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
