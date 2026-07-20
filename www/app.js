/*
 * app.js — Mes Tâches.
 * État local (localStorage), interface, rappels, publication vers HA.
 */
(function () {
  'use strict';

  var APP_VERSION = '1.1.0';
  window.APP_VERSION = APP_VERSION;

  var KEY = 'taches.state';
  var DEFAULTS = {
    settings: {
      notif: false, notifHour: '08:00', notifLate: true,
      haAuto: true, backup: true,
      timerDefaults: { charge: 5, piscine: 40 },
    },
    tasks: [], lastBackup: null, lastNotifDay: null,
    timers: { charge: null, piscine: null },
  };

  var S = load();
  var M = window.Model;

  function load() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    var s = raw || {};
    var out = JSON.parse(JSON.stringify(DEFAULTS));
    Object.keys(out).forEach(function (k) {
      if (s[k] == null) return;
      if (k === 'settings') Object.keys(s.settings || {}).forEach(function (n) {
        if (n === 'timerDefaults') Object.keys(s.settings.timerDefaults || {}).forEach(function (t) {
          out.settings.timerDefaults[t] = s.settings.timerDefaults[t];
        });
        else out.settings[n] = s.settings[n];
      });
      else out[k] = s[k];
    });
    /* Migration depuis la version à minuterie unique (recharge voiture). */
    if (s.settings && s.settings.chargeHours != null) out.settings.timerDefaults.charge = s.settings.chargeHours;
    if (s.charge) out.timers.charge = s.charge;
    return out;
  }

  var backupTimer = null;

  function save() {
    localStorage.setItem(KEY, JSON.stringify(S));
    scheduleBackup();
    if (S.settings.haAuto && HA.enabled()) schedulePublish();
  }

  function scheduleBackup() {
    if (!S.settings.backup || !HA.enabled()) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(function () {
      HA.backup(S).then(function () {
        S.lastBackup = new Date().toISOString();
        localStorage.setItem(KEY, JSON.stringify(S));
      }, function () {});
    }, 4000);
  }

  var pubTimer = null;
  function schedulePublish() {
    clearTimeout(pubTimer);
    pubTimer = setTimeout(function () {
      HA.publish(S.tasks).then(function () { setHaDot('ok'); }, function () { setHaDot('err'); });
    }, 3000);
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* --- Petits utilitaires DOM ---------------------------------------- */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) +
      (String(iso).length > 10 ? ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
  }

  /* Fenêtre modale générique : build(body) remplit, collect() renvoie la
     valeur (ou undefined pour refuser la fermeture). */
  function modal(title, build, collect) {
    return new Promise(function (resolve) {
      var box = $('modal');
      $('modalTitle').textContent = title;
      var body = $('modalBody');
      body.innerHTML = '';
      build(body);
      box.classList.remove('hidden');

      function close(v) {
        box.classList.add('hidden');
        $('modalOk').onclick = null;
        $('modalCancel').onclick = null;
        resolve(v);
      }
      $('modalOk').onclick = function () {
        var v = collect();
        if (v === undefined) return;
        close(v);
      };
      $('modalCancel').onclick = function () { close(null); };
    });
  }

  /* ================================================================== */
  /* Rendu : aujourd'hui                                                */
  /* ================================================================== */

  function renderToday() {
    renderTimers();
    var jour = M.forToday(S.tasks);
    var retard = M.late(S.tasks);

    var head = $('todayHead');
    head.innerHTML = '';
    var card = el('div', 'card head-card' + (retard.length ? ' late' : (jour.length ? '' : ' ok')));
    card.innerHTML = '<div class="big">' + esc(M.summary(S.tasks)) + '</div>' +
      '<div class="muted small">' + new Date().toLocaleDateString('fr-FR',
        { weekday: 'long', day: 'numeric', month: 'long' }) + '</div>';
    head.appendChild(card);

    var host = $('todayList');
    host.innerHTML = '';
    if (!jour.length) {
      host.appendChild(el('div', 'card ok-card',
        '✅ <strong>Rien à faire aujourd\'hui.</strong><br>' +
        '<span class="muted small">Les tâches sans date restent dans l\'onglet Toutes.</span>'));
    } else {
      jour.forEach(function (t) { host.appendChild(taskCard(t)); });
    }

    /* Les jours suivants, pour ne pas être surpris demain matin. */
    var soon = S.tasks.filter(function (t) {
      if (t.done && !M.isRecurring(t)) return false;
      var s = M.status(t);
      return s.id === 'soon';
    }).sort(M.compare);
    var sb = $('soonBlock');
    sb.innerHTML = '';
    if (soon.length) {
      sb.appendChild(el('h2', null, 'Les jours qui viennent'));
      soon.forEach(function (t) { sb.appendChild(taskCard(t, true)); });
    }
  }

  /* Carte d'une tâche. `compact` allège l'affichage pour les listes
     secondaires, où le détail n'apporte rien. */
  function taskCard(t, compact) {
    var st = M.status(t);
    var cat = M.category(t.category);
    var prio = M.PRIORITIES.filter(function (p) { return p.id === t.priority; })[0] || M.PRIORITIES[1];
    var card = el('div', 'card task ' + prio.cls + ' st-' + st.id + (t.done && !M.isRecurring(t) ? ' is-done' : ''));

    var row = el('div', 'task-row');

    var box = el('button', 'check' + (t.done && !M.isRecurring(t) ? ' checked' : ''),
      t.done && !M.isRecurring(t) ? '✓' : '');
    box.title = 'Cocher';
    box.onclick = function () { toggleTask(t); };
    row.appendChild(box);

    var mid = el('div', 'task-mid');
    mid.appendChild(el('div', 'task-title', esc(cat.icon) + ' ' + esc(t.title)));

    var meta = [];
    if (st.id !== 'done') meta.push('<span class="st ' + st.id + '">' + esc(st.label) + '</span>');
    if (M.isRecurring(t)) {
      var u = M.UNITS.filter(function (x) { return x.id === t.repeat.unit; })[0];
      meta.push('🔁 tous les ' + t.repeat.every + ' ' + esc(u ? u.label : ''));
    }
    if (M.isProject(t)) meta.push('🧱 ' + M.progress(t) + ' %');
    if (t.note && !compact) meta.push(esc(t.note));
    if (meta.length) mid.appendChild(el('div', 'task-meta muted small', meta.join(' · ')));

    if (M.isProject(t) && !compact) {
      var bar = el('div', 'bar');
      var fill = el('span');
      fill.style.width = M.progress(t) + '%';
      bar.appendChild(fill);
      mid.appendChild(bar);

      var steps = el('ul', 'steps');
      t.steps.forEach(function (sp) {
        var li = el('li', sp.done ? 'done' : '');
        var b = el('button', 'step-check' + (sp.done ? ' checked' : ''), sp.done ? '✓' : '');
        b.onclick = function () {
          sp.done = !sp.done;
          /* Toutes les étapes faites : la tâche l'est aussi, sauf si elle
             est récurrente — auquel cas cocher la tâche la relance. */
          if (!M.isRecurring(t)) t.done = t.steps.every(function (x) { return x.done; });
          save(); renderAll();
        };
        li.appendChild(b);
        li.appendChild(el('span', null, esc(sp.title)));
        steps.appendChild(li);
      });
      mid.appendChild(steps);
    }
    row.appendChild(mid);

    var ed = el('button', 'ghost small-btn', '✏️');
    ed.onclick = function () { editTask(t); };
    row.appendChild(ed);

    card.appendChild(row);
    return card;
  }

  function toggleTask(t) {
    if (t.done && !M.isRecurring(t)) {
      M.uncomplete(t);
      toast('Tâche rouverte');
    } else {
      M.complete(t);
      toast(M.isRecurring(t) ? 'Fait — prochaine le ' + fmtDate(t.due) : 'Tâche terminée');
    }
    save();
    renderAll();
  }

  /* ================================================================== */
  /* Rendu : toutes / projets                                           */
  /* ================================================================== */

  function renderAllTab() {
    var q = ($('search').value || '').toLowerCase().trim();
    var cat = $('filterCat').value;
    var mode = $('filterState').value;

    var list = S.tasks.filter(function (t) {
      var closed = t.done && !M.isRecurring(t);
      if (mode === 'active' && closed) return false;
      if (mode === 'done' && !closed) return false;
      if (mode === 'late' && M.status(t).id !== 'late') return false;
      if (mode === 'recur' && !M.isRecurring(t)) return false;
      if (cat && t.category !== cat) return false;
      if (q && (t.title + ' ' + (t.note || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(M.compare);

    var host = $('allList');
    host.innerHTML = '';
    if (!list.length) {
      host.appendChild(el('div', 'card muted', 'Aucune tâche ne correspond.'));
      return;
    }
    list.forEach(function (t) { host.appendChild(taskCard(t)); });
  }

  function renderProjects() {
    var host = $('projList');
    host.innerHTML = '';
    var projs = S.tasks.filter(M.isProject).sort(M.compare);
    if (!projs.length) {
      host.appendChild(el('div', 'card muted',
        'Aucun projet. Ouvre une tâche et ajoute-lui des étapes pour la transformer en projet.'));
      return;
    }
    projs.forEach(function (t) { host.appendChild(taskCard(t)); });
  }

  function renderAll() {
    renderToday();
    renderAllTab();
    renderProjects();
  }

  /* ================================================================== */
  /* Formulaire de tâche                                                */
  /* ================================================================== */

  function editTask(existing) {
    var t = existing || M.blank();
    var refs = {};
    var steps = (t.steps || []).map(function (s) { return { id: s.id, title: s.title, done: s.done }; });

    return modal(existing ? 'Modifier la tâche' : 'Nouvelle tâche', function (body) {
      var f1 = el('label', 'fld', '<span>Intitulé</span>');
      refs.title = el('input'); refs.title.type = 'text'; refs.title.value = t.title;
      refs.title.placeholder = 'ex. Changer le filtre de la VMC';
      f1.appendChild(refs.title); body.appendChild(f1);

      var g = el('div', 'grid2');
      var f2 = el('label', 'fld', '<span>Catégorie</span>');
      refs.cat = el('select');
      M.CATEGORIES.forEach(function (c) {
        var o = el('option', null, esc(c.icon + ' ' + c.label));
        o.value = c.id;
        if (c.id === t.category) o.selected = true;
        refs.cat.appendChild(o);
      });
      f2.appendChild(refs.cat); g.appendChild(f2);

      var f3 = el('label', 'fld', '<span>Priorité</span>');
      refs.prio = el('select');
      M.PRIORITIES.forEach(function (p) {
        var o = el('option', null, esc(p.label));
        o.value = p.id;
        if (p.id === t.priority) o.selected = true;
        refs.prio.appendChild(o);
      });
      f3.appendChild(refs.prio); g.appendChild(f3);
      body.appendChild(g);

      var f4 = el('label', 'fld', '<span>Échéance</span>');
      var dr = el('span', 'fld-row');
      refs.due = el('input'); refs.due.type = 'date'; refs.due.value = t.due || '';
      dr.appendChild(refs.due);
      [['Aujourd\'hui', 0], ['Demain', 1], ['+1 sem.', 7]].forEach(function (b) {
        var btn = el('button', 'ghost small-btn', b[0]);
        btn.type = 'button';
        btn.onclick = function () {
          var d = M.today();
          d.setDate(d.getDate() + b[1]);
          refs.due.value = M.fmtIso(d);
        };
        dr.appendChild(btn);
      });
      f4.appendChild(dr); body.appendChild(f4);

      /* Répétition : facultative, et sans échéance elle n'a pas de sens —
         on prévient plutôt que de la faire échouer silencieusement. */
      var fr = el('label', 'chk', '');
      refs.rep = el('input'); refs.rep.type = 'checkbox';
      refs.rep.checked = M.isRecurring(t);
      fr.appendChild(refs.rep);
      fr.appendChild(el('span', null, 'Tâche récurrente'));
      body.appendChild(fr);

      var repBox = el('div', 'sub-card' + (M.isRecurring(t) ? '' : ' hidden'));
      var rg = el('div', 'grid2');
      var f5 = el('label', 'fld', '<span>Tous les</span>');
      refs.every = el('input'); refs.every.type = 'number'; refs.every.min = '1';
      refs.every.inputMode = 'numeric';
      refs.every.value = M.isRecurring(t) ? t.repeat.every : 1;
      f5.appendChild(refs.every); rg.appendChild(f5);
      var f6 = el('label', 'fld', '<span>&nbsp;</span>');
      refs.unit = el('select');
      M.UNITS.forEach(function (u) {
        var o = el('option', null, esc(u.label));
        o.value = u.id;
        if (M.isRecurring(t) && u.id === t.repeat.unit) o.selected = true;
        refs.unit.appendChild(o);
      });
      f6.appendChild(refs.unit); rg.appendChild(f6);
      repBox.appendChild(rg);
      repBox.appendChild(el('p', 'muted small',
        'La prochaine échéance est calculée depuis la date prévue, pas depuis le jour où tu coches : une tâche mensuelle ne dérive pas si tu la fais avec deux jours de retard.'));
      body.appendChild(repBox);
      refs.rep.onchange = function () { repBox.classList.toggle('hidden', !this.checked); };

      /* Étapes : c'est leur présence qui fait le projet. */
      body.appendChild(el('h4', null, 'Étapes'));
      var stepHost = el('div', 'step-edit');
      body.appendChild(stepHost);

      function drawSteps() {
        stepHost.innerHTML = '';
        steps.forEach(function (s, i) {
          var r = el('div', 'fld-row');
          var inp = el('input');
          inp.type = 'text'; inp.value = s.title;
          inp.oninput = function () { s.title = this.value; };
          r.appendChild(inp);
          var rm = el('button', 'ghost small-btn danger', '✕');
          rm.type = 'button';
          rm.onclick = function () { steps.splice(i, 1); drawSteps(); };
          r.appendChild(rm);
          stepHost.appendChild(r);
        });
        var add = el('button', 'ghost small-btn', '＋ Ajouter une étape');
        add.type = 'button';
        add.onclick = function () { steps.push({ id: uid(), title: '', done: false }); drawSteps(); };
        stepHost.appendChild(add);
      }
      drawSteps();

      var f7 = el('label', 'fld', '<span>Note</span>');
      refs.note = el('input'); refs.note.type = 'text'; refs.note.value = t.note || '';
      refs.note.placeholder = 'référence, remarque…';
      f7.appendChild(refs.note); body.appendChild(f7);

      if (existing) {
        var del = el('button', 'ghost danger wide', '🗑 Supprimer cette tâche');
        del.type = 'button';
        del.onclick = function () {
          S.tasks = S.tasks.filter(function (x) { return x.id !== t.id; });
          save(); renderAll();
          $('modal').classList.add('hidden');
          toast('Tâche supprimée');
        };
        body.appendChild(del);
      }
    }, function () {
      var title = refs.title.value.trim();
      if (!title) { toast('Donne un intitulé'); return undefined; }
      if (refs.rep.checked && !refs.due.value) { toast('Une tâche récurrente a besoin d\'une échéance'); return undefined; }
      t.title = title;
      t.category = refs.cat.value;
      t.priority = parseInt(refs.prio.value, 10) || 2;
      t.due = refs.due.value || null;
      t.note = refs.note.value.trim();
      t.repeat = refs.rep.checked
        ? { every: Math.max(1, parseInt(refs.every.value, 10) || 1), unit: refs.unit.value }
        : null;
      t.steps = steps.filter(function (s) { return s.title.trim(); });
      return t;
    }).then(function (res) {
      if (!res) return null;
      if (!existing) { res.id = uid(); S.tasks.push(res); }
      save(); renderAll();
      return res;
    });
  }

  /* ================================================================== */
  /* Modèles d'entretien                                                */
  /* ================================================================== */
  /*
   * Rythmes courants d'entretien d'une maison. Ce ne sont que des points de
   * départ : l'échéance part d'aujourd'hui et tout reste modifiable.
   */
  var TEMPLATES = [
    { title: 'Nettoyer le filtre de la VMC', category: 'maison', every: 3, unit: 'm' },
    { title: 'Détartrer la cafetière', category: 'maison', every: 2, unit: 'm' },
    { title: 'Vérifier les détecteurs de fumée', category: 'maison', every: 6, unit: 'm' },
    { title: 'Ramonage', category: 'maison', every: 1, unit: 'y' },
    { title: 'Contre-lavage du filtre', category: 'piscine', every: 2, unit: 'w' },
    { title: 'Test de l\'eau', category: 'piscine', every: 3, unit: 'd' },
    { title: 'Tondre la pelouse', category: 'exterieur', every: 2, unit: 'w' },
    { title: 'Tailler la haie', category: 'exterieur', every: 6, unit: 'm' },
    { title: 'Contrôle technique / révision', category: 'vehicule', every: 1, unit: 'y' },
    { title: 'Pression des pneus', category: 'vehicule', every: 2, unit: 'm' },
    { title: 'Relevé des compteurs', category: 'admin', every: 1, unit: 'm' },
  ];

  function renderTemplates() {
    var host = $('templates');
    host.innerHTML = '';
    TEMPLATES.forEach(function (tpl) {
      var u = M.UNITS.filter(function (x) { return x.id === tpl.unit; })[0];
      var b = el('button', 'ghost tpl',
        esc(M.category(tpl.category).icon + ' ' + tpl.title) +
        '<span class="muted small"> — tous les ' + tpl.every + ' ' + esc(u.label) + '</span>');
      b.onclick = function () {
        if (S.tasks.some(function (x) { return x.title === tpl.title; })) {
          toast('Déjà dans la liste');
          return;
        }
        var d = M.addPeriod(M.today(), tpl.every, tpl.unit);
        var t = M.blank();
        t.id = uid();
        t.title = tpl.title;
        t.category = tpl.category;
        t.due = M.fmtIso(d);
        t.repeat = { every: tpl.every, unit: tpl.unit };
        S.tasks.push(t);
        save(); renderAll();
        toast('Ajouté — première échéance le ' + fmtDate(t.due));
      };
      host.appendChild(b);
    });
  }

  /* ================================================================== */
  /* Notifications                                                      */
  /* ================================================================== */

  function notifPlugin() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  }

  function askNotifPermission() {
    var p = notifPlugin();
    if (p) return p.requestPermissions().then(function (r) { return r.display === 'granted'; });
    if (!('Notification' in window)) return Promise.resolve(false);
    return Notification.requestPermission().then(function (r) { return r === 'granted'; });
  }

  /* Rappel quotidien à heure fixe. On planifie sur 14 jours : au-delà, l'app
     aura forcément été rouverte et reprogrammera. */
  function scheduleReminders() {
    var p = notifPlugin();
    if (!p || !S.settings.notif) return;
    var hm = (S.settings.notifHour || '08:00').split(':');
    p.cancel({ notifications: [{ id: 2001 }] }).catch(function () {});
    var list = [];
    for (var i = 0; i < 14; i++) {
      var d = new Date();
      d.setDate(d.getDate() + i);
      d.setHours(+hm[0], +hm[1], 0, 0);
      if (d < new Date()) continue;
      list.push({
        id: 2100 + i,
        title: 'Mes Tâches',
        body: M.summary(S.tasks),
        schedule: { at: d },
      });
    }
    if (list.length) p.schedule({ notifications: list }).catch(function () {});
  }

  function testNotif() {
    askNotifPermission().then(function (ok) {
      if (!ok) { toast('Notifications refusées par le système'); return; }
      var p = notifPlugin();
      var body = M.summary(S.tasks);
      if (p) {
        p.schedule({ notifications: [{ id: 2999, title: 'Mes Tâches', body: body,
          schedule: { at: new Date(Date.now() + 3000) } }] });
        toast('Notification dans 3 secondes');
      } else if ('Notification' in window) {
        new Notification('Mes Tâches', { body: body });
      }
    });
  }

  /* ================================================================== */
  /* Minuteries (recharge voiture, remplissage piscine…)                */
  /* ================================================================== */

  /* unit 'h' = durée en heures, 'm' = durée en minutes. adjustStep en
     minutes, utilisé pour les boutons ±. */
  var TIMERS = [
    {
      id: 'charge', icon: '🔌', title: 'Recharge de la voiture',
      unit: 'h', unitLabel: 'heures', min: 0.5, max: 24, step: 0.5, presets: [2, 5, 8],
      adjustStep: 30, notifId: 3001, channelId: 'recharge',
      notifTitle: '🔌 Recharge terminée', notifBody: 'La voiture a fini de charger.',
    },
    {
      id: 'piscine', icon: '🏊', title: 'Remplissage de la piscine',
      unit: 'm', unitLabel: 'minutes', min: 5, max: 300, step: 5, presets: [20, 40, 60],
      adjustStep: 10, notifId: 3002, channelId: 'remplissage',
      notifTitle: '🏊 Remplissage terminé', notifBody: 'Le remplissage de la piscine est terminé.',
    },
  ];
  var timerWebTimers = {};

  function unitMs(def) { return def.unit === 'h' ? 3600000 : 60000; }

  /* Canaux Android dédiés, avec vibration : sans ça la notification par
     défaut peut rester silencieuse selon les réglages du téléphone. */
  function ensureTimerChannels() {
    var p = notifPlugin();
    if (!p || !p.createChannel) return;
    TIMERS.forEach(function (def) {
      p.createChannel({
        id: def.channelId,
        name: def.title,
        description: 'Alerte de fin — ' + def.title,
        importance: 5,
        visibility: 1,
        vibration: true,
      }).catch(function () {});
    });
  }

  function scheduleTimerAlarm(def, end) {
    var p = notifPlugin();
    if (p) {
      p.cancel({ notifications: [{ id: def.notifId }] }).catch(function () {});
      p.schedule({
        notifications: [{
          id: def.notifId,
          title: def.notifTitle,
          body: def.notifBody,
          channelId: def.channelId,
          schedule: { at: end },
        }],
      }).catch(function () {});
    } else if ('Notification' in window) {
      clearTimeout(timerWebTimers[def.id]);
      timerWebTimers[def.id] = setTimeout(function () {
        new Notification(def.notifTitle, { body: def.notifBody });
        if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
      }, Math.max(0, end.getTime() - Date.now()));
    }
  }

  function cancelTimerAlarm(def) {
    var p = notifPlugin();
    if (p) p.cancel({ notifications: [{ id: def.notifId }] }).catch(function () {});
    clearTimeout(timerWebTimers[def.id]);
  }

  function startTimer(def, amount) {
    amount = Math.min(def.max, Math.max(def.min, amount));
    askNotifPermission().then(function (ok) {
      if (!ok) { toast('Notifications refusées par le système'); return; }
      S.settings.timerDefaults[def.id] = amount;
      var end = new Date(Date.now() + amount * unitMs(def));
      S.timers[def.id] = { end: end.toISOString() };
      save();
      scheduleTimerAlarm(def, end);
      renderTimers();
      toast('Minuterie lancée — fin à ' + end.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
    });
  }

  function cancelTimer(def) {
    S.timers[def.id] = null;
    save();
    cancelTimerAlarm(def);
    renderTimers();
    toast('Minuterie annulée');
  }

  /* Ajuste le temps restant d'une minuterie en cours, sans repartir de zéro. */
  function adjustTimer(def, minutes) {
    var t = S.timers[def.id];
    if (!t || !t.end) return;
    var end = new Date(new Date(t.end).getTime() + minutes * 60000);
    var floor = new Date(Date.now() + 60000);
    if (end < floor) end = floor;
    t.end = end.toISOString();
    save();
    scheduleTimerAlarm(def, end);
    renderTimers();
  }

  function fmtRemain(ms) {
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? (h + ' h ' + (m < 10 ? '0' : '') + m) : (m + ' min');
  }

  function renderTimer(def) {
    var host = $('timer-' + def.id);
    if (!host) return;
    var t = S.timers[def.id];

    if (t && t.end) {
      var end = new Date(t.end);
      var rem = end.getTime() - Date.now();
      if (rem <= 0) {
        S.timers[def.id] = null;
        save();
      } else {
        host.innerHTML =
          '<div class="fill-head"><div class="timer-head">' +
          '<span class="timer-badge timer-badge-' + esc(def.id) + '">' + esc(def.icon) + '</span>' +
          '<h3>' + esc(def.title) + ' — en cours</h3></div>' +
          '<span class="fill-time">' + fmtRemain(rem) + '</span></div>' +
          '<p class="muted small">Fin prévue à ' +
          esc(end.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })) + '</p>';

        var adjRow = el('div', 'row-btns');
        [['−' + def.adjustStep + ' min', -def.adjustStep], ['+' + def.adjustStep + ' min', def.adjustStep]]
          .forEach(function (b) {
            var btn = el('button', 'ghost small-btn', b[0]);
            btn.type = 'button';
            btn.onclick = function () { adjustTimer(def, b[1]); };
            adjRow.appendChild(btn);
          });
        host.appendChild(adjRow);

        var cancelBtn = el('button', 'ghost danger wide', '✕ Annuler la minuterie');
        cancelBtn.onclick = function () { cancelTimer(def); };
        host.appendChild(cancelBtn);
        return;
      }
    }

    host.innerHTML = '<div class="timer-head">' +
      '<span class="timer-badge timer-badge-' + esc(def.id) + '">' + esc(def.icon) + '</span>' +
      '<h3>' + esc(def.title) + '</h3></div>' +
      '<p class="muted small">Choisis la durée : vibration et notification à la fin.</p>';

    var durRow = el('span', 'fld-row');
    var durInput = el('input');
    durInput.type = 'number';
    durInput.min = String(def.min);
    durInput.max = String(def.max);
    durInput.step = String(def.step);
    durInput.inputMode = 'decimal';
    durInput.value = S.settings.timerDefaults[def.id];
    durRow.appendChild(durInput);
    durRow.appendChild(el('span', 'muted small', def.unitLabel));
    var durFld = el('label', 'fld', '');
    durFld.appendChild(durRow);
    host.appendChild(durFld);

    var presets = el('div', 'row-btns');
    def.presets.forEach(function (v) {
      var b = el('button', 'ghost small-btn', v + (def.unit === 'h' ? ' h' : ' min'));
      b.type = 'button';
      b.onclick = function () { durInput.value = v; };
      presets.appendChild(b);
    });
    host.appendChild(presets);

    var startBtn = el('button', 'primary wide', '▶️ Démarrer');
    startBtn.onclick = function () {
      var amount = parseFloat(durInput.value);
      if (!amount || amount <= 0) { toast('Indique une durée valide'); return; }
      startTimer(def, amount);
    };
    host.appendChild(startBtn);
  }

  function renderTimers() {
    var host = $('timersHost');
    if (!host) return;
    if (!host.childElementCount) {
      TIMERS.forEach(function (def) {
        var card = el('div', 'card timer-card');
        card.id = 'timer-' + def.id;
        host.appendChild(card);
      });
    }
    TIMERS.forEach(renderTimer);
  }

  /* ================================================================== */
  /* Sauvegarde / export                                                */
  /* ================================================================== */

  function backupNow() {
    var msg = $('backupMsg');
    if (!HA.enabled()) { msg.textContent = 'Configure d\'abord Home Assistant ci-dessus.'; return; }
    msg.textContent = 'Sauvegarde…';
    HA.backup(S).then(function (r) {
      S.lastBackup = new Date().toISOString();
      localStorage.setItem(KEY, JSON.stringify(S));
      msg.textContent = 'Sauvegardé dans ' + HA.BACKUP_ENT + ' (' +
        Math.round(r.size / 102.4) / 10 + ' ko) le ' + fmtDate(S.lastBackup) + '.';
    }, function (e) { msg.textContent = 'Échec : ' + e.message; });
  }

  function restoreFromHa() {
    var msg = $('backupMsg');
    if (!HA.enabled()) { msg.textContent = 'Configure d\'abord Home Assistant ci-dessus.'; return; }
    msg.textContent = 'Lecture de la sauvegarde…';
    HA.restore().then(function (r) {
      var n = (r.state.tasks || []).length;
      modal('Restaurer la sauvegarde ?', function (b) {
        b.appendChild(el('p', null, 'Sauvegarde du ' + esc(r.date) + ' : ' + n + ' tâche' + (n > 1 ? 's' : '') + '.'));
        b.appendChild(el('p', 'muted small', 'L\'état actuel du téléphone sera remplacé.'));
      }, function () { return true; }).then(function (ok) {
        if (!ok) { msg.textContent = ''; return; }
        S = r.state;
        save(); renderSettings(); renderAll();
        msg.textContent = 'Restauré depuis la sauvegarde du ' + r.date + '.';
        toast('Sauvegarde restaurée');
      });
    }, function (e) { msg.textContent = 'Échec : ' + e.message; });
  }

  function exportData() {
    var blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mes-taches-' + M.fmtIso(M.today()) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function importData(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var j = JSON.parse(r.result);
        if (!j || !Array.isArray(j.tasks)) throw new Error('format inattendu');
        S = j;
        save(); renderSettings(); renderAll();
        toast('Import réussi : ' + j.tasks.length + ' tâches');
      } catch (e) { toast('Fichier illisible : ' + e.message); }
    };
    r.readAsText(file);
  }

  /* ================================================================== */
  /* Réglages                                                           */
  /* ================================================================== */

  function setHaDot(state) {
    var d = $('haDot');
    d.className = 'ha-dot ' + (state || '');
    d.title = state === 'ok' ? 'Home Assistant : connecté'
            : state === 'err' ? 'Home Assistant : erreur'
            : 'Home Assistant : non configuré';
  }

  function renderSettings() {
    var s = S.settings;
    $('setNotif').checked = !!s.notif;
    $('setNotifHour').value = s.notifHour;
    $('setNotifLate').checked = !!s.notifLate;
    $('haUrl').value = HA.cfg().url || '';
    $('haToken').value = HA.cfg().token || '';
    $('haAuto').checked = !!s.haAuto;
    $('setBackup').checked = !!s.backup;
    $('backupMsg').textContent = S.lastBackup
      ? 'Dernière sauvegarde : ' + fmtDate(S.lastBackup) + '.'
      : 'Aucune sauvegarde encore envoyée.';
    $('aboutVer').textContent = 'Version ' + APP_VERSION + ' · ' + S.tasks.length + ' tâches enregistrées';
    $('verChip').textContent = 'v' + APP_VERSION;
    renderTemplates();
  }

  function bind() {
    [].forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.onclick = function () { showTab(b.dataset.tab); };
    });

    $('fab').onclick = function () { editTask(null); };

    $('search').oninput = renderAllTab;
    $('filterCat').onchange = renderAllTab;
    $('filterState').onchange = renderAllTab;

    var fc = $('filterCat');
    M.CATEGORIES.forEach(function (c) {
      var o = el('option', null, esc(c.icon + ' ' + c.label));
      o.value = c.id;
      fc.appendChild(o);
    });

    $('setNotif').onchange = function () {
      S.settings.notif = this.checked;
      save();
      if (this.checked) askNotifPermission().then(function (ok) {
        if (!ok) toast('Notifications refusées par le système');
        else scheduleReminders();
      });
    };
    $('setNotifHour').onchange = function () { S.settings.notifHour = this.value; save(); scheduleReminders(); };
    $('setNotifLate').onchange = function () { S.settings.notifLate = this.checked; save(); };
    $('btnTestNotif').onclick = testNotif;

    $('haUrl').onchange = function () { HA.saveCfg(this.value, $('haToken').value); };
    $('haToken').onchange = function () { HA.saveCfg($('haUrl').value, this.value); };
    $('haAuto').onchange = function () { S.settings.haAuto = this.checked; save(); };
    $('haTest').onclick = function () {
      HA.saveCfg($('haUrl').value, $('haToken').value);
      $('haMsg').textContent = 'Connexion…';
      HA.ping().then(function (m) {
        $('haMsg').textContent = 'Connecté : ' + m;
        setHaDot('ok');
      }, function (e) {
        $('haMsg').textContent = 'Échec : ' + e.message;
        setHaDot('err');
      });
    };
    $('haPush').onclick = function () {
      $('haMsg').textContent = 'Publication…';
      HA.publish(S.tasks).then(function (r) {
        $('haMsg').textContent = r.ok ? r.sent + ' capteurs publiés.' : 'Échec : ' + r.errors.join(', ');
        setHaDot(r.ok ? 'ok' : 'err');
      }, function (e) { $('haMsg').textContent = 'Échec : ' + e.message; });
    };

    $('setBackup').onchange = function () { S.settings.backup = this.checked; save(); };
    $('btnBackupNow').onclick = backupNow;
    $('btnRestore').onclick = restoreFromHa;
    $('btnExport').onclick = exportData;
    $('fileImport').onchange = function () { if (this.files[0]) importData(this.files[0]); };
    $('btnWipe').onclick = function () {
      modal('Tout effacer ?', function (b) {
        b.appendChild(el('p', null, 'Toutes les tâches seront supprimées du téléphone.'));
        b.appendChild(el('p', 'muted small', 'La sauvegarde déjà envoyée dans Home Assistant, elle, restera.'));
      }, function () { return true; }).then(function (ok) {
        if (!ok) return;
        localStorage.removeItem(KEY);
        S = load();
        save(); renderSettings(); renderAll();
        toast('Données effacées');
      });
    };
  }

  function showTab(id) {
    [].forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.dataset.tab === id);
    });
    [].forEach.call(document.querySelectorAll('.tab-panel'), function (p) {
      p.classList.toggle('active', p.id === 'tab-' + id);
    });
    $('fab').classList.toggle('hidden', id === 'set');
    window.scrollTo(0, 0);
  }

  /* ================================================================== */
  /* Démarrage                                                          */
  /* ================================================================== */

  function init() {
    bind();
    renderSettings();
    renderAll();
    showTab('today');
    setHaDot(HA.enabled() ? '' : null);

    if (HA.enabled()) {
      HA.ping().then(function () { setHaDot('ok'); }, function () { setHaDot('err'); });

      /* Un état posé par l'API REST ne survit pas à un redémarrage de HA :
         on repousse à chaque ouverture pour que l'entité se recrée. */
      if (S.settings.backup && S.tasks.length) {
        HA.backup(S).then(function () {
          S.lastBackup = new Date().toISOString();
          localStorage.setItem(KEY, JSON.stringify(S));
        }, function () {});
      }
      if (S.settings.haAuto) HA.publish(S.tasks).catch(function () {});

      /* App vide alors qu'une sauvegarde existe : réinstallation. */
      if (!S.tasks.length) {
        HA.restore().then(function (r) {
          if (!(r.state.tasks || []).length) return;
          showTab('set');
          restoreFromHa();
        }, function () {});
      }
    }

    if (S.settings.notif) scheduleReminders();

    ensureTimerChannels();
    /* Les notifications sont déjà programmées côté OS, mais on les
       reprogramme ici pour couvrir le cas d'une restauration/import
       ramenant une minuterie en cours sur un appareil où les canaux
       viennent d'être créés. */
    TIMERS.forEach(function (def) {
      var t = S.timers[def.id];
      if (t && t.end && new Date(t.end) > new Date()) scheduleTimerAlarm(def, new Date(t.end));
    });
    setInterval(function () {
      if (TIMERS.some(function (def) { return S.timers[def.id]; })) renderTimers();
    }, 30000);

    /* Au retour dans l'app, un jour a pu passer : les échéances bougent. */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') renderAll();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
