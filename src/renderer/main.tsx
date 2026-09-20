import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './theme.css';

// No <StrictMode>: it double-mounts effects in dev, which would attach every terminal twice (spec G26).
createRoot(document.getElementById('root')!).render(<App />);
