// Month calendar of a roster in station local time (SLT), shared by calendar.html
// and upload.html. All arithmetic stays on each station's local wall clock, so no
// time-zone table is needed: report = departure minus a buffer at the departure
// station, debrief = arrival plus a buffer at the arrival station, and ground time
// between sectors is measured at the station where both happen.
(function () {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  // Same estimates as the briefing page, used only when the roster has no report/debrief times.
  const REPORT_MIN_BASE = 75, REPORT_MIN_AWAY = 60, DEBRIEF_MIN = 45;
  const SAME_DUTY_GROUND_MIN = 6 * 60;
  // A layover is also shown on the departure day when the report is this late.
  const LATE_REPORT_HOUR = 18;
  const RANK = { off: 1, sby: 2, work: 3 };

  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Wall-clock minutes since the epoch, treating a local date/time as if it were UTC.
  const toMin = (date, time) => Date.parse(`${date}T${time}:00Z`) / 60000;
  const fromMin = min => { const iso = new Date(min * 60000).toISOString(); return { date: iso.slice(0, 10), time: iso.slice(11, 16) }; };
  const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const dayDiff = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const plus = (date, ref) => { const n = dayDiff(ref, date); return n > 0 ? ` (+${n})` : ''; };
  const flightLabel = f => String(f).replace(/^([A-Z]{2})\s?(\d+)$/, '$1 $2');
  // "YYYY-MM-DD HH:MM" -> {date, time}
  const parseStamp = s => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(String(s || '').trim()); return m ? { date: m[1], time: m[2] } : null; };

  function monthKeyOf(label) {
    const m = /^([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/.exec(String(label || '').trim());
    if (!m) return null;
    const idx = MONTHS.indexOf(m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase());
    return idx < 0 ? null : `${m[2]}-${pad(idx + 1)}`;
  }

  // Months to show: the roster's own months, else the months its legs depart in.
  function monthKeys(roster) {
    const keys = new Set((roster.months || [roster.month]).map(monthKeyOf).filter(Boolean));
    if (!keys.size) (roster.legs || []).forEach(l => l.dep_date && keys.add(l.dep_date.slice(0, 7)));
    return [...keys].sort();
  }

  function buildDuties(roster) {
    const base = (roster.pilot && roster.pilot.base) || 'KUL';
    const legs = (roster.legs || []).filter(l => l.dep_date && l.dep_time && l.arr_date && l.arr_time)
      .sort((a, b) => toMin(a.dep_date, a.dep_time) - toMin(b.dep_date, b.dep_time));
    const duties = [];
    for (const leg of legs) {
      const cur = duties[duties.length - 1];
      const prev = cur && cur.legs[cur.legs.length - 1];
      const sameDuty = prev && prev.arr_airport === leg.dep_airport &&
        toMin(leg.dep_date, leg.dep_time) - toMin(prev.arr_date, prev.arr_time) <= SAME_DUTY_GROUND_MIN;
      if (sameDuty) cur.legs.push(leg); else duties.push({ legs: [leg] });
    }
    let estimated = false;
    for (const d of duties) {
      const first = d.legs[0], last = d.legs[d.legs.length - 1];
      d.report = parseStamp(first.duty_report);
      d.debrief = parseStamp(last.duty_debrief);
      if (!d.report) {
        estimated = true;
        d.report = fromMin(toMin(first.dep_date, first.dep_time) - (first.dep_airport === base ? REPORT_MIN_BASE : REPORT_MIN_AWAY));
      }
      if (!d.debrief) {
        estimated = true;
        d.debrief = fromMin(toMin(last.arr_date, last.arr_time) + DEBRIEF_MIN);
      }
    }
    return { duties, base, estimated };
  }

  // date -> {kind, lines[], spans[[start,end]]}; spans let out-of-month cells show
  // only entries belonging to something that reaches into the displayed month.
  function buildDays(roster) {
    const { duties, base, estimated } = buildDuties(roster);
    const days = {};
    const add = (date, kind, line, span) => {
      const e = days[date] || (days[date] = { kind: null, lines: [], spans: [] });
      e.lines.push(line);
      e.spans.push(span);
      if (!e.kind || RANK[kind] > RANK[e.kind]) e.kind = kind;
    };
    duties.forEach((d, i) => {
      const R = d.report.date, last = d.legs[d.legs.length - 1];
      const span = [R, d.debrief.date];
      add(R, 'work', `REPORT : ${d.report.time}`, span);
      for (const l of d.legs) {
        add(R, 'work', `${flightLabel(l.flight)} ${l.dep_airport} ${l.dep_time}${plus(l.dep_date, R)} - ${l.arr_airport} ${l.arr_time}${plus(l.arr_date, R)}`, span);
        if (l.work_type && l.work_type !== 'OP') add(R, 'work', `(${l.work_type})`, span);
      }
      add(R, 'work', `DEBRIEF : ${d.debrief.time}${plus(d.debrief.date, R)}`, span);
      // Arrival and debrief again on the day(s) they actually happen.
      for (let day = addDays(R, 1); day <= d.debrief.date; day = addDays(day, 1)) {
        if (last.arr_date === day) add(day, 'work', `↳ ${flightLabel(last.flight)} ARR ${last.arr_airport} ${last.arr_time}`, span);
        if (d.debrief.date === day) add(day, 'work', `DEBRIEF : ${d.debrief.time}`, span);
      }
      // Layover at an outstation until the next duty departs from it.
      const next = duties[i + 1];
      if (last.arr_airport !== base && next && next.legs[0].dep_airport === last.arr_airport) {
        const stop = `LO ${last.arr_airport}`, lspan = [d.debrief.date, next.report.date];
        if (d.debrief.date < next.report.date) add(d.debrief.date, 'work', stop, lspan);
        for (let day = addDays(d.debrief.date, 1); day < next.report.date; day = addDays(day, 1)) add(day, 'work', stop, lspan);
        if (next.report.date > d.debrief.date && Number(next.report.time.slice(0, 2)) >= LATE_REPORT_HOUR) add(next.report.date, 'work', stop, lspan);
      }
    });
    const codes = roster.days_off_codes || {};
    for (const date of roster.days_off || []) add(date, 'off', codes[date] || 'D', [date, date]);
    for (const sb of roster.standby || []) {
      for (const date of sb.dates || []) add(date, 'sby', `${sb.code} ${sb.location || ''} ${sb.report || ''} - ${sb.release || ''}`.replace(/\s+/g, ' ').trim(), [date, date]);
    }
    return { days, estimated };
  }

  // opts.exportMode: larger type for the PNG export (see .rc-export in calendar.css).
  function render(roster, monthKey, opts = {}) {
    const { days, estimated } = buildDays(roster);
    const [y, m] = monthKey.split('-').map(Number);
    const first = `${monthKey}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;   // Monday-first
    const start = addDays(first, -lead);
    const weeks = Math.ceil((lead + dayDiff(first, lastDay) + 1) / 7);
    const cells = [];
    for (let i = 0; i < weeks * 7; i++) {
      const date = addDays(start, i);
      const before = date < first, after = date > lastDay, inMonth = !before && !after;
      const e = days[date];
      // Lead-in and trailing days show the neighbouring months' rosters (muted), so the
      // switch-over is visible; a duty that crosses into or out of this month stays full colour.
      const lines = e ? e.lines : [];
      const carries = e && ((before && e.spans.some(s => s[1] >= first)) || (after && e.spans.some(s => s[0] <= lastDay)));
      const label = `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(8)}`;
      const kind = lines.length ? e.kind : (inMonth ? 'none' : '');
      cells.push(`<div class="rc-cell${before ? ' rc-before' : ''}${after ? ' rc-after' : ''}${carries ? ' rc-carry' : ''}">` +
        `<div class="rc-date">${label}</div>` +
        `<div class="rc-lines">${lines.map(l => `<div>${esc(l)}</div>`).join('')}</div>` +
        (kind ? `<div class="rc-bar rc-${kind}"></div>` : '') + '</div>');
    }
    const p = roster.pilot || {};
    const who = [p.name, p.staff_number, [p.fleet, p.rank].filter(Boolean).join(' '), p.base].filter(Boolean).map(esc).join(' | ');
    const totals = (roster.totals && (roster.totals[monthKey] || (roster.totals.flight_hours ? roster.totals : null))) || null;
    const left = totals ? `FLIGHT HRS ${esc(totals.flight_hours || '—')} &nbsp;|&nbsp; DUTY HRS ${esc(totals.duty_hours || '—')}` : '';
    const right = 'ALL TIMINGS ARE IN SLT (STATION LOCAL TIME). (+1) = NEXT DAY.' +
      (estimated ? ' REPORT/DEBRIEF NOT PRINTED ON THE ROSTER ARE ESTIMATED (−75 MIN KUL, −60 MIN AWAY, +45 MIN).' : '');
    return `<div class="rc${opts.exportMode ? ' rc-export' : ''}">` +
      `<div class="rc-top"><h2 class="rc-title">${MONTH_NAMES[m - 1]} ${y}</h2><div class="rc-who">${who}</div></div>` +
      `<div class="rc-legend"><span><i class="rc-sw rc-work"></i>Working</span><span><i class="rc-sw rc-off"></i>Day off</span><span><i class="rc-sw rc-sby"></i>Standby</span><span><i class="rc-sw rc-none"></i>No entry on roster</span></div>` +
      `<div class="rc-grid">${WEEKDAYS.map(d => `<div class="rc-dow">${d}</div>`).join('')}${cells.join('')}</div>` +
      `<div class="rc-foot"><div>${left}</div><div>${right}</div></div></div>`;
  }

  window.RosterCalendar = { render, monthKeys, monthKeyOf };
})();
