import './.isolate-env';
import base from './playwright.config';
const baseURL = process.env.BASE_URL;
export default {
  ...base,
  webServer: undefined,
  workers: Number(process.env.ISOLATE_WORKERS),
  use: { ...base.use, baseURL },
  projects: (base.projects ?? []).map((p) => ({ ...p, use: { ...p.use, baseURL } })),
};
