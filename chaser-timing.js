// WeatherTV — timing-based chaser matching — build.1790877600
//
// The name matcher guesses from names and produces false positives. This one
// watches BEHAVIOUR: every 10 minutes it notes which chaser channels are live
// on YouTube and which Spotter Network trackers are active. A real pair lines
// up chase after chase — the tracker is active whenever the channel is live,
// across several different days. A coincidence doesn't.
//
// Stored (Redis, 21 days rolling): for each channel and each tracker, the list
// of 10-minute slots it was live/active. Only IDs and slot numbers — no
// positions or other data are kept.
//
// Score for channel C and tracker S:
//   together  = slots both were on
//   coverage  = together / slots C was live   ("when C streams, is S out?")
//   lift      = coverage / (share of ALL slots S is active)
//               (a tracker that's on all the time matches everything — lift
//               corrects for that; big outbreak days lift everyone a little)
//   sessions  = separate chases they were on together (stretches with a 4+
//               hour gap between them — US evening chases cross midnight UTC,
//               so calendar days would double-count one chase)
// score = coverage × min(lift, 10) — so an always-on tracker (lift ≈ 1) can't
// tie a specific one. Strong: coverage ≥ 80%, ≥ 3 sessions, lift ≥ 3, score
// ≥ 2× the runner-up. Likely: coverage ≥ 60%, ≥ 2 sessions, lift ≥ 2.

const KEY = 'wt:chasertiming:v1';
const SLOT_MS = 10 * 60 * 1000;
const KEEP_SLOTS = 21 * 24 * 6;

module.exports = function setupChaserTiming(app, deps) {
  const { rGet, rSet, loadData, saveData, getLiveChannelIds, getActiveTrackerIds } = deps;
  let st = { ch: {}, sn: {}, slots: [] };
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    const s = await rGet(KEY);
    if (s && s.ch && s.sn) st = { slots: [], ...s };
    loaded = true;
  };
  const push = (map, id, slot) => {
    const a = map[id] || (map[id] = []);
    if (a[a.length - 1] !== slot) a.push(slot);
  };

  async function record() {
    await load();
    const slot = Math.floor(Date.now() / SLOT_MS);
    if (st.slots[st.slots.length - 1] === slot) return;
    const live = getLiveChannelIds(), active = getActiveTrackerIds();
    live.forEach(id => push(st.ch, id, slot));
    active.forEach(id => push(st.sn, id, slot));
    st.slots.push(slot);
    // Keep 21 days. Lists are in time order, so just trim old slots off the front.
    const cutoff = slot - KEEP_SLOTS;
    const trim = (arr) => { let i = 0; while (i < arr.length && arr[i] <= cutoff) i++; if (i) arr.splice(0, i); };
    trim(st.slots);
    for (const map of [st.ch, st.sn]) {
      for (const id of Object.keys(map)) { trim(map[id]); if (!map[id].length) delete map[id]; }
    }
    await rSet(KEY, st);
  }

  function matches() {
    const data = loadData();
    const mappedSN = new Set(Object.keys(data.chaserMap || {}));
    const mappedCh = new Set(Object.values(data.chaserMap || {}));
    const dismissed = new Set(data.dismissedSuggestions || []);
    const names = {};
    (data.groups || []).forEach(g => (g.channels || []).forEach(c => { names[c.id] = c.name; }));
    const known = data.knownChasers || {};
    const total = Math.max(1, st.slots.length);
    const snSets = Object.entries(st.sn).filter(([id]) => !mappedSN.has(id)).map(([id, a]) => [id, new Set(a), a.length]);
    const out = [];
    for (const [chId, chSlots] of Object.entries(st.ch)) {
      if (mappedCh.has(chId) || chSlots.length < 6) continue;          // needs 1+ hour of live time
      const ranked = [];
      for (const [snId, set, n] of snSets) {
        if (dismissed.has(snId + '::' + chId)) continue;
        let together = 0, sessions = 0, last = -Infinity;
        for (const x of chSlots) if (set.has(x)) { together++; if (x - last > 24) sessions++; last = x; }
        if (together < 3) continue;
        const coverage = together / chSlots.length;
        const lift = coverage / (n / total);
        ranked.push({ snId, together, coverage, lift, sessions, snSlots: n, score: coverage * Math.min(lift, 10) });
      }
      if (!ranked.length) continue;
      ranked.sort((a, b) => b.score - a.score || b.sessions - a.sessions);
      const best = ranked[0], second = ranked[1];
      const clear = !second || best.score >= 2 * second.score;
      const level = best.coverage >= 0.8 && best.sessions >= 3 && best.lift >= 3 && clear ? 'strong'
        : best.coverage >= 0.6 && best.sessions >= 2 && best.lift >= 2 ? 'likely' : null;
      if (!level) continue;
      out.push({
        channelId: chId, channelName: names[chId] || chId,
        spotterNetworkId: best.snId, spotterName: (known[best.snId] && known[best.snId].name) || best.snId,
        level, coveragePct: Math.round(best.coverage * 100), hoursTogether: +(best.together / 6).toFixed(1),
        sessions: best.sessions, lift: +best.lift.toFixed(1), channelLiveHours: +(chSlots.length / 6).toFixed(1),
        runnerUp: second ? { spotterNetworkId: second.snId, name: (known[second.snId] && known[second.snId].name) || second.snId, coveragePct: Math.round(second.coverage * 100) } : null,
      });
    }
    return out.sort((a, b) => (a.level === b.level ? b.coveragePct - a.coveragePct : a.level === 'strong' ? -1 : 1));
  }

  app.get('/api/admin/chasers/timing-matches', async (req, res) => {
    await load();
    res.json({
      matches: matches(),
      observedHours: +(st.slots.length / 6).toFixed(1),
      observedDays: new Set(st.slots.map(x => Math.floor(x / 144))).size,
      channelsSeenLive: Object.keys(st.ch).length, trackersSeen: Object.keys(st.sn).length,
    });
  });

  setTimeout(() => record().catch(e => console.warn('[ChaserTiming]', e.message)), 90 * 1000).unref?.();
  setInterval(() => record().catch(e => console.warn('[ChaserTiming]', e.message)), SLOT_MS).unref?.();
  void saveData;
  return { record, matches, _state: () => st };
};
