import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { AnimeToAnimeApp } from './AnimeToAnimeApp';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root');
}

createRoot(root).render(
  <StrictMode>
    <AnimeToAnimeApp />
  </StrictMode>,
);
