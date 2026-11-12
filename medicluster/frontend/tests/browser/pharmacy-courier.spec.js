import { test, expect } from '@playwright/test';

test.describe('Pharmacy and Courier Suite', () => {

  test('pharmacist logs in, progresses order accept->prepare->ready, and checks stock', async ({ page }) => {
    let orderState = {
      id: 'ORD-101',
      status: 'new',
      patientFirstName: 'Ramesh',
      patientName: 'Ramesh Kumar',
      doctorName: 'Dr. Neha Sharma',
      fulfilment: 'pickup',
      createdAt: new Date().toISOString(),
      items: [
        { drug: 'Amoxicillin', strength: '500mg', form: 'Capsule', dose: '1 cap', frequency: 'TID', durationDays: 5, quantity: 15 },
        { drug: 'Paracetamol', strength: '650mg', form: 'Tablet', dose: '1 tab', frequency: 'SOS', durationDays: 3, quantity: 10 },
      ],
      statusHistory: [
        { status: 'new', at: new Date().toISOString(), note: 'Prescription received from clinician dashboard' },
      ],
    };

    const stockItems = [
      { id: 'stk-1', drug: 'Amoxicillin', strength: '500mg', barcode: '8901234567890', quantity: 120, lowStockThreshold: 20, batch: 'AMX-2026', expiry: '2027-08-30' },
      { id: 'stk-2', drug: 'Paracetamol', strength: '650mg', barcode: '8901234567891', quantity: 8, lowStockThreshold: 25, batch: 'PCM-2026', expiry: '2027-12-31' },
    ];

    // Mock API routes
    await page.route('**/api/pharmacy-auth/login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          token: 'jwt-pharmacy-token-test',
          staff: { id: 'pharm-1', name: 'Dr. Anita Rao', role: 'pharmacist', email: 'pharmacist@medicluster.test' },
          pharmacies: [{ id: 'ph-blr-1', name: 'MediCluster Apollo Indiranagar', address: 'Indiranagar 12th Main' }],
        },
      });
    });

    await page.route(u => u.href.includes('/api/pharmacy/orders'), async (route) => {
      const url = route.request().url();
      if (url.includes('/actions')) {
        const body = route.request().postDataJSON();
        if (body.action === 'accept') {
          orderState = { ...orderState, status: 'accepted', statusHistory: [...orderState.statusHistory, { status: 'accepted', at: new Date().toISOString() }] };
        } else if (body.action === 'start') {
          orderState = { ...orderState, status: 'preparing', statusHistory: [...orderState.statusHistory, { status: 'preparing', at: new Date().toISOString() }] };
        } else if (body.action === 'ready') {
          orderState = { ...orderState, status: 'ready', handoverOtp: '8899', statusHistory: [...orderState.statusHistory, { status: 'ready', at: new Date().toISOString() }] };
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: { ok: true, order: orderState },
        });
        return;
      }

      if (url.includes('/ORD-101')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: orderState,
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: [orderState],
      });
    });

    await page.route(u => u.href.includes('/api/pharmacy/stock'), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: stockItems,
      });
    });

    await page.route(u => u.href.includes('/api/pharmacy/couriers'), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: [{ id: 'c-1', name: 'Ravi Courier', phone: '+91 99887 76655' }],
      });
    });

    // 1. Visit /pharmacy and log in
    await page.goto('/pharmacy');
    await expect(page.getByRole('heading', { name: 'Pharmacy Portal' })).toBeVisible();

    await page.fill('#pharmacy-email', 'pharmacist@medicluster.test');
    await page.fill('#pharmacy-password', 'password123');
    await page.click('button[type="submit"]');

    // 2. Queue screen loads
    await expect(page.getByRole('heading', { name: 'MediCluster Apollo Indiranagar' })).toBeVisible();
    await expect(page.getByTestId('order-row-ORD-101')).toBeVisible();
    await expect(page.getByText('Ramesh').first()).toBeVisible();

    // 3. Open Order Detail
    await page.click('[data-testid="order-row-ORD-101"]');
    await expect(page.getByTestId('order-status-badge')).toHaveText('New Order');
    await expect(page.getByText('Amoxicillin 500mg')).toBeVisible();
    await expect(page.getByText('Dr. Neha Sharma')).toBeVisible();

    // 4. Accept Order
    const acceptBtn = page.getByTestId('action-accept-btn');
    await expect(acceptBtn).toBeVisible();
    await acceptBtn.click();
    await expect(page.getByTestId('order-status-badge')).toHaveText('Accepted');

    // 5. Start Preparing
    const startBtn = page.getByTestId('action-start-btn');
    await expect(startBtn).toBeVisible();
    await startBtn.click();
    await expect(page.getByTestId('order-status-badge')).toHaveText('Preparing');

    // 6. Mark Ready
    const readyBtn = page.getByTestId('action-ready-btn');
    await expect(readyBtn).toBeVisible();
    await readyBtn.click();
    await expect(page.getByTestId('order-status-badge')).toHaveText('Ready for Handover');

    // 7. Handover button is available for pickup order
    await expect(page.getByTestId('action-handover-btn')).toBeVisible();

    // 8. Navigate to Stock tab
    await page.getByRole('button', { name: 'Inventory Stock' }).click();
    await expect(page.getByRole('heading', { name: 'Inventory & Stock' })).toBeVisible();
    await expect(page.getByText('Paracetamol').first()).toBeVisible();
    await expect(page.getByTestId('low-stock-badge').first()).toBeVisible();
  });

  test('courier logs in, accepts delivery, shares live GPS on OSM map, and delivers with OTP', async ({ page }) => {
    let deliveryState = {
      id: 'DEL-201',
      status: 'accepted',
      courierId: 'cour-1',
      patientFirstName: 'Priya',
      patientPhone: '+91 98800 11223',
      pharmacy: {
        id: 'ph-blr-1',
        name: 'Apollo Pharmacy Indiranagar',
        address: '100ft Road, Indiranagar',
        lat: 12.9716,
        lng: 77.5946,
      },
      deliveryAddress: {
        text: 'Apartment 4B, Defence Colony, Indiranagar',
        lat: 12.9784,
        lng: 77.6408,
      },
      items: [
        { drug: 'Azithromycin', strength: '500mg', quantity: 3 },
      ],
      lastLocation: { lat: 12.9716, lng: 77.5946, accuracy: 5 },
    };

    const locationFixes = [];

    // Inject simulated Geolocation
    await page.addInitScript(() => {
      navigator.geolocation.watchPosition = (success) => {
        window.__courierGps = { success };
        // Initial GPS fix
        success({
          coords: { latitude: 12.9740, longitude: 77.6100, accuracy: 8 },
          timestamp: Date.now(),
        });
        return 42;
      };
      navigator.geolocation.clearWatch = () => {};
    });

    // Mock courier API routes
    await page.route('**/api/courier-auth/login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          token: 'jwt-courier-token-test',
          staff: { id: 'cour-1', name: 'Vikram Rider', role: 'courier', phone: '+91 98765 43210' },
        },
      });
    });

    await page.route('**/api/courier/deliveries', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: [deliveryState],
      });
    });

    await page.route('**/api/courier/deliveries/DEL-201', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: deliveryState,
      });
    });

    await page.route('**/api/courier/deliveries/DEL-201/actions', async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === 'pickup') {
        deliveryState = { ...deliveryState, status: 'picked_up' };
      } else if (body.action === 'deliver') {
        deliveryState = { ...deliveryState, status: 'delivered', proof: { kind: 'otp', note: body.note } };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { ok: true, delivery: deliveryState },
      });
    });

    await page.route('**/api/courier/deliveries/DEL-201/location', async (route) => {
      locationFixes.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, json: { ok: true } });
    });

    // 1. Visit /courier and log in
    await page.goto('/courier');
    await expect(page.getByRole('heading', { name: 'Courier Delivery' })).toBeVisible();

    await page.fill('#courier-phone', '+91 98765 43210');
    await page.fill('#courier-pin', '1234');
    await page.click('button[type="submit"]');

    // 2. Deliveries list screen loads
    await expect(page.getByText('Vikram Rider', { exact: true })).toBeVisible();
    await expect(page.getByTestId('delivery-card-DEL-201')).toBeVisible();
    await expect(page.getByText('Priya').first()).toBeVisible();

    // 3. Open active delivery
    await page.click('[data-testid="delivery-card-DEL-201"]');
    await expect(page.getByText('Delivery #DEL-201').first()).toBeVisible();

    // 4. Confirm pickup
    const pickupBtn = page.getByTestId('courier-pickup-btn');
    await expect(pickupBtn).toBeVisible();
    await pickupBtn.click();

    // 5. Status transitions to picked_up: map and GPS sharing active
    await expect(page.getByTestId('gps-sharing-indicator')).toBeVisible();
    await expect(page.getByTestId('courier-osm-map')).toBeVisible();

    // 6. Push a new live GPS coordinate from device
    await page.evaluate(() => {
      window.__courierGps.success({
        coords: { latitude: 12.9765, longitude: 77.6250, accuracy: 5 },
        timestamp: Date.now(),
      });
    });

    // 7. Verify GPS location fix was delivered to server endpoint
    await expect.poll(() => locationFixes.length).toBeGreaterThan(0);
    const lastFix = locationFixes[locationFixes.length - 1];
    expect(lastFix.lat).toBe(12.9765);
    expect(lastFix.lng).toBe(77.6250);

    // 8. Complete handover with 4-digit OTP
    const handoverBtn = page.getByTestId('courier-handover-btn');
    await expect(handoverBtn).toBeVisible();
    await handoverBtn.click();

    await page.fill('#courier-otp-input', '5678');
    await page.fill('#courier-pod-note', 'Delivered directly to Priya');
    await page.click('[data-testid="confirm-courier-deliver-btn"]');

    // 9. Delivery marked completed
    await expect(page.getByText('Delivery Completed!')).toBeVisible();
    await expect(page.getByText('Proof note: Delivered directly to Priya')).toBeVisible();
  });

  test('pharmacist action 409 conflict displays already changed alert and refetches latest order state', async ({ page }) => {
    let orderState = {
      id: 'ORD-409',
      status: 'new',
      patientFirstName: 'Anand',
      patientName: 'Anand Verma',
      doctorName: 'Dr. Neha Sharma',
      fulfilment: 'pickup',
      createdAt: new Date().toISOString(),
      items: [
        { drug: 'Metformin', strength: '500mg', form: 'Tablet', quantity: 30 },
      ],
      statusHistory: [],
    };

    let conflictFired = false;

    // Login mock
    await page.route('**/api/pharmacy-auth/login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          token: 'jwt-pharmacy-409',
          staff: { id: 'pharm-1', name: 'Dr. Anita Rao', role: 'pharmacist' },
          pharmacies: [{ id: 'ph-blr-1', name: 'MediCluster Apollo Indiranagar' }],
        },
      });
    });

    await page.route(u => u.href.includes('/api/pharmacy/orders'), async (route) => {
      const url = route.request().url();
      if (url.includes('/actions')) {
        // Return 409 Conflict simulating another pharmacist acting concurrently
        conflictFired = true;
        orderState = { ...orderState, status: 'accepted', note: 'Accepted concurrently by staff B' };
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          json: { error: 'Order was already changed by someone else. Please refresh.' },
        });
        return;
      }

      if (url.includes('/ORD-409')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: orderState,
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: [orderState],
      });
    });

    await page.route(u => u.href.includes('/api/pharmacy/stock'), async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });

    await page.route(u => u.href.includes('/api/pharmacy/couriers'), async (route) => {
      await route.fulfill({ status: 200, json: [] });
    });

    await page.goto('/pharmacy');
    await expect(page.getByRole('heading', { name: 'Pharmacy Portal' })).toBeVisible();
    await page.fill('#pharmacy-email', 'pharmacist@medicluster.test');
    await page.fill('#pharmacy-password', 'password123');
    await page.click('button[type="submit"]');

    await expect(page.getByTestId('order-row-ORD-409')).toBeVisible();
    await page.click('[data-testid="order-row-ORD-409"]');

    await expect(page.getByTestId('order-status-badge')).toHaveText('New Order');

    // Attempt accept action
    const acceptBtn = page.getByTestId('action-accept-btn');
    await expect(acceptBtn).toBeVisible();
    await acceptBtn.click();

    // Verify 409 conflict alert is shown
    const conflictAlert = page.getByTestId('conflict-alert');
    await expect(conflictAlert).toBeVisible();
    await expect(conflictAlert).toContainText('already changed by someone else');

    // Verify auto-refetch updates status to Accepted
    await expect(page.getByTestId('order-status-badge')).toHaveText('Accepted');
  });

});
