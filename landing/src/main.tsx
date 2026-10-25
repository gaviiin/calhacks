import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './scene.css';

const root = createRoot(document.getElementById('root')!);
const params = new URLSearchParams(window.location.search);
const ortho = params.get('ortho');

const part = params.get('part');

if (import.meta.env.DEV && part) {
  import('./dev/PartViewer').then(({ default: PartViewer }) => root.render(<PartViewer url={part} />));
} else if (import.meta.env.DEV && (ortho === 'side' || ortho === 'top')) {
  // Reference renders for livery sheets; see tools/ortho-sheets.mjs.
  import('./dev/OrthoSheet').then(({ default: OrthoSheet }) => root.render(<OrthoSheet view={ortho} px={Number(params.get('px')) || 2048} />));
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
