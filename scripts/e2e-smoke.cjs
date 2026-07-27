/* Minimal e2e smoke: generate snapshot and upload to local worker handler */
import { generateSnapshot } from '../src/main/market/snapshot.js';
import { handler } from '../worker/src/index.js';

(async () => {
  try {
    const snap = await generateSnapshot();

    const putReq = new Request('https://local/v1/snapshot/latest', {
      method: 'PUT',
      body: JSON.stringify(snap),
    });

    const putRes = await handler(putReq);
    console.log('PUT status', putRes.status);

    const getRes = await handler(new Request('https://local/v1/snapshot/latest'));
    const body = await getRes.json();
    console.log('GET snapshot id', body.body?.snapshotId ?? null);
  } catch (err) {
    console.error('E2E smoke failed', err);
    process.exit(2);
  }
})();
