/**
 * Component: E2E fake-arr control API (scenario switch, request recorder, state dump)
 * Documentation: documentation/testing/e2e-harness.md
 */

import { readParams, sendJson, notFound } from './http-util.js';
import { torrentInfo } from './qbit.js';
import { sabSlots } from './sab.js';

export async function handleControl(state, req, res, url) {
  const p = url.pathname.replace(/^\/__control/, '') || '/';
  try {
    if (p === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, scenario: state.scenario?.name ?? null });
    if (p === '/scenarios' && req.method === 'GET') return sendJson(res, 200, state.listScenarios());
    if (p === '/books' && req.method === 'GET') return sendJson(res, 200, state.fixtureIndex.books);
    if (p === '/scenario' && req.method === 'POST') {
      const { params } = await readParams(req, url);
      const scenario = params.definition ? state.loadScenario(params.definition) : state.loadScenarioByName(params.name);
      return sendJson(res, 200, { ok: true, scenario: scenario.name, releases: [...state.releases.keys()] });
    }
    if (p === '/reset' && req.method === 'POST') {
      const name = state.scenario?.name;
      if (name && state.listScenarios().includes(name)) state.loadScenarioByName(name);
      else state.reset();
      return sendJson(res, 200, { ok: true, scenario: state.scenario?.name ?? null });
    }
    if (p === '/requests' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const service = url.searchParams.get('service');
      return sendJson(
        res,
        200,
        state.records.filter((r) => r.seq > since && (!service || r.service === service))
      );
    }
    if (p === '/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        scenario: state.scenario?.name ?? null,
        releases: [...state.releases.values()].map((r) => ({
          id: r.id,
          title: r.title,
          protocol: r.protocol,
          infoHash: r.infoHash || null,
          grabAttempts: r.grabAttempts,
        })),
        torrents: [...state.torrents.values()].map((t) => ({ releaseId: t.releaseId || null, ...torrentInfo(state, t) })),
        nzbs: sabSlots(state),
        qbitCategories: state.qbitCategories,
        sabCategories: state.sabCategories,
        plexRefreshes: state.plexRefreshes,
      });
    }
    return notFound(res);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }
}
