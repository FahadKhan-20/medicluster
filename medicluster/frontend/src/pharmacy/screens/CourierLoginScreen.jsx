import React, { useState } from 'react';
import { Truck, Phone, KeyRound } from 'lucide-react';
import StaffLogin, { LoginField } from '../components/StaffLogin.jsx';
import { loginCourier } from '../api.js';

export default function CourierLoginScreen({ onLoginSuccess }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!phone || !pin) {
      setError('Please enter your phone number and PIN.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await loginCourier({ phone: phone.replace(/\s+/g, ''), pin });
      onLoginSuccess(res);
    } catch (err) {
      setError(err.message || 'Login failed. Please verify phone and PIN.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <StaffLogin
      icon={Truck}
      eyebrow="Courier app"
      title="Courier Delivery"
      subtitle="Pick up medicines, share your route and hand over with the patient's code."
      error={error}
      busy={busy}
      busyLabel="Verifying PIN…"
      submitLabel="Sign in as Courier"
      onSubmit={handleSubmit}
      backLabel="Return to MediCluster Home"
      demo={{ label: 'Ramesh · +91 99999 11101', onUse: () => setPhone('+919999911101') }}
    >
      <LoginField id="courier-phone" label="Mobile number" icon={Phone} type="tel" inputMode="tel" placeholder="+91 98765 43210"
        value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s]/g, ''))} required autoFocus autoComplete="tel" />
      <LoginField id="courier-pin" label="Security PIN (4–6 digits)" icon={KeyRound} type="password" inputMode="numeric"
        pattern="[0-9]{4,6}" maxLength={6} placeholder="••••••" autoComplete="one-time-code"
        value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} required />
    </StaffLogin>
  );
}
