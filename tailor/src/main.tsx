import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/app.css';
import './styles/motion.css';
import App from './App';
import AppFrame from './AppFrame';

// `?frame=<slug>` is the window frame around one generated app (its own process).
const params = new URLSearchParams(location.search);
const frame = params.get('frame');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {frame ? <AppFrame slug={frame} name={params.get('name') ?? frame} initialTheme={params.get('theme') ?? 'light'} /> : <App />}
  </React.StrictMode>
);
