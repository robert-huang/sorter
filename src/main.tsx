import React from 'react';
import ReactDOM from 'react-dom/client';
import { installDbPageLifecycle } from './lib/db/dbPageLifecycle';
import { hydrateSpotifyPlaylistCaches } from './lib/spotify/spotifyPlaylist';
import { hydrateTrackIsrcStore } from './lib/spotify/spotifyTrackIsrcStore';
import { App } from './App';
import './styles.css';

installDbPageLifecycle();
void Promise.all([
  hydrateSpotifyPlaylistCaches(),
  hydrateTrackIsrcStore(),
]).catch(() => {
  // Spotify settings surfaces durable playlist-cache failures when opened.
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
