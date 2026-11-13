import React from 'react';
import { AlertCircle, ArrowRight, Sparkles } from 'lucide-react';

/**
 * Mobile-app style sign-in shell shared by the Pharmacy and Courier portals.
 * Forest header with the MediCluster mark, then an ivory sheet holding the form.
 */
export default function StaffLogin({
  icon: Icon,
  eyebrow,
  title,
  subtitle,
  error,
  busy,
  busyLabel,
  submitLabel,
  onSubmit,
  demo,
  backHref = '/login',
  backLabel = 'Back to MediCluster',
  children,
}) {
  return (
    <div className="rx-portal">
      <div className="rx-container rx-login">
        <div className="rx-login-hero">
          <div className="rx-login-brand">
            <span className="rx-login-mark" aria-hidden="true">
              <i /><i /><i /><i />
            </span>
            MediCluster
          </div>
          <div className="rx-login-icon"><Icon size={26} /></div>
          <p className="rx-login-eyebrow">{eyebrow}</p>
          <h1 className="rx-login-title">{title}</h1>
          <p className="rx-login-sub">{subtitle}</p>
        </div>

        <div className="rx-login-sheet">
          {error && (
            <div className="rx-alert rx-alert-error" role="alert">
              <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>{error}</div>
            </div>
          )}

          <form onSubmit={onSubmit} className="rx-login-form">
            {children}
            <button type="submit" className="rx-btn rx-login-submit" disabled={busy}>
              {busy ? busyLabel : submitLabel} <ArrowRight size={16} />
            </button>
          </form>

          {demo && (
            <div className="rx-login-demo">
              <Sparkles size={15} />
              <div>
                <strong>Demo account</strong>
                <span>{demo.label}</span>
              </div>
              <button type="button" onClick={demo.onUse}>Use</button>
            </div>
          )}

          <a href={backHref} className="rx-login-back">← {backLabel}</a>
        </div>
      </div>
    </div>
  );
}

/** Labelled input with a leading icon. */
export function LoginField({ id, label, icon: Icon, ...inputProps }) {
  return (
    <div className="rx-field">
      <label htmlFor={id}>{label}</label>
      <div className="rx-input-wrap">
        {Icon && <Icon size={17} className="rx-input-icon" aria-hidden="true" />}
        <input id={id} className="rx-input rx-input-iconed" {...inputProps} />
      </div>
    </div>
  );
}
