import React, { useState } from 'react';
import { Pill, Lock, Mail } from 'lucide-react';
import StaffLogin, { LoginField } from '../components/StaffLogin.jsx';
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

  if (pharmacies) {
    return (
      <StaffLogin icon={Pill} eyebrow="Pharmacy portal" title="Pharmacy Portal" subtitle="Choose the pharmacy you are working at today"
        error={error} submitLabel="Continue to queue" onSubmit={handleSelectPharmacy}>
        <div className="rx-field">
          <label htmlFor="select-pharmacy">Active pharmacy</label>
          <select id="select-pharmacy" className="rx-select" value={selectedPharmacyId} onChange={(e) => setSelectedPharmacyId(e.target.value)}>
            {pharmacies.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.address || 'Active'})</option>
            ))}
          </select>
        </div>
      </StaffLogin>
    );
  }

  return (
    <StaffLogin
      icon={Pill}
      eyebrow="Pharmacy portal"
      title="Pharmacy Portal"
      subtitle="Fill prescriptions, manage stock and hand orders to couriers."
      error={error}
      busy={busy}
      busyLabel="Signing in…"
      submitLabel="Sign in as Pharmacist"
      onSubmit={handleSubmit}
      backLabel="Return to Clinician Portal"
      demo={{ label: 'pharmacist.central@medicluster.demo', onUse: () => setEmail('pharmacist.central@medicluster.demo') }}
    >
      <LoginField id="pharmacy-email" label="Staff email" icon={Mail} type="email" placeholder="you@pharmacy.com"
        value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" />
      <LoginField id="pharmacy-password" label="Password" icon={Lock} type="password" placeholder="Your password"
        value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
    </StaffLogin>
  );
}
