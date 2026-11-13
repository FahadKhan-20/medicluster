import { test, expect } from '@playwright/test';

async function setupChatMocks(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  await page.addInitScript(() => {
    localStorage.setItem('medicluster.token', 'clinician-fixture-token');
  });

  let lastChatRequest = null;
  let lastActionRequest = null;

  await page.route(u => u.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/auth/me') {
      return route.fulfill({
        json: {
          user: {
            id: 'staff-dr-smith',
            name: 'Dr. Smith',
            email: 'smith@medicluster.org',
            department: 'Emergency & Critical Care',
            role: 'clinician',
            onboarded: true,
          },
        },
      });
    }

    if (path === '/api/health/ml') {
      return route.fulfill({ json: { online: true } });
    }

    if (path === '/api/alerts' || path === '/api/alerts/') {
      return route.fulfill({
        json: [
          {
            id: 'ALT-101',
            patient_id: 'P001',
            severity: 'CRITICAL',
            title: 'Critical Sepsis Indicator',
            summary: 'Elevated SOFA score > 4 detected by background surveillance.',
            createdAt: new Date().toISOString(),
            status: 'active',
            read: false,
          },
        ],
      });
    }

    if (path.startsWith('/api/agent/audit')) {
      return route.fulfill({
        json: {
          audits: [
            {
              id: 'AUDIT-881',
              event: {
                kind: 'DeteriorationAlert',
                source: 'Telemetry ICU',
                patientId: 'P072',
              },
              outcome: 'executed',
              reason: 'Elevated heart rate & MAP decrease crossed threshold',
              prob: 0.92,
              timestamp: new Date().toISOString(),
              facts: [
                'Heart rate spiked from 78 to 132 bpm',
                'MAP decreased from 85 to 58 mmHg',
                'Urine output < 0.5 mL/kg/h',
              ],
              probabilities: [
                { label: 'Septic Shock', value: 0.92 },
                { label: 'Deterioration', value: 0.85 },
                { label: 'Code Blue', value: 0.15 },
              ],
              gateVerdict: 'APPROVED',
              toolCalls: [
                { name: 'dispatch_ambulance', args: { unit: 'Medic 1' } },
                { name: 'create_critical_alert', args: { alertId: 'ALT-101' } },
              ],
            },
          ],
        },
      });
    }

    if (path === '/api/cliniq/chat') {
      const body = route.request().postDataJSON();
      lastChatRequest = body;
      const q = String(body.question || '').toLowerCase();

      if (q.includes('p072') || q.includes('explain') || q.includes('decision')) {
        return route.fulfill({
          json: {
            role: 'assistant',
            reply: 'Here is the autonomous agent consensus replay for patient P072.',
            model: 'jev-consensus-v1',
            provider: 'agent-core',
            results: [
              {
                tool: 'explain_agent_decision',
                data: {
                  decision: {
                    id: 'AUDIT-881',
                    action: 'Emergency Escalation & Alert Dispatch',
                    outcome: 'executed',
                    reason: 'Elevated heart rate & MAP decrease crossed threshold',
                    prob: 0.92,
                    patientId: 'P072',
                    facts: [
                      'Heart rate spiked from 78 to 132 bpm',
                      'MAP decreased from 85 to 58 mmHg',
                      'Urine output < 0.5 mL/kg/h',
                    ],
                    probabilities: [
                      { label: 'Septic Shock', value: 0.92 },
                      { label: 'Deterioration', value: 0.85 },
                      { label: 'Code Blue', value: 0.15 },
                    ],
                    gateVerdict: 'APPROVED',
                    toolCalls: [
                      { name: 'dispatch_ambulance', args: { unit: 'Medic 1' } },
                      { name: 'create_critical_alert', args: { alertId: 'ALT-101' } },
                    ],
                  },
                },
              },
            ],
            actions: [],
          },
        });
      }

      if (q.includes('ambulance') || q.includes('p001')) {
        return route.fulfill({
          json: {
            role: 'assistant',
            reply: 'Here are the nearest available ambulances to patient P001.',
            model: 'medicluster-v1',
            provider: 'cliniq',
            results: [
              {
                tool: 'nearby_ambulances',
                data: {
                  ambulances: [
                    {
                      ambulance_id: 'AMB-01',
                      callsign: 'Medic 1',
                      type: 'ALS',
                      status: 'AVAILABLE',
                      latitude: 37.7749,
                      longitude: -122.4194,
                      distanceKm: 1.2,
                      etaMinutes: 4,
                    },
                    {
                      ambulance_id: 'AMB-02',
                      callsign: 'Rescue 3',
                      type: 'BLS',
                      status: 'AVAILABLE',
                      latitude: 37.7780,
                      longitude: -122.4150,
                      distanceKm: 2.5,
                      etaMinutes: 7,
                    },
                  ],
                },
              },
            ],
            actions: [],
          },
        });
      }

      if (q.includes('acknowledge') || q.includes('alt-101') || q.includes('alert')) {
        return route.fulfill({
          json: {
            role: 'assistant',
            reply: 'I have prepared the acknowledgment for alert ALT-101. Please confirm the action.',
            model: 'medicluster-v1',
            provider: 'cliniq',
            results: [],
            actions: [
              {
                id: 'action-ack-101',
                tool: 'acknowledge_alert',
                arguments: {
                  alertId: 'ALT-101',
                  patientId: 'P001',
                  severity: 'CRITICAL',
                },
                status: 'PROPOSED',
              },
            ],
          },
        });
      }

      // Default echo
      return route.fulfill({
        json: {
          role: 'assistant',
          reply: `Received query: ${body.question}`,
          model: 'medicluster-v1',
          provider: 'cliniq',
          results: [],
          actions: [],
        },
      });
    }

    if (path.startsWith('/api/cliniq/actions/')) {
      const body = route.request().postDataJSON();
      lastActionRequest = {
        url: path,
        body,
        headers: route.request().headers(),
      };
      return route.fulfill({
        json: {
          result: {
            status: 'succeeded',
            actionId: path.split('/').pop(),
            verified: true,
          },
        },
      });
    }

    // Default 200 empty
    return route.fulfill({ json: {} });
  });

  return {
    getLastChatRequest: () => lastChatRequest,
    getLastActionRequest: () => lastActionRequest,
  };
}

