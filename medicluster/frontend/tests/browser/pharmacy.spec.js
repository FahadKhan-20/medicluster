import { test, expect } from '@playwright/test';

test.describe('Pharmacy Suite — Clinician Prescribe and Patient Order & Track', () => {
  test('clinician prescribes medication on patient detail page', async ({ page }) => {
    const patientId = 'patient-rx-test';
    const prescriptions = [];
    const pharmacies = [
      { _id: 'pharm-1', name: 'Apollo Health Pharmacy', address: '12 Indiranagar, Bangalore', active: true },
      { _id: 'pharm-2', name: 'MedPlus Express', address: '44 Koramangala, Bangalore', active: true },
    ];

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      localStorage.setItem('medicluster.token', 'preview-clinician-token');
    });

    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const { pathname } = new URL(route.request().url());
      const method = route.request().method();

      if (pathname === '/api/auth/me') {
        return route.fulfill({
          json: {
            user: {
              id: 'doc-1',
              name: 'Dr. Vinay Rao',
              email: 'vinay@clinic.example',
              role: 'doctor',
              department: 'Cardiology',
              onboarded: true,
            },
          },
        });
      }
      if (pathname === '/api/health/ml') {
        return route.fulfill({ json: { online: true } });
      }
      if (pathname === '/api/cluster/results') {
        return route.fulfill({
          json: [{ _id: 'run-1', datasetId: 'ds-1', createdAt: new Date().toISOString() }],
        });
      }
      if (pathname === '/api/cluster/results/run-1') {
        return route.fulfill({
          json: {
            _id: 'run-1',
            patients: [{ patient_id: patientId, age: 45, gender: 'Male', cluster_id: 1, risk_tier: 'high' }],
          },
        });
      }
      if (pathname === '/api/pharmacies') {
        return route.fulfill({ json: pharmacies });
      }
      if (pathname === '/api/prescriptions') {
        if (method === 'POST') {
          const body = route.request().postDataJSON();
          const newRx = {
            ...body,
            _id: `rx-${prescriptions.length + 1}`,
            status: 'active',
            createdAt: new Date().toISOString(),
          };
          prescriptions.unshift(newRx);
          return route.fulfill({ json: newRx });
        }
        return route.fulfill({ json: prescriptions });
      }
      if (pathname.startsWith('/api/prescriptions/')) {
        if (method === 'PATCH') {
          const id = pathname.split('/').pop();
          const found = prescriptions.find(p => p._id === id);
          if (found) Object.assign(found, route.request().postDataJSON());
          return route.fulfill({ json: found || {} });
        }
      }
      if (pathname.includes('/profile')) {
        return route.fulfill({ json: { patientId, name: 'Suresh Kumar', mobile: '9876543210' } });
      }
      if (pathname.includes('/cluster/history')) {
        return route.fulfill({ json: [] });
      }
      if (pathname.includes('/media')) {
        return route.fulfill({ json: [] });
      }
      if (pathname.includes('/reminders')) {
        return route.fulfill({ json: [] });
      }
      if (pathname.includes('/appointments')) {
        return route.fulfill({ json: [] });
      }

      return route.fulfill({ json: [] });
    });

    await page.goto(`/patient/${patientId}`);

    // Wait for the patient profile heading to be visible
    await expect(page.getByRole('heading', { name: patientId })).toBeVisible();

    // Navigate to Prescribe section in ScreenViews
    await page.getByRole('tab', { name: 'Prescribe' }).click();
    await expect(page.getByRole('heading', { name: 'New E-Prescription' })).toBeVisible();

    // Fill in medication fields
    await page.getByPlaceholder('e.g. Amoxicillin').fill('Amoxicillin');
    await page.getByPlaceholder('e.g. 500 mg').fill('500 mg');
    await page.getByPlaceholder('e.g. Twice daily').fill('Twice daily');
    await page.getByPlaceholder('e.g. Take with water').fill('Take with food');
    await page.getByPlaceholder('Special clinical or dispensing instructions').fill('Complete full 7-day course');

    // Click Prescribe button (prescriptions must be created by a clinician click, never auto)
    const prescribeBtn = page.getByRole('button', { name: 'Prescribe Medication' });
    await prescribeBtn.scrollIntoViewIfNeeded();
    await prescribeBtn.click();

    // Verify success confirmation and prescription appearing in the list
    await expect(page.getByText('Prescription written successfully.')).toBeVisible();
    await expect(page.getByText('Amoxicillin')).toBeVisible();
    await expect(page.getByText('500 mg (Tablet) · Twice daily for 7 days')).toBeVisible();
    await expect(page.getByText('Complete full 7-day course')).toBeVisible();
    expect(prescriptions).toHaveLength(1);
    expect(prescriptions[0].items[0].drug).toBe('Amoxicillin');
  });

  test('patient views prescriptions, orders for delivery, and tracks courier live with OTP', async ({ page }) => {
    const patientId = 'patient-rx-test';
    const token = `${btoa('{}')}.${btoa(JSON.stringify({ sub: patientId, kind: 'patient', exp: Math.floor(Date.now() / 1000) + 3600 }))}.preview`;

    const activeRx = {
      _id: 'rx-101',
      patientId,
      status: 'active',
      createdAt: new Date().toISOString(),
      items: [
        {
          drug: 'Metformin',
          dose: '500 mg',
          form: 'Tablet',
          frequency: 'Twice daily',
          quantity: 60,
          durationDays: 30,
          refills: 2,
        },
      ],
    };

    const pharmacies = [
      { _id: 'pharm-1', name: 'Apollo Health Pharmacy', address: '12 Indiranagar, Bangalore', lat: 12.9716, lng: 77.6412 },
      { _id: 'pharm-2', name: 'MedPlus Express', address: '44 Koramangala, Bangalore', lat: 12.9352, lng: 77.6245 },
    ];

    let currentOrder = null;
    const orders = [];

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(({ patientId, token }) => {
      localStorage.setItem('medicluster.patientId', JSON.stringify(patientId));
      localStorage.setItem('medicluster.patientToken', token);
    }, { patientId, token });

    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const { pathname } = new URL(route.request().url());
      const method = route.request().method();

      if (pathname.includes('/profile')) {
        return route.fulfill({ json: { patientId, name: 'Vinay', mobile: '9876543210' } });
      }
      if (pathname.includes('/reminders')) {
        return route.fulfill({ json: [] });
      }
      if (pathname.includes('/readings')) {
        return route.fulfill({ json: [] });
      }
      if (pathname.endsWith('/prescriptions')) {
        return route.fulfill({ json: [activeRx] });
      }
      if (pathname.endsWith('/pharmacies')) {
        return route.fulfill({ json: pharmacies });
      }
      if (pathname.endsWith('/orders')) {
        if (method === 'POST') {
          const body = route.request().postDataJSON();
          currentOrder = {
            ...body,
            _id: 'ord-999',
            patientId,
            status: 'out_for_delivery',
            handoverOtp: '4821',
            createdAt: new Date().toISOString(),
            statusHistory: [
              { status: 'new', at: new Date(Date.now() - 3600000).toISOString() },
              { status: 'accepted', at: new Date(Date.now() - 3000000).toISOString() },
              { status: 'preparing', at: new Date(Date.now() - 2000000).toISOString() },
              { status: 'ready', at: new Date(Date.now() - 1000000).toISOString() },
              { status: 'out_for_delivery', at: new Date(Date.now() - 300000).toISOString() },
            ],
            courierLocation: { lat: 12.9725, lng: 77.638, accuracy: 5, observedAt: new Date().toISOString() },
            delivery: {
              courierId: 'cour-88',
              lastLocation: { lat: 12.9725, lng: 77.638 },
            },
          };
          orders.unshift(currentOrder);
          return route.fulfill({ json: currentOrder });
        }
        return route.fulfill({ json: orders });
      }
      if (pathname.includes('/orders/ord-999')) {
        if (method === 'GET') {
          return route.fulfill({ json: currentOrder });
        }
      }

      return route.fulfill({ json: [] });
    });

    await page.goto('/app');
    await expect(page.getByRole('navigation', { name: 'Patient navigation' })).toBeVisible();

    // Click on the Pharmacy bottom nav tab
    await page.getByRole('navigation', { name: 'Patient navigation' }).getByRole('link', { name: 'Pharmacy' }).click();
    await expect(page.getByRole('heading', { name: 'Pharmacy', exact: true })).toBeVisible();

    // Switch to Prescriptions sub-tab
    await page.getByRole('tab', { name: /Prescriptions/ }).click();
    await expect(page.getByText('Metformin')).toBeVisible();

    // Click Order now
    await page.getByRole('button', { name: 'Order now →' }).click();
    await expect(page.getByRole('heading', { name: 'New Pharmacy Order' })).toBeVisible();

    // Select pharmacy and enter delivery address
    await page.getByPlaceholder('Street, Building, Apartment, City, Pincode').fill('Flat 402, Lotus Apts, Indiranagar, Bangalore');

    // Place the order
    await page.getByRole('button', { name: 'Place Order' }).click();

    // Verify order detail view opened and status is Out for Delivery
    await expect(page.getByText('Your order has been placed successfully!')).toBeVisible();
    await expect(page.getByText('Handover Verification OTP')).toBeVisible();
    await expect(page.getByText('4821')).toBeVisible();

    // Verify courier tracking map is attached and live GPS indicator is visible while out for delivery
    await expect(page.getByText('Delivery Live Tracking')).toBeVisible();
    await expect(page.getByText('Live GPS')).toBeVisible();
    await expect(page.locator('.pt-map')).toBeAttached();

    // Simulate order transition to delivered
    currentOrder.status = 'delivered';
    currentOrder.courierLocation = null;
    if (currentOrder.delivery) currentOrder.delivery.lastLocation = null;

    // Trigger order refresh by switching back to orders and reopening
    await page.getByRole('button', { name: 'Back to orders' }).click();
    await page.getByText('Apollo Health Pharmacy').click();

    // Verify delivered status and privacy rule: courier location is hidden once delivered
    await expect(page.getByText('Package delivered. Courier tracking ended per privacy protection policy.')).toBeVisible();
    await expect(page.locator('.pt-map')).toHaveCount(0);
  });
});
