import React from 'react';
import ReactDOM from 'react-dom/client';
import { installDbPageLifecycle } from './lib/db/dbPageLifecycle';
import { App } from './App';
import './styles.css';

installDbPageLifecycle();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
