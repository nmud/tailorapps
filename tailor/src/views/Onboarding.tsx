import { useState } from 'react';
import { Globe, Lock, Monitor } from 'lucide-react';
import { finishOnboarding, save, useStore } from '../lib/store';
import { BrowserSetup, useBrowserConnected } from '../components/BrowserSetup';
import { Dialog, Switch } from '../components/ui';
import { enable as enableAutostart } from '@tauri-apps/plugin-autostart';

export default function Onboarding() {
  const user = useStore((s) => s.user);
  const learning = useStore((s) => s.learning);
  const [websites, setWebsites] = useState(true);
  const [apps, setApps] = useState(true);
  const [step, setStep] = useState<'choose' | 'browser'>('choose');
  const [confirmNone, setConfirmNone] = useState(false);
  const [startup, setStartup] = useState(true);
  const connected = useBrowserConnected();

  async function finish(web: boolean, desk: boolean) {
    await save.learning({ ...learning, enabled: web || desk, extension: web, desktop: desk });
    if (startup) await enableAutostart().catch(() => {});
    await finishOnboarding();
  }

  function next() {
    if (!websites && !apps) return setConfirmNone(true);
    if (websites) return setStep('browser');
    finish(false, apps);
  }

  const firstName = user?.name.split(' ')[0] ?? '';

  if (step === 'browser') {
    return (
      <div className="onboard">
        <div className="onboard-inner">
          <h1>Add Tailor to your browser</h1>
          <p>This lets Tailor see which websites you use. It takes about a minute.</p>
          <BrowserSetup />
          <div className="row row--end">
            {!connected && (
              <button className="btn btn--ghost" onClick={() => finish(true, apps)}>
                I'll do this later
              </button>
            )}
            <button className="btn btn--primary btn--lg" disabled={!connected} onClick={() => finish(true, apps)}>
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="onboard">
      <div className="onboard-inner">
        <h1>Hi {firstName}. Let Tailor learn how you work.</h1>
        <p>Tailor looks for things you do over and over, then suggests small apps to make them easier.</p>

        <div className={`card choice shine${websites ? ' is-on' : ''}`} onClick={() => setWebsites((v) => !v)}>
          <Globe />
          <div>
            <strong>Websites you visit</strong>
            <span>Which sites you use, and for how long.</span>
          </div>
          <Switch label="Websites you visit" checked={websites} onChange={setWebsites} />
        </div>
        <div className={`card choice shine${apps ? ' is-on' : ''}`} onClick={() => setApps((v) => !v)}>
          <Monitor />
          <div>
            <strong>Apps on this computer</strong>
            <span>Which apps you use, and for how long.</span>
          </div>
          <Switch label="Apps on this computer" checked={apps} onChange={setApps} />
        </div>

        <p className="promise">
          <Lock />
          Tailor never reads what you type, copy or write in messages, and it skips password and banking sites. You can change this anytime.
        </p>

        <label className="row" style={{ cursor: 'pointer' }}>
          <Switch label="Open Tailor when your computer starts" checked={startup} onChange={setStartup} />
          <span>Open Tailor when your computer starts, so it can keep learning. It waits quietly in the system tray.</span>
        </label>

        <div className="row row--end">
          <button className="btn btn--primary btn--lg" onClick={next}>
            Continue
          </button>
        </div>
      </div>

      {confirmNone && (
        <Dialog
          title="Continue without learning?"
          onClose={() => setConfirmNone(false)}
          actions={
            <>
              <button className="btn btn--ghost" onClick={() => finish(false, false)}>
                Continue anyway
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  setWebsites(true);
                  setApps(true);
                  setConfirmNone(false);
                }}
              >
                Turn learning on
              </button>
            </>
          }
        >
          <p>Tailor won't be able to suggest apps on its own. You'll need to ask for each app yourself.</p>
        </Dialog>
      )}
    </div>
  );
}
