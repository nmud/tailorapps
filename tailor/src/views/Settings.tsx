import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { save, signOut, useStore } from '../lib/store';
import type { LearningCfg, Settings as SettingsT } from '../lib/types';
import { Switch } from '../components/ui';
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from '@tauri-apps/plugin-autostart';
import { THEMES } from '../lib/theme';

function ListField({ label, hint, value, onSave }: { label: string; hint: string; value: string[]; onSave: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value]);
  return (
    <label className="field">
      <span className="label">{label}</span>
      <textarea
        className="textarea"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onSave(text.split(/[\n,]/).map((x) => x.trim().toLowerCase()).filter(Boolean))}
      />
      <span className="hint">{hint}</span>
    </label>
  );
}

function Row({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        {help && <span>{help}</span>}
      </div>
      {children}
    </div>
  );
}

export default function Settings() {
  const user = useStore((s) => s.user);
  const settings = useStore((s) => s.settings);
  const learning = useStore((s) => s.learning);
  const [signingOut, setSigningOut] = useState(false);
  const [autostart, setAutostart] = useState(false);
  useEffect(() => {
    autostartEnabled().then(setAutostart).catch(() => {});
  }, []);
  async function toggleAutostart(on: boolean) {
    setAutostart(on);
    await (on ? enableAutostart() : disableAutostart()).catch(() => setAutostart(!on));
  }
  const setLearning = (patch: Partial<LearningCfg>) => save.learning({ ...learning, ...patch });
  const setSettings = (patch: Partial<SettingsT>) => save.settings({ ...settings, ...patch });

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>
      <div className="settings">
        <section className="card setting-group" aria-labelledby="look">
          <h2 id="look">Appearance</h2>
          <div className="themes" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={settings.theme === t.id}
                className="theme-card"
                onClick={() => setSettings({ theme: t.id })}
              >
                <div className={`theme-swatch swatch-${t.id}`}>
                  <i />
                  <i />
                  <b />
                </div>
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="card setting-group" aria-labelledby="account">
          <h2 id="account">Account</h2>
          <Row title={user?.name ?? ''} help={user?.email}>
            <button
              className={`btn${signingOut ? ' is-loading' : ''}`}
              onClick={async () => {
                setSigningOut(true);
                await signOut();
              }}
            >
              Sign out
            </button>
          </Row>
        </section>

        <section className="card setting-group" aria-labelledby="learning">
          <h2 id="learning">Learning</h2>
          <Row title="Learning" help="Let Tailor notice how you work.">
            <Switch label="Learning" checked={learning.enabled} onChange={(enabled) => setLearning({ enabled })} />
          </Row>
          <Row title="Websites you visit" help="Needs the Tailor add-on in Chrome or Edge.">
            <Switch label="Websites you visit" checked={learning.extension} disabled={!learning.enabled} onChange={(extension) => setLearning({ extension })} />
          </Row>
          <Row title="Apps on this computer">
            <Switch label="Apps on this computer" checked={learning.desktop} disabled={!learning.enabled} onChange={(desktop) => setLearning({ desktop })} />
          </Row>
          <Row title="Keep activity for">
            <select className="select" value={learning.retentionDays} onChange={(e) => setLearning({ retentionDays: Number(e.target.value) })}>
              {[7, 14, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </Row>
          <details className="more" style={{ padding: 'var(--space-md) 0' }}>
            <summary>
              <ChevronRight /> More privacy options
            </summary>
            <div>
              <div className="grid-2">
                <ListField
                  label="Never watch these apps"
                  hint="One per line, for example: spotify"
                  value={learning.denyApps}
                  onSave={(denyApps) => setLearning({ denyApps })}
                />
                <ListField
                  label="Never watch these websites"
                  hint="One per line, for example: reddit.com"
                  value={learning.denyDomains}
                  onSave={(denyDomains) => setLearning({ denyDomains })}
                />
              </div>
              <Row title="Remember what I search for" help="Off: Tailor only notes that you searched.">
                <Switch label="Remember what I search for" checked={learning.includeSearchTerms} onChange={(includeSearchTerms) => setLearning({ includeSearchTerms })} />
              </Row>
              <Row title="Remember full web addresses" help="Off: Tailor only notes the website's name.">
                <Switch label="Remember full web addresses" checked={learning.includePaths} onChange={(includePaths) => setLearning({ includePaths })} />
              </Row>
            </div>
          </details>
        </section>

        <section className="card setting-group" aria-labelledby="startup">
          <h2 id="startup">Tailor and your computer</h2>
          <Row title="Open Tailor when your computer starts" help="It waits quietly in the system tray. Closing the window keeps it running there.">
            <Switch label="Open Tailor when your computer starts" checked={autostart} onChange={toggleAutostart} />
          </Row>
          <Row title="Add my apps to the Start menu" help="So you can search for them and pin them to the taskbar.">
            <Switch label="Add my apps to the Start menu" checked={settings.startMenu} onChange={(startMenu) => setSettings({ startMenu })} />
          </Row>
        </section>

        <section className="card setting-group" aria-labelledby="ideas">
          <h2 id="ideas">Ideas</h2>
          <Row title="Suggest ideas on its own" help="When Tailor notices something new.">
            <Switch label="Suggest ideas on its own" checked={settings.autoSuggest} onChange={(autoSuggest) => setSettings({ autoSuggest })} />
          </Row>
          <Row title="Look for patterns in the background" help="About every half hour while learning is on.">
            <Switch label="Look for patterns in the background" checked={settings.autoAnalyze} onChange={(autoAnalyze) => setSettings({ autoAnalyze })} />
          </Row>
        </section>
      </div>
    </div>
  );
}
