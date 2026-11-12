/**
 * Simulated Monitor Feed:
 * Scripted clinical scenario: VF → Shock 1 → VF → Epinephrine → Shock 2 → ROSC
 * Produces synthetic continuous 250 Hz ECG waveforms for each phase so the demo runs with zero typing.
 */

export type ScenarioPhase = "VF_INITIAL" | "VF_POST_SHOCK1" | "VF_EPI_GIVEN" | "PRE_ROSC" | "ROSC";

export interface MonitorState {
  codeTimeSeconds: number;
  currentPhase: ScenarioPhase;
  rhythmName: string;
  isShockable: boolean;
  hasPulse: boolean;
  heartRateBpm: number;
  waveformChunk: number[]; // 250 Hz samples
  phaseDescription: string;
}

export class CodeBlueSimulator {
  private startTimeMs: number;
  private customOffsetSeconds: number = 0;

  constructor() {
    this.startTimeMs = Date.now();
  }

  reset(): void {
    this.startTimeMs = Date.now();
    this.customOffsetSeconds = 0;
  }

  setElapsedSeconds(seconds: number): void {
    this.customOffsetSeconds = seconds;
    this.startTimeMs = Date.now() - seconds * 1000;
  }

  getElapsedSeconds(): number {
    return Math.floor((Date.now() - this.startTimeMs) / 1000);
  }

  getPhase(tSeconds: number): {
    phase: ScenarioPhase;
    rhythm: string;
    isShockable: boolean;
    hasPulse: boolean;
    hr: number;
    description: string;
  } {
    if (tSeconds < 25) {
      return {
        phase: "VF_INITIAL",
        rhythm: "VF",
        isShockable: true,
        hasPulse: false,
        hr: 0,
        description: "Patient found unresponsive: Coarse Ventricular Fibrillation (VF).",
      };
    }
    if (tSeconds < 50) {
      return {
        phase: "VF_POST_SHOCK1",
        rhythm: "VF",
        isShockable: true,
        hasPulse: false,
        hr: 0,
        description: "Post-defibrillation (Shock 1): Recurrent coarse VF during CPR cycle 1.",
      };
    }
    if (tSeconds < 80) {
      return {
        phase: "VF_EPI_GIVEN",
        rhythm: "VF",
        isShockable: true,
        hasPulse: false,
        hr: 0,
        description: "Epinephrine 1 mg administered: Persistent refractory VF.",
      };
    }
    if (tSeconds < 100) {
      return {
        phase: "PRE_ROSC",
        rhythm: "VF",
        isShockable: true,
        hasPulse: false,
        hr: 0,
        description: "Shock 2 delivered + Amiodarone bolus: Transitioning rhythm.",
      };
    }
    return {
      phase: "ROSC",
      rhythm: "ROSC",
      isShockable: false,
      hasPulse: true,
      hr: 82,
      description: "ROSC ACHIEVED! Normal Sinus Rhythm restored at 82 bpm with strong palpable pulse.",
    };
  }

  /**
   * Synthesizes 4 seconds (1000 samples at 250 Hz) of ECG waveform matching current phase.
   */
  generateWaveformWindow(tSeconds: number, numSamples = 1000, fs = 250): number[] {
    const { phase } = this.getPhase(tSeconds);
    const signal: number[] = new Array(numSamples);
    const dt = 1.0 / fs;

    if (phase === "ROSC") {
      // Normal Sinus Rhythm (80 bpm, RR = 0.75s, period = 187.5 samples)
      const rrSeconds = 60 / 82;
      for (let i = 0; i < numSamples; i++) {
        const t = (tSeconds + i * dt) % rrSeconds;
        let v = 0;
        // P wave: centered at 0.15s, amp 0.15 mV, width 0.04s
        v += 0.15 * Math.exp(-Math.pow((t - 0.15) / 0.035, 2));
        // Q wave: centered at 0.22s, amp -0.15 mV, width 0.015s
        v -= 0.15 * Math.exp(-Math.pow((t - 0.22) / 0.012, 2));
        // R wave: centered at 0.25s, amp 1.3 mV, width 0.02s
        v += 1.30 * Math.exp(-Math.pow((t - 0.25) / 0.018, 2));
        // S wave: centered at 0.28s, amp -0.35 mV, width 0.015s
        v -= 0.35 * Math.exp(-Math.pow((t - 0.28) / 0.014, 2));
        // T wave: centered at 0.45s, amp 0.35 mV, width 0.07s
        v += 0.35 * Math.exp(-Math.pow((t - 0.45) / 0.060, 2));
        // Baseline noise
        v += (Math.random() - 0.5) * 0.02;
        signal[i] = Math.round(v * 1000) / 1000;
      }
    } else {
      // Ventricular Fibrillation (Chaotic sum of sinusoids + amplitude modulation)
      for (let i = 0; i < numSamples; i++) {
        const t = tSeconds + i * dt;
        const f1 = 4.2;
        const f2 = 5.6;
        const f3 = 3.8;
        const envelope = 0.8 + 0.3 * Math.sin(2 * Math.PI * 0.4 * t);
        let v =
          envelope *
          (0.45 * Math.sin(2 * Math.PI * f1 * t + 0.3) +
            0.35 * Math.sin(2 * Math.PI * f2 * t + 1.2) +
            0.25 * Math.sin(2 * Math.PI * f3 * t + 2.5));
        // High frequency jitter
        v += (Math.random() - 0.5) * 0.08;
        signal[i] = Math.round(v * 1000) / 1000;
      }
    }

    return signal;
  }

  getCurrentState(): MonitorState {
    const elapsed = this.getElapsedSeconds();
    const phaseInfo = this.getPhase(elapsed);
    const waveform = this.generateWaveformWindow(elapsed, 250, 250); // 1-second strip update

    return {
      codeTimeSeconds: elapsed,
      currentPhase: phaseInfo.phase,
      rhythmName: phaseInfo.rhythm,
      isShockable: phaseInfo.isShockable,
      hasPulse: phaseInfo.hasPulse,
      heartRateBpm: phaseInfo.hr,
      waveformChunk: waveform,
      phaseDescription: phaseInfo.description,
    };
  }
}
