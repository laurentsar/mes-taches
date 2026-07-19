/*
 * ha.js — publication des tâches vers Home Assistant, et sauvegarde.
 *
 * L'app reste autonome : HA est un miroir pour le dashboard, pas la source.
 * Deux usages distincts :
 *   - des capteurs lisibles (sensor.taches_*) pour afficher les tâches du
 *     jour sur un dashboard ;
 *   - une sauvegarde complète, parce que désinstaller l'APK efface le
 *     stockage du téléphone et que HA, lui, est sauvegardé vers le NAS.
 */
(function (global) {
  'use strict';

  var CFG = 'taches.ha';
  var PREFIX = 'sensor.taches_';
  var BACKUP_ENT = 'sensor.taches_sauvegarde';

  function cfg() {
    try { return JSON.parse(localStorage.getItem(CFG) || '{}'); } catch (e) { return {}; }
  }

  function saveCfg(url, token) {
    localStorage.setItem(CFG, JSON.stringify({
      url: (url || '').trim().replace(/\/+$/, ''), token: (token || '').trim(),
    }));
  }

  function enabled() {
    var c = cfg();
    return !!(c.url && c.token);
  }

  function req(path, opt) {
    var c = cfg();
    if (!c.url || !c.token) return Promise.reject(new Error('Home Assistant non configuré'));
    opt = opt || {};
    return fetch(c.url + path, {
      method: opt.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + c.token,
        'Content-Type': 'application/json',
      },
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.status === 204 ? null : r.json();
    });
  }

  function ping() {
    return req('/api/').then(function (j) { return j && j.message; });
  }

  function getState(id) {
    if (!id) return Promise.resolve(null);
    return req('/api/states/' + encodeURIComponent(id)).catch(function () { return null; });
  }

  function setState(id, state, attributes) {
    return req('/api/states/' + encodeURIComponent(id), {
      method: 'POST',
      body: { state: String(state), attributes: attributes || {} },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Capteurs                                                           */
  /* ------------------------------------------------------------------ */

  function publish(tasks) {
    if (!enabled()) return Promise.reject(new Error('Home Assistant non configuré'));
    var M = global.Model;
    var jour = M.forToday(tasks);
    var retard = M.late(tasks);
    var actives = tasks.filter(function (t) { return !(t.done && !M.isRecurring(t)); });

    /* L'état d'une entité est limité à 255 caractères : les listes vont donc
       en attributs, l'état ne porte qu'un nombre. */
    function ligne(t) {
      var s = M.status(t);
      return M.category(t.category).icon + ' ' + t.title +
             (s.id === 'late' ? ' (' + s.label.toLowerCase() + ')' : '');
    }

    var jobs = [
      setState(PREFIX + 'aujourdhui', jour.length, {
        friendly_name: 'Tâches aujourd\'hui', icon: 'mdi:clipboard-check-outline',
        unit_of_measurement: 'tâches',
        resume: M.summary(tasks),
        liste: jour.map(ligne),
        prioritaire: jour.length ? jour[0].title : 'Rien à faire',
      }),
      setState(PREFIX + 'en_retard', retard.length, {
        friendly_name: 'Tâches en retard', icon: 'mdi:alert-circle-outline',
        unit_of_measurement: 'tâches',
        liste: retard.map(ligne),
      }),
      setState(PREFIX + 'actives', actives.length, {
        friendly_name: 'Tâches actives', icon: 'mdi:format-list-checks',
        unit_of_measurement: 'tâches',
        projets: actives.filter(M.isProject).map(function (t) {
          return t.title + ' — ' + M.progress(t) + ' %';
        }),
        recurrentes: actives.filter(M.isRecurring).length,
      }),
    ];

    var errors = [];
    return Promise.all(jobs.map(function (p) {
      return p.then(function () { return true; }, function (e) { errors.push(e.message); return false; });
    })).then(function (res) {
      var sent = res.filter(Boolean).length;
      return { ok: sent > 0, sent: sent, errors: errors };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Sauvegarde                                                         */
  /* ------------------------------------------------------------------ */

  function backup(state) {
    if (!enabled()) return Promise.reject(new Error('Home Assistant non configuré'));
    var data = JSON.stringify(state);
    return setState(BACKUP_ENT, new Date().toISOString().slice(0, 19).replace('T', ' '), {
      friendly_name: 'Tâches sauvegarde', icon: 'mdi:cloud-upload-outline',
      taille_ko: Math.round(data.length / 102.4) / 10,
      taches: (state.tasks || []).length,
      data: data,
    }).then(function () { return { size: data.length }; });
  }

  function restore() {
    if (!enabled()) return Promise.reject(new Error('Home Assistant non configuré'));
    return getState(BACKUP_ENT).then(function (st) {
      var raw = st && st.attributes && st.attributes.data;
      if (!raw) throw new Error('Aucune sauvegarde trouvée');
      return { state: JSON.parse(raw), date: st.state };
    });
  }

  global.HA = {
    cfg: cfg, saveCfg: saveCfg, enabled: enabled, ping: ping,
    getState: getState, setState: setState,
    publish: publish, backup: backup, restore: restore,
    PREFIX: PREFIX, BACKUP_ENT: BACKUP_ENT,
  };
})(window);
