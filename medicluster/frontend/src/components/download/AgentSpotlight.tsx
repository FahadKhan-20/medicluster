import { ArrowUpRight, Shield, Cpu, Activity, RotateCcw } from "lucide-react";

/**
 * MediCluster Agent section:
 * One autonomous AI agent operating every app across the healthcare continuum.
 * Jev decides, Gemini executes, with kill switch and Decision Replay.
 * Treatment actions are always clinician-confirmed.
 */
export default function AgentSpotlight() {
  return (
    <section
      className="mc-clinical mc-agent-spotlight mc-container"
      id="agent"
      aria-labelledby="agent-title"
    >
      <div className="mc-clinical-copy" data-reveal>
        <p className="mc-section-label">Autonomous care orchestration</p>
        <h2 id="agent-title">
          MediCluster Agent.
          <br />
          <em>One intelligence.</em>
          <br />
          Across every app.
        </h2>
        <p className="mc-body">
          One autonomous AI agent operating every app — medical imaging,
          clinical alerts, patient reminders, deterioration radar, sepsis surveillance,
          ECG rhythm triage, Code Blue war room, ambulance dispatch, pharmacy operations,
          and service self-heal.
        </p>

        <div className="mc-agent-safety-box" role="region" aria-label="Clinical safety policy">
          <p className="mc-agent-safety-title">
            <Shield size={16} aria-hidden="true" />
            <span>Clinical Safety Guarantee</span>
          </p>
          <p className="mc-agent-safety-text">
            Treatment actions are always clinician-confirmed. The agent monitors, forecasts,
            and prepares interventions across services, but therapeutic actions, medication releases,
            and clinical orders require human-in-the-loop clinician confirmation.
          </p>
        </div>

        <a href="/agent" className="mc-text-link" aria-label="Open staff Agent console">
          Open staff Agent console (/agent) <ArrowUpRight size={18} aria-hidden="true" />
        </a>
        <p className="mc-ops-signin">
          Staff workspace · Real-time kill switch · Immutable Decision Replay audit
        </p>
      </div>

      <ol
        className="mc-clinical-workflow"
        aria-label="Agent architecture and capabilities"
        data-reveal
      >
        <li>
          <span className="mc-workflow-number">01</span>
          <div>
            <h3>Jev decides, Gemini executes</h3>
            <p>
              Dual-layer intelligence: deterministic policy evaluation and safety bounds (Jev)
              pair with multi-modal reasoning and clinical tool execution (Gemini).
            </p>
          </div>
        </li>
        <li>
          <span className="mc-workflow-number">02</span>
          <div>
            <h3>Kill switch & Decision Replay</h3>
            <p>
              Instantaneous software and hardware kill switch for immediate operational stop.
              Every prompt, tool invocation, and decision path is preserved in an immutable audit
              log for retrospective Decision Replay.
            </p>
          </div>
        </li>
        <li>
          <span className="mc-workflow-number">03</span>
          <div>
            <h3>Validated Clinical Benchmarks</h3>
            <p>
              Ground-truth performance metrics across models: ECG rhythm macro-AUC 0.906,
              arrest-rhythm detection F1 0.88, and multi-parameter sepsis risk AUROC 0.77.
            </p>
          </div>
        </li>
      </ol>
    </section>
  );
}
