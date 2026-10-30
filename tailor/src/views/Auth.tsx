import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { signedIn } from '../lib/store';
import { errorText } from '../lib/util';

type Mode = 'signin' | 'signup' | 'forgot' | 'reset';

export default function Auth() {
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  function switchTo(next: Mode) {
    setMode(next);
    setError('');
    setNote('');
    setPassword('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signedIn(await api.authLogin(email, password));
      } else if (mode === 'signup') {
        await signedIn(await api.authSignup(name, email, password));
      } else if (mode === 'forgot') {
        await api.authSendReset(email);
        setMode('reset');
        setNote(`We sent a code to ${email}.`);
      } else {
        await signedIn(await api.authConfirmReset(email, code, password));
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const title = { signin: 'Sign in', signup: 'Create your account', forgot: 'Reset your password', reset: 'Choose a new password' }[mode];
  const button = { signin: 'Sign in', signup: 'Create account', forgot: 'Send me a code', reset: 'Save and sign in' }[mode];

  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="wordmark">
          <img src="/tailor-128.png" alt="" />
          <span>Tailor</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <h1>Apps that fit the way you work.</h1>
          <p>Tailor notices the things you do over and over, and makes small apps to help with them.</p>
        </div>
        <p>Your activity stays on this computer.</p>
      </aside>

      <main className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit} noValidate>
          <h2>{title}</h2>
          {note && <p className="muted">{note}</p>}

          {mode === 'signup' && (
            <label className="field">
              <span className="label">Your name</span>
              <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          )}
          {mode !== 'reset' && (
            <label className="field">
              <span className="label">Email</span>
              <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
          )}
          {mode === 'reset' && (
            <label className="field">
              <span className="label">Code from the email</span>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </label>
          )}
          {mode !== 'forgot' && (
            <label className="field">
              <span className="label">{mode === 'reset' ? 'New password' : 'Password'}</span>
              <input
                className="input"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {mode !== 'signin' && <span className="hint">At least 8 characters.</span>}
            </label>
          )}

          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}

          <button className={`btn btn--primary btn--lg btn--block${busy ? ' is-loading' : ''}`} disabled={busy}>
            {button}
          </button>

          {mode === 'signin' && (
            <>
              <button type="button" className="link-btn" style={{ alignSelf: 'center' }} onClick={() => switchTo('forgot')}>
                Forgot your password?
              </button>
              <p className="auth-alt">
                New to Tailor?{' '}
                <button type="button" className="link-btn" onClick={() => switchTo('signup')}>
                  Create an account
                </button>
              </p>
            </>
          )}
          {mode !== 'signin' && (
            <p className="auth-alt">
              <button type="button" className="link-btn" onClick={() => switchTo('signin')}>
                Back to sign in
              </button>
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