test('chat launcher opens on /alerts, asks for nearest ambulance, renders map card, and confirms action', async ({
  page,
}) => {
  const mocks = await setupChatMocks(page);

  // 1. Visit /alerts
  await page.goto('/alerts');
  await expect(page.getByRole('dialog', { name: 'Starting MediCluster' })).toBeHidden({ timeout: 10000 });
  await expect(page.locator('h1, h2').first()).toBeVisible();

  // 2. Locate and click floating "Ask MediCluster Agent" chat launcher
  const launcherBtn = page.locator('[data-testid="floating-chat-launcher"]');
  await expect(launcherBtn).toBeVisible();
  await launcherBtn.click();

  // 3. Side panel drawer opens
  const sidePanel = page.locator('[data-testid="chat-side-panel"]');
  await expect(sidePanel).toBeVisible();

  // Verify suggested chips exist in empty state
  const chips = page.locator('[data-testid="suggested-chips"]');
  await expect(chips).toBeVisible();
  await expect(page.locator('[data-testid="suggested-chip-dispatch"]')).toBeVisible();

  // 4. Ask nearest ambulance to patient P001
  const composerInput = sidePanel.locator('textarea');
  await composerInput.fill('Nearest ambulance to patient P001');
  await sidePanel.locator('button[type="submit"]').click();

  // 5. Verify assistant reply and rich ambulance list card with mini OSM map
  await expect(
    sidePanel.getByText('Here are the nearest available ambulances to patient P001.')
  ).toBeVisible();

  const ambulanceCard = sidePanel.locator('[data-testid="ambulance-list-card"]');
  await expect(ambulanceCard).toBeVisible();
  await expect(ambulanceCard.getByText('Medic 1')).toBeVisible();
  await expect(ambulanceCard.getByText('Rescue 3')).toBeVisible();

  const miniMap = ambulanceCard.locator('[data-testid="mini-osm-map"]');
  await expect(miniMap).toBeVisible();
  await expect(miniMap.locator('.leaflet-container')).toBeVisible();
  await expect(miniMap.locator('.mc-map-pin').first()).toBeVisible();

  // 6. Ask to acknowledge alert
  await composerInput.fill('Acknowledge alert ALT-101');
  await sidePanel.locator('button[type="submit"]').click();

  // 7. Verify action confirmation card appears (never auto-confirms)
  const actionCard = sidePanel.locator('[data-testid="action-confirm-card"]');
  await expect(actionCard).toBeVisible();
  await expect(
    sidePanel.getByText('I have prepared the acknowledgment for alert ALT-101')
  ).toBeVisible();

  const confirmBtn = actionCard.locator('[data-testid="confirm-action-button"]');
  const cancelBtn = actionCard.locator('[data-testid="cancel-action-button"]');
  await expect(confirmBtn).toBeVisible();
  await expect(cancelBtn).toBeVisible();

  // Confirm that action has NOT yet been called
  expect(mocks.getLastActionRequest()).toBeNull();

  // 8. Click Confirm Action
  await confirmBtn.click();

  // 9. Verify /api/cliniq/actions/action-ack-101 was invoked with decision: 'approve'
  await expect(
    actionCard.getByText('Action executed successfully')
  ).toBeVisible();

  const actionReq = mocks.getLastActionRequest();
  expect(actionReq).not.toBeNull();
  expect(actionReq.url).toBe('/api/cliniq/actions/action-ack-101');
  expect(actionReq.body).toEqual({ decision: 'approve' });
});

