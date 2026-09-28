import path from 'node:path';
import express from 'express';
import { checkDatabase, createPool } from './db.js';
import { logRequests } from './middleware/logger.js';
import { loadMaintenance } from './middleware/maintenance.js';
import { loadSession } from './middleware/session.js';
import { showSignIn, signIn, signOut } from './routes/auth.js';
import { health } from './routes/health.js';
import { showDashboard } from './routes/home.js';
import { createItem, listItems, listItemsApi } from './routes/items.js';
import { setMaintenance, showSettings } from './routes/settings.js';

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

createPool(databaseUrl);
await checkDatabase();

const app = express();
app.use(logRequests);
app.use(express.static(path.join(import.meta.dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(loadMaintenance);
app.use(loadSession);

app.get('/health', health);
app.get('/signin', showSignIn);
app.post('/signin', signIn);
app.post('/signout', signOut);
app.get('/', showDashboard);
app.get('/settings', showSettings);
app.post('/settings/maintenance', setMaintenance);
app.get('/items', listItems);
app.post('/items', createItem);
app.get('/api/items', listItemsApi);

app.listen(port, (error) => {
  if (error) throw error;
  console.log(`fixture-app listening on http://localhost:${port}`);
});
