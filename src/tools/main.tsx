import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerDefaultCloudProvider } from '../lib/cloud';
import { GoogleDriveProvider } from '../lib/cloud/googleDrive';
import { installDbPageLifecycle } from '../lib/db/dbPageLifecycle';
import '../styles.css';
import { ToolsApp } from './ToolsApp';
import { applyAnimeToAnimeTheme, loadAnimeToAnimeTheme } from '../animeToAnime/theme';

registerDefaultCloudProvider(() => new GoogleDriveProvider());

// Detail modals read/write the SQLite production cache, so the page DB
// lifecycle must be installed exactly like the A2A entry point.
installDbPageLifecycle();

applyAnimeToAnimeTheme(loadAnimeToAnimeTheme());

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root');
}

createRoot(root).render(
  <StrictMode>
    <ToolsApp />
  </StrictMode>,
);