test('chat conversation persists across page navigation and can be toggled with Ctrl+K', async ({
  page,
}) => {
  await setupChatMocks(page);

  await page.goto('/alerts');
  await expect(page.getByRole('dialog', { name: 'Starting MediCluster' })).toBeHidden({ timeout: 10000 });
  const sidePanel = page.locator('[data-testid="chat-side-panel"]');
  await expect(sidePanel).toHaveCount(0);

  // Open with Ctrl+K / Meta+K
  await page.keyboard.press('Control+k');
  await expect(sidePanel).toBeVisible();

  // Send a message
  const composerInput = sidePanel.locator('textarea');
  await composerInput.fill('Nearest ambulance to patient P001');
  await sidePanel.locator('button[type="submit"]').click();
  await expect(sidePanel.locator('[data-testid="ambulance-list-card"]')).toBeVisible();

  // Close panel using close button
  await sidePanel.locator('button[aria-label="Close chat panel"]').click();
  await expect(sidePanel).toHaveCount(0);

  // Navigate to another page (/dashboard)
  await page.goto('/dashboard');
  await expect(page.locator('[data-testid="floating-chat-launcher"]')).toBeVisible();

  // Re-open chat panel on /dashboard
  await page.keyboard.press('Control+k');
  await expect(sidePanel).toBeVisible();

  // Verify conversation history persisted across navigation!
  await expect(sidePanel.locator('[data-testid="ambulance-list-card"]')).toBeVisible();
  await expect(
    sidePanel.getByText('Here are the nearest available ambulances to patient P001.')
  ).toBeVisible();
});

test('standalone CliniQ at /cliniq renders multi-step timeline, live agent strip, and inline decision replay', async ({
  page,
}) => {
  await setupChatMocks(page);

  // 1. Visit /cliniq standalone app
  await page.goto('/cliniq');
  await expect(page.locator('[data-testid="cliniq-standalone-app"]')).toBeVisible();

  // 2. Verify Live Agent strip is visible with audit items
  const liveStrip = page.locator('[data-testid="live-agent-strip"]');
  await expect(liveStrip).toBeVisible();
  await expect(liveStrip.getByText('Live Agent')).toBeVisible();
  await expect(liveStrip.getByText('DeteriorationAlert')).toBeVisible();
  await expect(liveStrip.getByText('P072')).toBeVisible();

  // 3. Send multi-step query requiring decision consensus replay via suggested chip
  const promptChip = page.locator('[data-testid="suggested-chip-decision"]');
  await expect(promptChip).toBeVisible();
  await promptChip.click();

  // 4. Verify assistant reply and multi-step execution timeline trace
  const assistantMsg = page.locator('[data-testid="chat-assistant-message"]').first();
  await expect(assistantMsg).toBeVisible();

  const timeline = assistantMsg.locator('[data-testid="execution-timeline"]');
  await expect(timeline).toBeVisible();
  await expect(timeline.getByText('Agent Execution Trace')).toBeVisible();
  await expect(timeline.getByText('Understanding request')).toBeVisible();
  await expect(timeline.getByText('Calling tool explain_agent_decision')).toBeVisible();
  await expect(timeline.getByText('Done')).toBeVisible();

  // 5. Verify Decision Replay steps rendered inline inside chat bubble
  const decisionCard = assistantMsg.locator('[data-testid="agent-decision-card"]');
  await expect(decisionCard).toBeVisible();

  const replaySteps = decisionCard.locator('[data-testid="decision-replay-steps"]');
  await expect(replaySteps).toBeVisible();
  await expect(replaySteps.getByText('1. Trigger Event')).toBeVisible();
  await expect(replaySteps.getByText('2. Extracted Clinical Facts (Gemini)')).toBeVisible();
  await expect(replaySteps.getByText('Heart rate spiked from 78 to 132 bpm')).toBeVisible();
  await expect(replaySteps.getByText('3. Jev Probability Consensus')).toBeVisible();
  await expect(replaySteps.getByText('Septic Shock')).toBeVisible();
  await expect(replaySteps.getByText('92%')).toBeVisible();
  await expect(replaySteps.getByText('4. Consensus Gate Verdict')).toBeVisible();
  await expect(replaySteps.getByText('APPROVED')).toBeVisible();
  await expect(replaySteps.getByText('5. Authorized Tool Calls')).toBeVisible();
  await expect(replaySteps.getByText('dispatch_ambulance')).toBeVisible();

  // Replay link navigates to /agent
  const replayLink = decisionCard.locator('[data-testid="agent-replay-link"]');
  await expect(replayLink).toBeVisible();
  expect(await replayLink.getAttribute('href')).toBe('/agent');

  // 6. Test Live Agent strip item click -> inline replay in chat
  const auditItem = liveStrip.locator('[data-testid="live-agent-audit-item"]').first();
  await auditItem.click();

  // Verify that an assistant message with inline decision replay was added!
  const messages = page.locator('[data-testid="chat-assistant-message"]');
  await expect(messages).toHaveCount(2);
  await expect(page.getByText('Autonomous Decision Replay: DeteriorationAlert')).toBeVisible();
});
