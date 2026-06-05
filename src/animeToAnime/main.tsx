import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerDefaultCloudProvider } from '../lib/cloud';
import { GoogleDriveProvider } from '../lib/cloud/googleDrive';
import { installDbPageLifecycle } from '../lib/db/dbPageLifecycle';
import '../styles.css';
import { AnimeToAnimeApp } from './AnimeToAnimeApp';
import { applyAnimeToAnimeTheme, loadAnimeToAnimeTheme } from './theme';

registerDefaultCloudProvider(() => new GoogleDriveProvider());

installDbPageLifecycle();

applyAnimeToAnimeTheme(loadAnimeToAnimeTheme());

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root');
}

createRoot(root).render(
  <StrictMode>
    <AnimeToAnimeApp />
  </StrictMode>,
);
