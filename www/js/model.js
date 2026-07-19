/*
 * model.js — modèle des tâches.
 *
 * Une seule structure porte les quatre usages demandés, plutôt que quatre
 * types étanches qui obligeraient à choisir avant de savoir :
 *   - une tâche simple : un titre, c'est tout ;
 *   - une tâche datée : + une échéance ;
 *   - une tâche récurrente : + une répétition, qui recalcule l'échéance à
 *     chaque fois qu'on la coche ;
 *   - un projet : + des étapes, dont l'avancement remonte sur la tâche.
 * On peut donc commencer par « refaire le portail » et lui ajouter des
 * étapes trois jours plus tard sans rien convertir.
 */
(function (global) {
  'use strict';

  var CATEGORIES = [
    { id: 'maison',   label: 'Maison',        icon: '🏠' },
    { id: 'exterieur',label: 'Extérieur',     icon: '🌳' },
    { id: 'piscine',  label: 'Piscine',       icon: '🏊' },
    { id: 'vehicule', label: 'Véhicules',     icon: '🚗' },
    { id: 'admin',    label: 'Administratif', icon: '📄' },
    { id: 'courses',  label: 'Courses',       icon: '🛒' },
    { id: 'perso',    label: 'Perso',         icon: '⭐' },
  ];

  var PRIORITIES = [
    { id: 3, label: 'Basse',   cls: 'p3' },
    { id: 2, label: 'Normale', cls: 'p2' },
    { id: 1, label: 'Haute',   cls: 'p1' },
  ];

  var UNITS = [
    { id: 'd', label: 'jour(s)',  days: 1 },
    { id: 'w', label: 'semaine(s)', days: 7 },
    { id: 'm', label: 'mois',     days: null },
    { id: 'y', label: 'an(s)',    days: null },
  ];

  function category(id) {
    return CATEGORIES.filter(function (c) { return c.id === id; })[0] || CATEGORIES[0];
  }

  /* ------------------------------------------------------------------ */
  /* Dates : on raisonne en jours pleins, jamais en millisecondes         */
  /* ------------------------------------------------------------------ */

  function today() {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function parseDate(iso) {
    if (!iso) return null;
    var p = String(iso).slice(0, 10).split('-');
    if (p.length !== 3) return null;
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function fmtIso(d) {
    if (!d) return null;
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* Écart en jours pleins : négatif = en retard. */
  function daysUntil(iso) {
    var d = parseDate(iso);
    if (!d) return null;
    return Math.round((d - today()) / 86400000);
  }

  /* Ajout d'une période. Les mois et les années passent par le calendrier
     et pas par une moyenne de jours : « tous les 3 mois » à partir du 31
     janvier doit tomber le 30 avril, pas le 1er mai. */
  function addPeriod(d, every, unit) {
    var n = new Date(d.getTime());
    if (unit === 'd') n.setDate(n.getDate() + every);
    else if (unit === 'w') n.setDate(n.getDate() + every * 7);
    else if (unit === 'y') n.setFullYear(n.getFullYear() + every);
    else {
      var day = n.getDate();
      n.setDate(1);
      n.setMonth(n.getMonth() + every);
      /* Fin de mois plus courte : on se cale sur le dernier jour. */
      var last = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
      n.setDate(Math.min(day, last));
    }
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* Tâches                                                             */
  /* ------------------------------------------------------------------ */

  function blank() {
    return {
      id: null, title: '', note: '', category: 'maison', priority: 2,
      due: null, repeat: null, steps: [], done: false, doneAt: null,
      history: [], created: new Date().toISOString(),
    };
  }

  function isProject(t) { return !!(t.steps && t.steps.length); }
  function isRecurring(t) { return !!(t.repeat && t.repeat.every > 0); }

  /* Avancement d'un projet, en pourcentage. */
  function progress(t) {
    if (!isProject(t)) return t.done ? 100 : 0;
    var d = t.steps.filter(function (s) { return s.done; }).length;
    return Math.round(d / t.steps.length * 100);
  }

  /*
   * État d'échéance. Une tâche récurrente déjà cochée n'est pas « faite » :
   * elle est simplement en attente de sa prochaine occurrence, ce qui n'est
   * pas la même chose et ne doit pas la faire disparaître de la liste.
   */
  function status(t) {
    if (t.done && !isRecurring(t)) return { id: 'done', label: 'Terminée' };
    var n = daysUntil(t.due);
    if (n == null) return { id: 'someday', label: 'Sans date' };
    if (n < 0) return { id: 'late', label: n === -1 ? 'En retard d\'un jour'
                                                    : 'En retard de ' + (-n) + ' jours', days: n };
    if (n === 0) return { id: 'today', label: 'Aujourd\'hui', days: 0 };
    if (n === 1) return { id: 'soon', label: 'Demain', days: 1 };
    if (n <= 7) return { id: 'soon', label: 'Dans ' + n + ' jours', days: n };
    return { id: 'later', label: 'Dans ' + n + ' jours', days: n };
  }

  /*
   * Cocher une tâche. Récurrente, elle repart sur sa prochaine échéance —
   * calculée depuis la date prévue et non depuis aujourd'hui, sinon une
   * tâche mensuelle cochée avec trois jours de retard dérive de trois jours
   * à chaque fois et finit par changer de saison.
   * Sauf si le retard dépasse une période entière : là on repart de zéro,
   * c'est plus proche de l'intention que d'empiler les occurrences ratées.
   */
  function complete(t, when) {
    var now = when || new Date();
    t.history = t.history || [];
    t.history.push({ date: now.toISOString(), due: t.due });
    if (t.history.length > 200) t.history = t.history.slice(-200);

    if (!isRecurring(t)) {
      t.done = true;
      t.doneAt = now.toISOString();
      return t;
    }
    var base = parseDate(t.due) || today();
    var next = addPeriod(base, t.repeat.every, t.repeat.unit);
    var limit = today();
    if (next < limit) next = addPeriod(limit, t.repeat.every, t.repeat.unit);
    t.due = fmtIso(next);
    t.done = false;
    t.doneAt = now.toISOString();
    (t.steps || []).forEach(function (s) { s.done = false; });
    return t;
  }

  function uncomplete(t) {
    t.done = false;
    t.doneAt = null;
    return t;
  }

  /*
   * Tri d'affichage : ce qui est en retard d'abord, puis par échéance, puis
   * par priorité. Une tâche sans date ne remonte jamais devant une tâche
   * datée — sinon la liste du jour se remplit de « un jour peut-être ».
   */
  function compare(a, b) {
    var sa = status(a), sb = status(b);
    var rank = { late: 0, today: 1, soon: 2, later: 3, someday: 4, done: 5 };
    if (rank[sa.id] !== rank[sb.id]) return rank[sa.id] - rank[sb.id];
    if (sa.days != null && sb.days != null && sa.days !== sb.days) return sa.days - sb.days;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a.title || '').localeCompare(b.title || '');
  }

  /* Tâches à traiter aujourd'hui : en retard, dues ce jour, et les projets
     entamés qu'on ne veut pas laisser dormir. */
  function forToday(tasks) {
    return tasks.filter(function (t) {
      if (t.done && !isRecurring(t)) return false;
      var s = status(t);
      return s.id === 'late' || s.id === 'today';
    }).sort(compare);
  }

  function late(tasks) {
    return tasks.filter(function (t) {
      return !(t.done && !isRecurring(t)) && status(t).id === 'late';
    }).sort(compare);
  }

  /* Résumé texte pour Home Assistant et les notifications. */
  function summary(tasks) {
    var l = late(tasks).length, d = forToday(tasks).length;
    if (!d) return 'Rien à faire aujourd\'hui';
    if (!l) return d + ' tâche' + (d > 1 ? 's' : '') + ' aujourd\'hui';
    return d + ' tâche' + (d > 1 ? 's' : '') + ' dont ' + l + ' en retard';
  }

  global.Model = {
    CATEGORIES: CATEGORIES, PRIORITIES: PRIORITIES, UNITS: UNITS,
    category: category, blank: blank,
    today: today, parseDate: parseDate, fmtIso: fmtIso,
    daysUntil: daysUntil, addPeriod: addPeriod,
    isProject: isProject, isRecurring: isRecurring, progress: progress,
    status: status, complete: complete, uncomplete: uncomplete,
    compare: compare, forToday: forToday, late: late, summary: summary,
  };
})(window);
