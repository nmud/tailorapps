// Managed by Tailor. Do not edit: the Builder writes App.tsx and app.css.
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './tailor.css';
import './app.css';
import App from './App';

type Report = (kind: string, message: string, stack?: string) => void;

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    const report = (window as unknown as { __tailorReport?: Report }).__tailorReport;
    report?.('error', error.message, error.stack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="t-crash" role="alert">
          <h1>This app hit an error</h1>
          <pre>{this.state.error.message}</pre>
          <button className="t-btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>
);
